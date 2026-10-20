const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require(require.resolve('pg', {
  paths: [path.join(__dirname, '../..')],
}));
const fixture = require('./cases.cjs');
assert.ok(process.env.NEUTRAL_DB_HOST, 'Use only an owned synthetic database');
const db = new Client({
  host: process.env.NEUTRAL_DB_HOST,
  user: 'postgres',
  password: 'synthetic',
  database: 'model_test',
  query_timeout: 20000,
});
const queries = [];
const checks = [];
const rowsFor = (keys) =>
  keys.map((offered_key) => ({ offered_key, cell_count: 1 }));
async function run(label, sql) {
  const rows = (await db.query(sql)).rows;
  queries.push({ label, sql, rows });
  return rows;
}
async function main() {
  await db.connect();
  try {
    for (const item of fixture.cases) {
      const original = await run(
        item.name + ': original',
        fixture.original(item.cte, item.where)
      );
      const proposed = await run(
        item.name + ': full-right EXISTS',
        fixture.exists(item.cte, item.where)
      );
      const expected = rowsFor(item.keys);
      assert.deepEqual(original, expected, item.name + ' independent oracle');
      assert.deepEqual(
        proposed,
        expected,
        item.name + ' preserves key set, NULL and ordering'
      );
      checks.push({
        name: item.name,
        status: 'EQUIVALENT_FOR_KEY_AND_CONSTANT_PROJECTION',
        offeredKeys: item.keys,
      });
    }
    const emptyFactOnly = await run(
      'unsafe fact-only EXISTS',
      fixture.exists(
        fixture.source(),
        "f.tenant='red' AND f.product='P'",
        'facts f'
      )
    );
    assert.deepEqual(emptyFactOnly, []);
    assert.notDeepEqual(emptyFactOnly, rowsFor(fixture.days));
    checks.push({
      name: 'fact-only rewrite loses twelve offered dates on empty facts',
      status: 'COUNTEREXAMPLE',
    });
    const uncorrelated = await run(
      'unsafe dropped correlation',
      fixture.exists(fixture.cases[5].cte)
    );
    assert.deepEqual(uncorrelated, rowsFor(fixture.days));
    assert.notDeepEqual(uncorrelated, rowsFor(fixture.cases[5].keys));
    checks.push({
      name: 'dropped correlation expands two dates into twelve',
      status: 'COUNTEREXAMPLE',
    });
    const tenantOr = await run(
      'unsafe OR changes tenant scope',
      fixture.exists(
        fixture.cases[6].cte,
        "(a.tenant='red' AND f.product='P') OR f.flag=1"
      )
    );
    assert.deepEqual(tenantOr, rowsFor(fixture.days));
    checks.push({
      name: 'moving mandatory tenant predicate inside one OR arm changes population',
      status: 'COUNTEREXAMPLE',
    });
    const nullSafe = await run(
      'unsafe null-safe correlation',
      fixture.exists(
        fixture.cases[7].cte,
        fixture.predicate + ' AND f.event_day IS NOT DISTINCT FROM d.day'
      )
    );
    assert.deepEqual(nullSafe, rowsFor([null]));
    checks.push({
      name: 'NULL-safe equality adds a key forbidden by original equality',
      status: 'COUNTEREXAMPLE',
    });
    const counted = await run(
      'fact-sensitive counts and sum under fanout',
      fixture.original(
        fixture.source({ facts: [fixture.p, fixture.q] }),
        fixture.predicate,
        "to_char(d.day,'YYYY-MM-DD') AS offered_key, COUNT(f.id)::integer AS fact_count, COUNT(*)::integer AS row_count, SUM(f.amount)::numeric AS amount"
      )
    );
    assert.deepEqual(
      counted,
      fixture.days.map((offered_key) => ({
        offered_key,
        fact_count: 2,
        row_count: 2,
        amount: '10',
      }))
    );
    const countedExistence = await run(
      'existence removes multiplicity',
      fixture.exists(
        fixture.source({ facts: [fixture.p, fixture.q] }),
        fixture.predicate,
        fixture.right,
        "to_char(d.day,'YYYY-MM-DD') AS offered_key, COUNT(*)::integer AS row_count"
      )
    );
    assert.deepEqual(
      countedExistence,
      fixture.days.map((offered_key) => ({ offered_key, row_count: 1 }))
    );
    assert.notDeepEqual(
      counted.map((r) => r.row_count),
      countedExistence.map((r) => r.row_count)
    );
    checks.push({
      name: 'COUNT and SUM are fact-sensitive, not a constant existence projection',
      status: 'REJECT_PROJECTION_CHANGE',
    });
    const emptyAggregates = await run(
      'empty-fact count and sum semantics',
      fixture.original(
        fixture.source(),
        fixture.predicate,
        "to_char(d.day,'YYYY-MM-DD') AS offered_key, COUNT(f.id)::integer AS fact_count, COUNT(*)::integer AS row_count, SUM(f.amount)::numeric AS amount"
      )
    );
    assert.deepEqual(
      emptyAggregates,
      fixture.days.map((offered_key) => ({
        offered_key,
        fact_count: 0,
        row_count: 1,
        amount: null,
      }))
    );
    checks.push({
      name: 'empty-fact COUNT(rhs), COUNT(*) and SUM retain distinct semantics',
      status: 'REJECT_AGGREGATE_CHANGE',
    });
    const rhs = await run(
      'right-side projection cannot be dropped',
      fixture.original(
        fixture.source({
          facts: [fixture.p, [2, 'red', 1, fixture.days[0], 'Q', 0, 1]],
        }),
        "a.tenant='red'",
        "to_char(d.day,'YYYY-MM-DD') AS offered_key, f.product",
        ' GROUP BY d.day, f.product ORDER BY d.day, f.product'
      )
    );
    assert.deepEqual(
      rhs,
      fixture.days.flatMap((offered_key) =>
        ['P', 'Q'].map((product) => ({ offered_key, product }))
      )
    );
    assert.equal(rhs.length, 24);
    checks.push({
      name: 'projected right-hand values retain two tuples per offered date',
      status: 'REJECT_RHS_PROJECTION_ELIMINATION',
    });
    return {
      status: 'PASS',
      delivery: 'REPRO_AND_LEGALITY_ONLY — OPTIMIZATION_NOT_IMPLEMENTED',
      checkGroups: checks.length,
      queriesExecuted: queries.length,
      checks,
      queries,
    };
  } finally {
    await db.end();
  }
}
main().then(
  (result) => {
    if (process.env.NEUTRAL_RESULT_FILE)
      fs.writeFileSync(
        process.env.NEUTRAL_RESULT_FILE,
        JSON.stringify(result, null, 2)
      );
    else console.log(JSON.stringify(result, null, 2));
  },
  (error) => {
    console.error(error.stack);
    process.exitCode = 1;
  }
);
