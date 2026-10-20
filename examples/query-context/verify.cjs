const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const from = (name) => require(require.resolve(name, { paths: [root] }));
const { prepareCompiler, PostgresQuery } = from(
  '@cubejs-backend/schema-compiler'
);
const { Client } = from('pg');
const model = fs.readFileSync(path.join(__dirname, 'model.yml'), 'utf8');
assert.ok(
  process.env.NEUTRAL_DB_HOST,
  'Set NEUTRAL_DB_HOST to an owned synthetic database'
);
const filter = (member, values) => ({ member, operator: 'equals', values });

async function compile(source) {
  const c = prepareCompiler(
    {
      localPath: () => __dirname,
      dataSchemaFiles: async () => [
        { fileName: 'ledger.yml', content: source },
      ],
    },
    { adapter: 'postgres' }
  );
  await c.compiler.compile();
  return c;
}
async function main() {
  const db = new Client({
    host: process.env.NEUTRAL_DB_HOST,
    port: 5432,
    user: 'postgres',
    password: 'synthetic',
    database: 'model_test',
  });
  await db.connect();
  const c = await compile(model);
  const checks = [];
  async function execute(options, compiler = c) {
    const q = new PostgresQuery(compiler, {
      useNativeSqlPlanner: true,
      timezone: 'UTC',
      measures: ['Ledger.amount'],
      dimensions: ['Ledger.root'],
      ...options,
    });
    const [sql, params] = q.buildSqlAndParams();
    const response = await db.query(sql, params);
    return { rows: response.rows, sql, params };
  }
  async function check(name, options, expected, member = 'ledger__amount') {
    const result = await execute(options);
    assert.deepEqual(
      result.rows.map((row) =>
        row[member] == null ? null : Number(row[member])
      ),
      expected,
      name + ': ' + JSON.stringify(result.rows)
    );
    checks.push({
      name,
      rows: result.rows,
      sql: result.sql,
      params: result.params,
    });
  }
  try {
    await check('root', {}, [11]);
    await check(
      'section B',
      {
        dimensions: ['Ledger.section'],
        filters: [filter('Ledger.section', ['B'])],
      },
      [4]
    );
    await check(
      'leaf A2',
      {
        dimensions: ['Ledger.account'],
        filters: [filter('Ledger.account', ['A2'])],
      },
      [3]
    );
    await check(
      'root plus deeper A',
      { filters: [filter('Ledger.section', ['A'])] },
      [7]
    );
    await check(
      'root plus deeper A2 sign',
      { filters: [filter('Ledger.account', ['A2'])] },
      [-3]
    );
    await check(
      'explicit depth wins',
      {
        filters: [
          filter('Ledger.account', ['A2']),
          filter('Ledger.depth', ['2']),
        ],
      },
      [3]
    );
    await check(
      'nested explicit depth zero',
      {
        filters: [
          {
            and: [
              filter('Ledger.account', ['A2']),
              {
                or: [
                  filter('Ledger.depth', ['0']),
                  filter('Ledger.depth', ['0']),
                ],
              },
            ],
          },
        ],
      },
      [-3]
    );
    await check('blank card', { dimensions: [] }, [null]);
    await check(
      'explicit card',
      {
        dimensions: [],
        filters: [
          filter('Ledger.account', ['A2']),
          filter('Ledger.depth', ['0']),
        ],
      },
      [-3]
    );
    await check(
      'view aliases',
      {
        measures: ['LedgerView.amount'],
        dimensions: ['LedgerView.item'],
        filters: [filter('LedgerView.item', ['A2'])],
      },
      [3],
      'ledger_view__amount'
    );
    await check(
      'inner stage does not choose leaf depth',
      {
        measures: ['Ledger.grain_changed'],
        filters: [filter('Ledger.account', ['A2'])],
      },
      [-3],
      'ledger__grain_changed'
    );
    await check(
      'detail-only total blank',
      { measures: ['Ledger.detail_only'] },
      [null],
      'ledger__detail_only'
    );
    await check(
      'detail-only leaf',
      {
        measures: ['Ledger.detail_only'],
        dimensions: ['Ledger.account'],
        filters: [filter('Ledger.account', ['A2'])],
      },
      [0.03],
      'ledger__detail_only'
    );
    await check(
      'pinned helper alongside context measure',
      { measures: ['Ledger.amount', 'Ledger.amount2'] },
      [17],
      'ledger__amount2'
    );
    await check(
      'masked context output remains blank',
      { maskedMembers: [{ member: 'Ledger.amount' }] },
      [null]
    );
    await check(
      'tenant restriction retained',
      { filters: [filter('Ledger.tenant', ['red'])] },
      [7]
    );
    await check(
      'selection and explicit measure presence',
      {
        measures: ['Ledger.amount', 'Ledger.comparison'],
        filters: [filter('Ledger.tenant', ['red'])],
      },
      [6],
      'ledger__comparison'
    );
    await check(
      'dependency does not imply selected measure',
      {
        measures: ['Ledger.comparison'],
        filters: [filter('Ledger.tenant', ['red'])],
      },
      [7],
      'ledger__comparison'
    );
    await check(
      'nested compound expression',
      {
        measures: ['Ledger.amount', 'Ledger.nested'],
        filters: [filter('Ledger.tenant', ['red'])],
      },
      [12],
      'ledger__nested'
    );
    const predicates = [
      [{ grouped: 'Ledger.root' }, [], true],
      [{ grouped: 'Ledger.account' }, [], false],
      [
        {
          deepest_grouped: ['Ledger.root', 'Ledger.section', 'Ledger.account'],
          equals: 0,
        },
        [filter('Ledger.account', ['A2'])],
        true,
      ],
      [
        { single_value: 'Ledger.tenant', equals: 'red' },
        [filter('Ledger.tenant', ['red'])],
        true,
      ],
      [
        { single_value: 'Ledger.tenant', equals: 'red' },
        [
          {
            or: [
              filter('Ledger.tenant', ['red']),
              filter('Ledger.tenant', ['blue']),
            ],
          },
        ],
        false,
      ],
      [
        { single_value: 'Ledger.tenant', equals: 'red' },
        [
          {
            or: [
              filter('Ledger.tenant', ['red']),
              filter('Ledger.section', ['A']),
            ],
          },
        ],
        false,
      ],
      [{ not: { single_value: 'Ledger.tenant', equals: 'red' } }, [], false],
      [
        {
          any: [
            { grouped: 'Ledger.root' },
            { single_value: 'Ledger.tenant', equals: 'red' },
          ],
        },
        [],
        true,
      ],
      [
        {
          all: [
            { grouped: 'Ledger.root' },
            { single_value: 'Ledger.tenant', equals: 'red' },
          ],
        },
        [],
        false,
      ],
      [{ filtered: 'Ledger.day' }, [], false],
      [{ filtered: 'Ledger.tenant' }, [], false],
      [
        { filtered: 'Ledger.tenant' },
        [filter('Ledger.tenant', ['red', 'blue'])],
        true,
      ],
      [
        { grouped: { member: 'Ledger.day', granularity: 'month' } },
        [],
        true,
        { timeDimensions: [{ dimension: 'Ledger.day', granularity: 'month' }] },
      ],
      [
        { grouped: { member: 'Ledger.day', granularity: 'year' } },
        [],
        false,
        { timeDimensions: [{ dimension: 'Ledger.day', granularity: 'month' }] },
      ],
      [
        { grouped: 'Ledger.day' },
        [],
        false,
        {
          timeDimensions: [
            {
              dimension: 'Ledger.day',
              dateRange: ['2025-01-01', '2025-01-31'],
            },
          ],
        },
      ],
      [
        { filtered: 'Ledger.day' },
        [],
        true,
        {
          timeDimensions: [
            {
              dimension: 'Ledger.day',
              dateRange: ['2025-01-01', '2025-01-31'],
            },
          ],
        },
      ],
      [
        { deepest_grouped: ['Ledger.root', 'Ledger.section'], equals: -1 },
        [],
        true,
        { dimensions: [] },
      ],
    ];
    for (const [
      i,
      [context, filters, expected, options = {}],
    ] of predicates.entries()) {
      const yaml = from('yaml');
      const tree = yaml.parse(model);
      tree.cubes[0].measures.push({
        name: 'probe',
        multi_stage: true,
        type: 'number',
        case: {
          when: [{ context, sql: '{amount0} * 0 + 101' }],
          else: { sql: '{amount0} * 0 + 202' },
        },
      });
      const compiler = await compile(yaml.stringify(tree));
      const result = await execute(
        { measures: ['Ledger.probe'], filters, ...options },
        compiler
      );
      assert.equal(
        Number(result.rows[0]['ledger__probe']),
        expected ? 101 : 202,
        'predicate ' + i
      );
      checks.push({
        name: 'predicate ' + i,
        context,
        expected,
        rows: result.rows,
      });
    }
    const yaml = from('yaml');
    const guardedTree = yaml.parse(model);
    guardedTree.views[0].default_filters = [
      { member: 'LedgerView.depth', operator: 'equals', values: ['0'] },
    ];
    const guarded = await compile(yaml.stringify(guardedTree));
    const conflict = await execute(
      {
        measures: ['LedgerView.amount'],
        dimensions: ['LedgerView.item'],
        filters: [filter('LedgerView.item', ['A2'])],
      },
      guarded
    );
    assert.equal(
      conflict.rows[0]['ledger_view__amount'],
      null,
      'Shared legacy guard must not be silently removed'
    );
    checks.push({
      name: 'conflicting shared depth default remains enforced',
      rows: conflict.rows,
    });
    const oldList = await execute(
      {
        measures: [],
        dimensions: ['LedgerView.item'],
        order: [{ id: 'LedgerView.item', desc: false }],
      },
      guarded
    );
    const newList = await execute({
      measures: [],
      dimensions: ['LedgerView.item'],
      order: [{ id: 'LedgerView.item', desc: false }],
    });
    assert.deepEqual(
      oldList.rows,
      newList.rows,
      'Dimension-only offered values'
    );
    checks.push({
      name: 'dimension-only lists retain their values',
      rows: newList.rows,
    });
    console.log(JSON.stringify({ status: 'PASS', checks }, null, 2));
  } finally {
    await db.end();
  }
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
