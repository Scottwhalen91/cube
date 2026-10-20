const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const from = (name) =>
  require(require.resolve(name, { paths: [path.join(__dirname, '../..')] }));
const { prepareCompiler, PostgresQuery } = from(
  '@cubejs-backend/schema-compiler'
);
const Core = from('@cubejs-backend/server-core');
const Driver = from('@cubejs-backend/postgres-driver');
const express = from('express');
const jwt = from('jsonwebtoken');
const yaml = from('yaml');
assert.ok(process.env.NEUTRAL_DB_HOST, 'Use an owned synthetic database');
const db = {
  host: process.env.NEUTRAL_DB_HOST,
  user: 'postgres',
  password: 'synthetic',
  database: 'model_test',
};
const source = yaml.parse(
  fs.readFileSync(path.join(__dirname, 'model.yml'), 'utf8')
);
const hierarchyNames = new Set(['product_path', 'family_path', 'sector_path']);
function model(enabled) {
  const tree = structuredClone(source);
  if (!enabled) {
    for (const cube of tree.cubes) delete cube.hierarchies;
    for (const view of tree.views)
      for (const cube of view.cubes) {
        if (Array.isArray(cube.includes))
          cube.includes = cube.includes.filter(
            (name) => !hierarchyNames.has(name)
          );
        if (cube.excludes) {
          cube.excludes = cube.excludes.filter(
            (name) => !hierarchyNames.has(name)
          );
          if (!cube.excludes.length) delete cube.excludes;
        }
      }
  }
  return yaml.stringify(tree);
}
const checks = [];
async function compiler(content) {
  const c = prepareCompiler(
    {
      localPath: () => __dirname,
      dataSchemaFiles: async () => [{ fileName: 'catalog.yml', content }],
    },
    { adapter: 'postgres' }
  );
  await c.compiler.compile();
  return c;
}
async function service(content, enabled) {
  process.env.CUBEJS_DB_TYPE = 'postgres';
  process.env.CUBEJS_CACHE_AND_QUEUE_DRIVER = 'memory';
  process.env.CUBEJS_DEV_MODE = 'false';
  process.env.CUBEJS_TELEMETRY = 'false';
  const core = new Core({
    apiSecret: 'synthetic-secret',
    devServer: false,
    scheduledRefreshTimer: false,
    telemetry: false,
    driverFactory: () => new Driver(db),
    contextToAppId: () => 'hierarchy_fixture_' + enabled,
    contextToGroups: ({ securityContext }) => [
      securityContext.group || 'reader',
    ],
    repositoryFactory: () => ({
      dataSchemaFiles: async () => [{ fileName: 'catalog.yml', content }],
    }),
    logger: () => {},
  });
  const app = express();
  app.use(express.json());
  await core.initApp(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/cubejs-api/v1`;
  async function request(route, query, group = 'reader') {
    const response = await fetch(base + route, {
      method: query ? 'POST' : 'GET',
      headers: {
        Authorization: jwt.sign({ group }, 'synthetic-secret'),
        ...(query ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(query ? { body: JSON.stringify({ query }) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  return {
    request,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await core.beforeShutdown();
      await core.shutdown();
    },
  };
}
async function main() {
  const enabled = await compiler(model(true));
  const control = await compiler(model(false));
  const meta = JSON.parse(
    JSON.stringify(enabled.metaTransformer.cubes.map((c) => c.config))
  );
  const products = meta.find((c) => c.name === 'Products');
  assert.deepEqual(
    products.hierarchies.find((h) => h.name === 'Products.product_path').levels,
    ['Products.division', 'Products.family', 'Products.item']
  );
  assert.deepEqual(
    products.hierarchies.find((h) => h.name === 'Products.sector_path').levels,
    ['Products.sector', 'Products.segment']
  );
  assert.deepEqual(
    meta
      .find((c) => c.name === 'Prefixed')
      .hierarchies.find((h) => h.name === 'Prefixed.Catalog_product_path')
      .levels,
    [
      'Prefixed.Catalog_category',
      'Prefixed.Catalog_family',
      'Prefixed.Catalog_item',
    ]
  );
  assert.ok(
    !meta
      .find((c) => c.name === 'Prefixed')
      .hierarchies.some((h) => h.name.endsWith('sector_path'))
  );
  assert.deepEqual(
    meta.find((c) => c.name === 'Inherited').hierarchies[0].levels,
    ['Inherited.category', 'Inherited.family', 'Inherited.item']
  );
  assert.deepEqual(
    meta.find((c) => c.name === 'LimitedProducts').hierarchies[0].levels,
    ['LimitedProducts.category', 'LimitedProducts.family']
  );
  checks.push({
    name: 'compiler hierarchy order, aliases, prefix, exclusion, inheritance, limited exposure',
    status: 'PASS',
  });
  const queries = [
    {
      measures: ['Products.total'],
      dimensions: ['Products.division', 'Products.family', 'Products.item'],
      order: [['Products.item', 'asc']],
    },
    { measures: ['Products.total'] },
    {
      measures: [],
      dimensions: ['Products.item'],
      order: [['Products.item', 'asc']],
    },
    {
      measures: ['Products.count'],
      dimensions: ['Products.sector', 'Products.segment'],
    },
  ];
  for (const query of queries) {
    for (const useNativeSqlPlanner of [false, true]) {
      const options = {
        ...query,
        order: [],
        useNativeSqlPlanner,
        timezone: 'UTC',
      };
      assert.deepEqual(
        new PostgresQuery(enabled, options).buildSqlAndParams(),
        new PostgresQuery(control, options).buildSqlAndParams()
      );
    }
  }
  checks.push({
    name: 'hierarchy declarations preserve field-query SQL and parameters',
    count: queries.length,
  });
  let a;
  let b;
  try {
    a = await service(model(true), true);
    b = await service(model(false), false);
    const exposed = await a.request('/meta');
    assert.equal(exposed.status, 200);
    const wide = exposed.body.cubes.find((c) => c.name === 'Products');
    assert.deepEqual(
      wide.hierarchies.find((h) => h.name === 'Products.product_path').levels,
      ['Products.division', 'Products.family', 'Products.item']
    );
    checks.push({ name: 'real public metadata endpoint', meta: exposed.body });
    const limited = await a.request('/meta', null, 'limited');
    assert.equal(limited.status, 200);
    assert.ok(!limited.body.cubes.some((c) => c.name === 'Products'));
    const narrow = limited.body.cubes.find((c) => c.name === 'LimitedProducts');
    assert.ok(narrow);
    assert.deepEqual(narrow.hierarchies[0].levels, [
      'LimitedProducts.category',
      'LimitedProducts.family',
    ]);
    assert.ok(
      !narrow.dimensions.some(
        (d) => d.name.endsWith('.item') || d.name.endsWith('.sector')
      )
    );
    checks.push({
      name: 'restricted metadata exposes only allowed hierarchy configuration',
      meta: limited.body,
    });
    const denied = await a.request(
      '/load',
      { measures: ['Products.total'] },
      'limited'
    );
    assert.ok(denied.status !== 200 || denied.body.data.length === 0);
    checks.push({
      name: 'restricted view cannot read full view',
      response: denied,
    });
    const values = [];
    for (const query of queries) {
      const x = await a.request('/load', query);
      const y = await b.request('/load', query);
      assert.equal(x.status, 200, JSON.stringify(x));
      assert.equal(y.status, 200, JSON.stringify(y));
      function normalize(value) {
        if (Array.isArray(value)) return value.map(normalize);
        if (value && typeof value === 'object')
          return Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => key !== 'lastRefreshTime')
              .map(([key, v]) => [key, normalize(v)])
          );
        return value;
      }
      assert.deepEqual(normalize(x.body), normalize(y.body));
      values.push(x.body.data);
    }
    assert.equal(Number(values[1][0]['Products.total']), 30);
    assert.ok(values[0].some((r) => r['Products.item'] === null));
    checks.push({
      name: 'complete field-query responses, totals, zero and ragged blanks unchanged',
      count: queries.length,
      values,
    });
  } finally {
    if (a) await a.close();
    if (b) await b.close();
  }
  return { status: 'PASS', checks };
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
