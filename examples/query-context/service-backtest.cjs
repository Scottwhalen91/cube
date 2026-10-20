const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || path.join(__dirname, '../..'));
const from = (name) => require(require.resolve(name, { paths: [root] }));
const express = from('express');
const jwt = from('jsonwebtoken');
const Core = from('@cubejs-backend/server-core');
const Driver = from('@cubejs-backend/postgres-driver');
const { Client } = from('pg');
const yaml = from('yaml');
assert.ok(process.env.NEUTRAL_DB_HOST, 'Use only an owned synthetic database');
const db = {
  host: process.env.NEUTRAL_DB_HOST,
  port: 5432,
  user: 'postgres',
  password: 'synthetic',
  database: 'model_test',
};
const model = yaml.parse(
  fs.readFileSync(path.join(__dirname, 'model.yml'), 'utf8')
);
model.cubes[0].refresh_key = { sql: 'SELECT 1' };
if (process.env.NEUTRAL_PREAGG === 'true') {
  model.cubes[0].pre_aggregations = [0, 1, 2].map((depth) => ({
    name: `${
      process.env.NEUTRAL_BAD_ROLLUP === 'true' ? 'coarse' : 'depth'
    }${depth}`,
    external: false,
    measures: [`amount${depth}`],
    dimensions:
      process.env.NEUTRAL_BAD_ROLLUP === 'true'
        ? ['root', 'tenant']
        : ['root', 'section', 'account', 'tenant'],
    refresh_key: { sql: 'SELECT 1' },
  }));
}
if (process.env.NEUTRAL_POLICIES === 'true') {
  model.cubes[0].access_policy = [
    { group: 'all', row_level: { allow_all: true } },
    ...['red', 'blue'].map((tenant) => ({
      group: tenant,
      row_level: {
        filters: [{ member: 'tenant', operator: 'equals', values: [tenant] }],
      },
    })),
    {
      group: 'limited',
      member_level: { includes: ['root', 'amount'] },
      row_level: { allow_all: true },
    },
  ];
}
let sourceCalls = 0;
const statements = [];
const normalizedQueries = [];
class RecordingDriver extends Driver {
  async query(sql, params, options) {
    if (sql.includes('AS t(id,root')) {
      sourceCalls++;
      statements.push({ sql, params });
    }
    return super.query(sql, params, options);
  }
}
async function main() {
  process.env.CUBEJS_DB_TYPE = 'postgres';
  process.env.CUBEJS_CACHE_AND_QUEUE_DRIVER = 'memory';
  process.env.CUBEJS_DEV_MODE = 'false';
  process.env.CUBEJS_TELEMETRY = 'false';
  const app = express();
  app.use(express.json());
  const core = new Core({
    apiSecret: 'synthetic-secret',
    devServer: false,
    ...(process.env.NEUTRAL_PREAGG === 'true'
      ? {
          orchestratorOptions: {
            preAggregationsOptions: { externalRefresh: false },
          },
        }
      : {}),
    driverFactory: () => new RecordingDriver(db),
    contextToAppId: () => 'query_context_fixture',
    repositoryFactory: () => ({
      dataSchemaFiles: async () => [
        { fileName: 'ledger.yml', content: yaml.stringify(model) },
      ],
    }),
    scheduledRefreshTimer: false,
    telemetry: false,
    contextToGroups: ({ securityContext }) => [
      securityContext.restricted ? 'limited' : securityContext.tenant || 'all',
    ],
    queryRewrite: (query, { securityContext }) => {
      if (securityContext.tenant && process.env.NEUTRAL_POLICIES !== 'true')
        query.filters = [
          ...(query.filters || []),
          {
            member: query.measures?.[0]?.startsWith('LedgerView.')
              ? 'LedgerView.tenant'
              : 'Ledger.tenant',
            operator: 'equals',
            values: [securityContext.tenant],
          },
        ];
      normalizedQueries.push(JSON.parse(JSON.stringify(query)));
      return query;
    },
    contextToApiScopes: (securityContext) =>
      securityContext.denied ? ['meta'] : ['data', 'meta', 'sql', 'graphql'],
    logger: () => {},
  });
  let server;
  let sqlServer;
  let client;
  const checks = [];
  let result;
  try {
    await core.initApp(app);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(query, claims = {}) {
      const response = await fetch(base + '/cubejs-api/v1/load', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: jwt.sign(claims, 'synthetic-secret'),
        },
        body: JSON.stringify({ query }),
      });
      return { status: response.status, body: await response.json() };
    }
    const filter = (member, values) => ({ member, operator: 'equals', values });
    const cases = [
      [
        'parent sign',
        {
          measures: ['Ledger.amount'],
          dimensions: ['Ledger.root'],
          filters: [filter('Ledger.account', ['A2'])],
        },
        {},
        'Ledger.amount',
        -3,
      ],
      [
        'leaf sign',
        {
          measures: ['Ledger.amount'],
          dimensions: ['Ledger.account'],
          filters: [filter('Ledger.account', ['A2'])],
        },
        {},
        'Ledger.amount',
        3,
      ],
      [
        'blank card',
        { measures: ['Ledger.amount'] },
        {},
        'Ledger.amount',
        null,
      ],
      [
        'red role',
        { measures: ['Ledger.amount'], dimensions: ['Ledger.root'] },
        { tenant: 'red' },
        'Ledger.amount',
        7,
      ],
      [
        'blue role',
        { measures: ['Ledger.amount'], dimensions: ['Ledger.root'] },
        { tenant: 'blue' },
        'Ledger.amount',
        4,
      ],
      [
        'red role again',
        { measures: ['Ledger.amount'], dimensions: ['Ledger.root'] },
        { tenant: 'red' },
        'Ledger.amount',
        7,
      ],
      [
        'view alias',
        {
          measures: ['LedgerView.amount'],
          dimensions: ['LedgerView.item'],
          filters: [filter('LedgerView.item', ['A2'])],
        },
        {},
        'LedgerView.amount',
        3,
      ],
      [
        'comparison alone after prior contexts',
        {
          measures: ['Ledger.comparison'],
          dimensions: ['Ledger.root'],
          filters: [filter('Ledger.tenant', ['red'])],
        },
        {},
        'Ledger.comparison',
        7,
      ],
      [
        'nested selection expression',
        {
          measures: ['Ledger.amount', 'Ledger.nested'],
          dimensions: ['Ledger.root'],
          filters: [filter('Ledger.tenant', ['red'])],
        },
        {},
        'Ledger.nested',
        12,
      ],
      [
        'formula selection',
        {
          measures: ['Ledger.amount', 'Ledger.comparison'],
          dimensions: ['Ledger.root'],
          filters: [filter('Ledger.tenant', ['red'])],
        },
        {},
        'Ledger.comparison',
        6,
      ],
    ];
    for (const [name, query, claims, member, expected] of cases) {
      const result = await request(query, claims);
      assert.equal(result.status, 200, JSON.stringify(result));
      if (process.env.NEUTRAL_PREAGG === 'true' && name !== 'blank card') {
        const usesRollup =
          Object.keys(result.body.usedPreAggregations || {}).length > 0;
        const coarseCannotServe =
          process.env.NEUTRAL_BAD_ROLLUP === 'true' &&
          ['parent sign', 'leaf sign', 'view alias'].includes(name);
        assert.equal(
          usesRollup,
          !coarseCannotServe,
          name + ' rollup grain/filter legality'
        );
      }
      const value = result.body.data[0]?.[member];
      assert.equal(value == null ? null : Number(value), expected, name);
      const before = sourceCalls;
      const repeat = await request(query, claims);
      assert.deepEqual(
        repeat.body.data,
        result.body.data,
        name + ' cache values'
      );
      assert.equal(sourceCalls, before, name + ' cache reuse');
      checks.push({ name, response: result, sourceCalls });
    }
    if (process.env.NEUTRAL_POLICIES === 'true') {
      const hidden = await request(
        { measures: ['Ledger.amount2'], dimensions: ['Ledger.root'] },
        { restricted: true }
      );
      assert.ok(
        hidden.status !== 200 || hidden.body.data.length === 0,
        'Direct denied helper must not return values'
      );
      const dispatched = await request(
        { measures: ['Ledger.amount'], dimensions: ['Ledger.account'] },
        { restricted: true }
      );
      assert.ok(
        dispatched.status !== 200 || dispatched.body.data.length === 0,
        'Context branch must not bypass denied dependency'
      );
      checks.push({
        name: 'denied helper direct and through context',
        direct: hidden,
        dispatched,
      });
    }
    const denied = await request(
      { measures: ['Ledger.amount'] },
      { denied: true }
    );
    assert.equal(denied.status, 403);
    checks.push({ name: 'denied data scope', status: denied.status });
    const siblings = await Promise.all(
      ['red', 'blue', 'red', 'blue'].map((tenant) =>
        request(
          { measures: ['Ledger.amount'], dimensions: ['Ledger.root'] },
          { tenant }
        )
      )
    );
    assert.deepEqual(
      siblings.map((r) => Number(r.body.data[0]['Ledger.amount'])),
      [7, 4, 7, 4]
    );
    checks.push({
      name: 'concurrent role and context separation',
      count: siblings.length,
    });
    sqlServer = core.initSQLServer();
    await sqlServer.init({
      pgSqlPort: 15432,
      sqlUser: 'synthetic',
      sqlPassword: 'synthetic',
    });
    client = new Client({
      host: '127.0.0.1',
      port: 15432,
      user: 'synthetic',
      password: 'synthetic',
      database: 'db',
    });
    await client.connect();
    for (const [name, sql, expected] of [
      [
        'SQL API parent sign',
        `SELECT root, MEASURE(amount) AS amount FROM Ledger WHERE account = 'A2' GROUP BY root`,
        -3,
      ],
      [
        'SQL API leaf sign',
        `SELECT account, MEASURE(amount) AS amount FROM Ledger WHERE account = 'A2' GROUP BY account`,
        3,
      ],
      [
        'SQL API selection context',
        `SELECT root, MEASURE(amount) AS amount, MEASURE(comparison) AS comparison FROM Ledger WHERE tenant = 'red' GROUP BY root`,
        6,
      ],
    ]) {
      const result = await client.query(sql);
      const value =
        result.rows[0][name.includes('selection') ? 'comparison' : 'amount'];
      assert.equal(
        Number(value),
        expected,
        name + ': ' + JSON.stringify(result.rows)
      );
      checks.push({ name, sql, rows: result.rows });
    }
    await assert.rejects(
      client.query(
        'SELECT root, MEASURE(amount) AS amount FROM Ledger GROUP BY ROLLUP(root)'
      ),
      /grouping set|ROLLUP|not supported/i
    );
    checks.push({ name: 'unsplit SQL API rollup rejects context planning' });
    result = {
      status: 'PASS',
      preaggregations: process.env.NEUTRAL_PREAGG === 'true',
      checks,
      statements,
      normalizedQueries,
    };
  } finally {
    await Promise.all([
      client ? client.end() : Promise.resolve(),
      sqlServer ? sqlServer.shutdown('fast') : Promise.resolve(),
    ]);
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await core.beforeShutdown();
    await core.shutdown();
  }
  return result;
}
// The native SQL test runtime retains process handles after shutdown, as in
// the repository's forceExit integration runs. Exit only after all assertions
// and explicit listener/pool/timer cleanup have completed successfully.
main().then(
  (result) => {
    if (process.env.NEUTRAL_RESULT_FILE)
      fs.writeFileSync(
        process.env.NEUTRAL_RESULT_FILE,
        JSON.stringify(result, null, 2)
      );
    else console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  },
  (error) => {
    console.error(error.stack);
    process.exit(1);
  }
);
