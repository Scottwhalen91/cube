const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '../..');
const from = (name) => require(require.resolve(name, { paths: [root] }));
const { prepareCompiler, PostgresQuery } = from(
  '@cubejs-backend/schema-compiler'
);
const { Client } = from('pg');
const model = from('yaml').stringify(
  require('./fixture.cjs')({ dimensions: 10, measures: 1, context: true }, true)
);
assert.ok(process.env.NEUTRAL_DB_HOST, 'Use an owned synthetic database');
async function main() {
  const c = prepareCompiler(
    {
      localPath: () => __dirname,
      dataSchemaFiles: async () => [{ fileName: 'grains.yml', content: model }],
    },
    { adapter: 'postgres' }
  );
  await c.compiler.compile();
  const db = new Client({
    host: process.env.NEUTRAL_DB_HOST,
    user: 'postgres',
    password: 'synthetic',
    database: 'model_test',
  });
  await db.connect();
  const checks = [];
  async function check(name, options, expected) {
    const q = new PostgresQuery(c, {
      useNativeSqlPlanner: true,
      measures: ['Bench.amount'],
      dimensions: ['Bench.l0'],
      ...options,
    });
    const [sql, params] = q.buildSqlAndParams();
    const r = await db.query(sql, params);
    assert.deepEqual(
      r.rows.map((row) =>
        Object.fromEntries(
          Object.entries(row)
            .filter(
              ([key]) =>
                key.includes('__amount') ||
                key.includes('__padded') ||
                key.includes('__alternate') ||
                key.includes('__expanded') ||
                key.includes('__reduced') ||
                key.includes('__kept')
            )
            .map(([key, value]) => [key, value == null ? null : Number(value)])
        )
      ),
      expected,
      name
    );
    checks.push({ name, sql, params, rows: r.rows });
  }
  try {
    const expectedDepthValues = [-3, 6, -9, 12, -15, 18, -21, 24, -27, 30];
    for (let i = 0; i < 10; i++)
      await check(
        `grouping set ${i}`,
        { dimensions: Array.from({ length: i + 1 }, (_, j) => `Bench.l${j}`) },
        [{ bench__amount: expectedDepthValues[i] }]
      );
    await check(
      'deeper filter cannot set displayed depth',
      { filters: [{ member: 'Bench.l9', operator: 'equals', values: ['L9'] }] },
      [{ bench__amount: -3 }]
    );
    await check(
      'NULL padding keeps model blank',
      { measures: ['Bench.padded'], dimensions: ['Bench.l8'] },
      [{ bench__padded: null }]
    );
    await check(
      'single-child cardinality is not scope',
      { dimensions: ['Bench.l0'] },
      [{ bench__amount: -3 }]
    );
    await check(
      'two hierarchy lists are independent',
      {
        measures: ['Bench.amount', 'Bench.alternate'],
        dimensions: ['Bench.l0', 'Bench.alt1'],
      },
      [{ bench__amount: -3, bench__alternate: 6 }]
    );
    await check(
      'include keeps outer context',
      { measures: ['Bench.expanded'] },
      [{ bench__expanded: -3 }]
    );
    await check(
      'exclude keeps outer context',
      { measures: ['Bench.reduced'], dimensions: ['Bench.l9'] },
      [{ bench__reduced: 30 }]
    );
    await check(
      'keep_only keeps outer context',
      { measures: ['Bench.kept'], dimensions: ['Bench.l9'] },
      [{ bench__kept: 30 }]
    );
    await check(
      'level two grouping with level five filter',
      {
        dimensions: ['Bench.l2'],
        filters: [{ member: 'Bench.l5', operator: 'equals', values: ['L5'] }],
      },
      [{ bench__amount: -9 }]
    );
    const tree = require('./fixture.cjs')(
      { dimensions: 10, measures: 1, context: true },
      true
    );
    tree.cubes[0].measures
      .find((m) => m.name === 'amount')
      .case.when.unshift({ context: { filtered: 'Bench.depth' }, sql: '{m0}' });
    tree.cubes[0].sql = `SELECT entries.*, months.day FROM (${tree.cubes[0].sql}) entries CROSS JOIN (VALUES ('2025-01-01'::timestamp),('2025-02-01'::timestamp)) months(day)`;
    tree.cubes[0].dimensions.push({ name: 'day', sql: 'day', type: 'time' });
    tree.cubes[0].measures.push({
      name: 'fraction',
      type: 'number',
      multi_stage: true,
      sql: '{amount}/100.0',
    });
    const monthly = prepareCompiler(
      {
        localPath: () => __dirname,
        dataSchemaFiles: async () => [
          { fileName: 'months.yml', content: from('yaml').stringify(tree) },
        ],
      },
      { adapter: 'postgres' }
    );
    await monthly.compiler.compile();
    async function run(options) {
      const query = new PostgresQuery(monthly, {
        useNativeSqlPlanner: true,
        timezone: 'UTC',
        measures: ['Bench.amount', 'Bench.fraction'],
        dimensions: Array.from({ length: 10 }, (_, i) => `Bench.l${i}`),
        ...options,
      });
      const [sql, params] = query.buildSqlAndParams();
      return { sql, params, rows: (await db.query(sql, params)).rows };
    }
    const explicit = await run({
      dimensions: [],
      measures: ['Bench.amount'],
      filters: [{ member: 'Bench.depth', operator: 'equals', values: ['4'] }],
    });
    assert.equal(Number(explicit.rows[0].bench__amount), -30);
    checks.push({
      name: 'explicit depth four card retained across two months',
      ...explicit,
    });
    const combined = await run({
      timeDimensions: [{ dimension: 'Bench.day', granularity: 'month' }],
    });
    assert.equal(combined.rows.length, 2);
    for (const month of ['2025-01', '2025-02']) {
      const single = await run({
        timeDimensions: [
          {
            dimension: 'Bench.day',
            granularity: 'month',
            dateRange: [
              month + '-01',
              month === '2025-01' ? '2025-01-31' : '2025-02-28',
            ],
          },
        ],
      });
      assert.deepEqual(
        single.rows,
        combined.rows.filter((r) =>
          (r.bench__day_month instanceof Date
            ? r.bench__day_month.toISOString()
            : String(r.bench__day_month)
          ).startsWith(month)
        )
      );
      assert.equal(Number(single.rows[0].bench__amount), 30);
      assert.equal(Number(single.rows[0].bench__fraction), 0.3);
    }
    checks.push({
      name: 'ten levels by month and fractional measure equal individual month queries',
      ...combined,
    });
    const out = { status: 'PASS', checks };
    if (process.env.NEUTRAL_RESULT_FILE)
      fs.writeFileSync(
        process.env.NEUTRAL_RESULT_FILE,
        JSON.stringify(out, null, 2)
      );
    else console.log(JSON.stringify(out, null, 2));
  } finally {
    await db.end();
  }
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
