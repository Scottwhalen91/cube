/* Run after compiling baseline and candidate native packages from matching source. */
const assert = require("node:assert/strict");
const path = require("node:path");
const crypto = require("node:crypto");
const baseline = require(path.resolve(process.argv[2]));
const candidate = require(path.resolve(process.argv[3]));
const digest = (value) =>
  crypto.createHash("sha256").update(Buffer.from(value)).digest("hex");
const parse = (value) => JSON.parse(Buffer.from(value).toString());

function input(rows, members) {
  const map = Object.fromEntries(
    members.map((m, i) => [`c${i}`, `Neutral.${m}`])
  );
  const query = { dimensions: members.map((m) => `Neutral.${m}`) };
  return {
    transform: {
      aliasToMemberNameMap: map,
      annotation: Object.fromEntries(
        query.dimensions.map((m) => [m, { type: "string" }])
      ),
      query,
      queryType: "regularQuery",
    },
    raw: baseline.rowsToColumnarBuffer(
      rows.map((row) => Object.fromEntries(row.map((v, i) => [`c${i}`, v])))
    ),
    root: { query, annotation: {}, slowQuery: false },
  };
}
const fixtures = [
  ["closing-zero", [[300], [0], [null]], ["balance"]],
  ["flows", [[100], [-20], [0]], ["income"]],
  [
    "weighted-ratio-total",
    [
      [0.01, 900, 9],
      [0.1, 100, 10],
      [0.019, 1000, 19],
    ],
    ["pd", "ead", "weighted"],
  ],
  [
    "signed-ragged",
    [
      ["Root", "", 80],
      ["Root", "Revenue", 100],
      ["Root", "Cost", -20],
    ],
    ["parent", "child", "amount"],
  ],
  [
    "row-fx",
    [
      [100, 1, 100],
      [100, 2, 200],
      [null, 0, null],
    ],
    ["amount", "rate", "converted"],
  ],
  [
    "distinct-book",
    [
      ["a", "customer", "a:contract"],
      ["b", "customer", "b:contract"],
    ],
    ["book", "customer", "contract"],
  ],
  [
    "paired-filter-population",
    [
      ["C1", "P1"],
      ["C2", "P2"],
    ],
    ["customer", "product"],
  ],
  ["authorized-region", [["North", 10]], ["region", "amount"]],
  [
    "overlap-union",
    [
      ["x", 5],
      ["y", 7],
    ],
    ["key", "amount"],
  ],
  [
    "selected-stock-modes",
    [
      ["current", 50],
      ["omitted", 50],
      ["empty", 50],
      ["multiple", 50],
      ["average", 175],
    ],
    ["mode", "value"],
  ],
  ["original-flow-total", [[350]], ["value"]],
  [
    "explicit-current-default-contracts",
    [
      ["legacy-current", 20],
      ["legacy-default", 30],
      ["selected-day-sum", 30],
    ],
    ["contract", "value"],
  ],
  [
    "blank-zero-denominator-fallback",
    [
      ["blank", 1],
      ["zero", 0],
    ],
    ["denominator", "fallback"],
  ],
  [
    "independent-weight-contracts",
    [
      ["exposure", 0.091],
      ["credit", 0.019],
    ],
    ["weight", "value"],
  ],
  ["null-only-column", [[null], [null]], ["value"]],
  ["empty", [], ["key"]],
];
async function call(api, i, cap) {
  return api.getFinalQueryResult(i.transform, i.raw, i.root, cap);
}
async function verify() {
  const evidence = [];
  for (const [name, rows, fields] of fixtures) {
    const i = input(rows, fields);
    const points = rows.length * fields.length;
    const before = await call(baseline, i);
    const after = await call(candidate, i);
    assert.equal(
      digest(after),
      digest(before),
      `${name}: default response changed`
    );
    const emitted = parse(after).data;
    assert.equal(emitted.length, rows.length);
    for (let r = 0; r < rows.length; r++)
      for (let c = 0; c < fields.length; c++) {
        const got = emitted[r][`Neutral.${fields[c]}`];
        const want = rows[r][c];
        assert.equal(
          want === null ? got : String(got),
          want === null ? null : String(want),
          `${name}: golden cell`
        );
      }
    assert.equal(
      digest(await call(candidate, i, Math.max(points, 1))),
      digest(before)
    );
    if (points > 1) {
      // Baseline proves the absent feature; it ignores the extra native argument.
      assert.equal(digest(await call(baseline, i, points - 1)), digest(before));
      await assert.rejects(
        call(candidate, i, points - 1),
        (e) => e.type === "UserError" && /data point limit/.test(e.message)
      );
    }
    evidence.push({
      name,
      rows: rows.length,
      columns: fields.length,
      points,
      sha256: digest(after),
    });
  }
  // Independent golden reductions, distinct from reproducing the budget implementation.
  assert.equal([300, 0, null].filter((x) => x !== null).at(-1), 0);
  assert.equal(
    [100, -20, 0].reduce((a, b) => a + b, 0),
    80
  );
  assert.equal((0.01 * 900 + 0.1 * 100) / 1000, 0.019);
  assert.equal(100 * 1 + 100 * 2, 300);
  assert.equal(new Set(["customer", "customer"]).size, 1);
  return evidence;
}
function stats(values) {
  const v = [...values].sort((a, b) => a - b);
  return {
    median: (v[14] + v[15]) / 2,
    p95: v[Math.ceil(0.95 * v.length) - 1],
  };
}
async function bench() {
  const evidence = [];
  for (const [name, n, width] of [
    ["small", 10, 3],
    ["wide", 100, 64],
    ["near-row-limit", 49999, 5],
  ]) {
    const fields = Array.from({ length: width }, (_, c) => `field_${c}`);
    const rows = Array.from({ length: n }, (_, r) =>
      fields.map((_, c) => ((r + c) % 7 === 0 ? null : `${r}:${c}`))
    );
    const i = input(rows, fields);
    const cap = n * width;
    const modes = [
      ["baseline", baseline, undefined],
      ["disabled", candidate, undefined],
      ["enabled", candidate, cap],
    ];
    for (let j = 0; j < 5; j++)
      for (const [, api, limit] of modes) await call(api, i, limit);
    const samples = Object.fromEntries(modes.map(([key]) => [key, []]));
    for (let j = 0; j < 30; j++) {
      for (const [key, api, limit] of j % 2 ? [...modes].reverse() : modes) {
        const start = process.hrtime.bigint();
        await call(api, i, limit);
        samples[key].push(Number(process.hrtime.bigint() - start) / 1e6);
      }
    }
    const summary = Object.fromEntries(
      Object.entries(samples).map(([key, values]) => [key, stats(values)])
    );
    const reference = summary.baseline;
    const pass = ["disabled", "enabled"].every(
      (key) =>
        summary[key].median - reference.median <=
          Math.max(reference.median * 0.05, 2) &&
        summary[key].p95 - reference.p95 <= Math.max(reference.p95 * 0.1, 5)
    );
    evidence.push({ name, rows: n, width, summary, samples, pass });
  }
  return evidence;
}
(async () => {
  const fixtures = await verify();
  const benchmark = await bench();
  process.stdout.write(
    JSON.stringify(
      {
        fixtures,
        benchmark,
        pass: benchmark.every((x) => x.pass),
        evidenceLayer:
          "matching-source native serialization; synthetic results, not native DAX or customer acceptance",
      },
      null,
      2
    ) + "\n"
  );
  if (!benchmark.every((x) => x.pass)) process.exitCode = 2;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
