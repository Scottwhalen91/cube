const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || path.join(__dirname, '../..'));
const from = (name) => require(require.resolve(name, { paths: [root] }));
const express = from('express');
const jwt = from('jsonwebtoken');
const Core = from('@cubejs-backend/server-core');
const Driver = from('@cubejs-backend/postgres-driver');
assert.ok(
  process.env.NEUTRAL_DB_HOST,
  'Only an owned synthetic database is permitted'
);
const db = {
  host: process.env.NEUTRAL_DB_HOST,
  port: 5432,
  user: 'postgres',
  password: 'synthetic',
  database: 'model_test',
};
const content = fs.readFileSync(
  path.join(__dirname, 'control-model.js'),
  'utf8'
);
const statements = [];
class RecordingDriver extends Driver {
  async query(sql, params, options) {
    if (sql.includes('VALUES')) statements.push({ sql, params });
    return super.query(sql, params, options);
  }
}
const normalized = (value) =>
  Array.isArray(value)
    ? value.map(normalized)
    : value && typeof value === 'object'
    ? Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== 'lastRefreshTime')
          .map(([key, v]) => [key, normalized(v)])
      )
    : value;
async function main() {
  Object.assign(process.env, {
    CUBEJS_DB_TYPE: 'postgres',
    CUBEJS_CACHE_AND_QUEUE_DRIVER: 'memory',
    CUBEJS_DEV_MODE: 'false',
    CUBEJS_TELEMETRY: 'false',
  });
  const app = express();
  app.use(express.json());
  const core = new Core({
    apiSecret: 'synthetic-secret',
    devServer: false,
    driverFactory: () => new RecordingDriver(db),
    contextToAppId: () => 'context_compatibility_controls',
    scheduledRefreshTimer: false,
    telemetry: false,
    repositoryFactory: () => ({
      dataSchemaFiles: async () => [{ fileName: 'controls.js', content }],
    }),
    contextToApiScopes: (c) =>
      c.denied ? ['meta'] : ['data', 'meta', 'graphql', 'sql'],
    logger: () => {},
  });
  let server;
  const checks = [];
  let result;
  try {
    await core.initApp(app);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const endpoint = `http://127.0.0.1:${
      server.address().port
    }/cubejs-api/v1/load`;
    async function request(query, claims = {}) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: jwt.sign(claims, 'synthetic-secret'),
        },
        body: JSON.stringify({ query }),
      });
      return { status: response.status, body: await response.json() };
    }
    const f = (member, values) => ({ member, operator: 'equals', values });
    const cases = [
      [
        'closing versus average versus original sum',
        {
          measures: [
            'Snapshots.closing',
            'Snapshots.dailyAverage',
            'Snapshots.originalSum',
          ],
        },
        (r) =>
          assert.deepEqual(
            Object.values(r.data[0]).map(Number),
            [50, 175, 350]
          ),
      ],
      [
        'zero is closing; blanks excluded',
        {
          measures: [
            'ZeroPositions.closing',
            'ZeroPositions.average',
            'ZeroPositions.nonblank',
          ],
        },
        (r) =>
          assert.deepEqual(Object.values(r.data[0]).map(Number), [0, 150, 2]),
      ],
      [
        'legacy Current versus selected-day sum retained',
        { measures: ['Flows.legacyCurrent', 'Flows.selectedSum'] },
        (r) => assert.deepEqual(Object.values(r.data[0]).map(Number), [20, 30]),
      ],
      [
        'two distinct weighting contracts',
        { measures: ['Credit.weightedEad', 'Credit.weightedExposure'] },
        (r) =>
          assert.deepEqual(
            Object.values(r.data[0]).map(Number),
            [0.019, 0.091]
          ),
      ],
      [
        'book contract identity versus union customer',
        { measures: ['Credit.contracts', 'Credit.customers'] },
        (r) => assert.deepEqual(Object.values(r.data[0]).map(Number), [2, 1]),
      ],
      [
        'blank and zero fallbacks remain distinct',
        {
          measures: ['Denominators.fallback'],
          dimensions: ['Denominators.kind'],
          order: { 'Denominators.kind': 'asc' },
        },
        (r) =>
          assert.deepEqual(
            r.data.map((row) => Number(row['Denominators.fallback'])),
            [1, 0]
          ),
      ],
      [
        'paired tuples do not become independent IN sets',
        {
          measures: ['Population.count'],
          dimensions: ['Population.customer', 'Population.product'],
          filters: [
            {
              or: [
                {
                  and: [
                    f('Population.customer', ['C1']),
                    f('Population.product', ['P1']),
                  ],
                },
                {
                  and: [
                    f('Population.customer', ['C2']),
                    f('Population.product', ['P2']),
                  ],
                },
              ],
            },
          ],
        },
        (r) => assert.equal(r.data.length, 0),
      ],
      [
        'conversion before aggregation',
        { measures: ['Converted.value'] },
        (r) => assert.equal(Number(r.data[0]['Converted.value']), -25),
      ],
      [
        'dimension-only list',
        { dimensions: ['Credit.book'], order: { 'Credit.book': 'asc' } },
        (r) =>
          assert.deepEqual(
            r.data.map((row) => row['Credit.book']),
            ['a', 'b']
          ),
      ],
    ];
    for (const [name, query, check] of cases) {
      const result = await request(query);
      assert.equal(result.status, 200, JSON.stringify(result));
      check(result.body);
      const before = statements.length;
      const repeat = await request(query);
      assert.deepEqual(repeat.body.data, result.body.data);
      assert.equal(statements.length, before);
      checks.push({ name, response: normalized(result), cacheReused: true });
    }
    const denied = await request(
      { measures: ['Credit.exposure'] },
      { denied: true }
    );
    assert.equal(denied.status, 403);
    checks.push({ name: 'denied scope', response: normalized(denied) });
    result = {
      status: 'PASS',
      checks,
      statements,
      normalization: ['lastRefreshTime only'],
      precedence:
        'Native calculation-group precedence remains metadata-only evidence; no numerical result invented.',
    };
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await core.beforeShutdown();
    await core.shutdown();
  }
  return result;
}
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
