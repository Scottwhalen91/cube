const assert = require("node:assert/strict");
const path = require("node:path");
const workspace = path.resolve(process.argv[2]);
const mode = process.argv[3] || "candidate";
const from = (name) => require(require.resolve(name, { paths: [workspace] }));
const express = from("express");
const jwt = from("jsonwebtoken");
const { Client } = from("pg");
const Core = from("@cubejs-backend/server-core");
const PostgresDriver = from("@cubejs-backend/postgres-driver");
assert.ok(
  process.env.NEUTRAL_DB_HOST,
  "NEUTRAL_DB_HOST must identify the disposable fixture database"
);
const db = {
  host: process.env.NEUTRAL_DB_HOST,
  port: 5432,
  user: "postgres",
  password: "synthetic-test-only",
  database: "core_budget_fixture",
};
const model = `
 cube('Ledger', {
  sql: 'SELECT * FROM neutral_daily',
  refreshKey: { sql: 'SELECT 1' },
  measures: {
   income: { type:'sum', sql:'income' },
   ead: { type:'sum', sql:'ead' },
   numerator: { type:'sum', sql:'pd * ead' },
   weighted: { type:'number', sql: \`\${numerator} / NULLIF(\${ead},0)\` },
   converted: { type:'sum', sql:'amount * fx' },
   customers: { type:'countDistinct', sql:'customer' },
   contracts: { type:'countDistinct', sql: "book || ':' || contract" },
   signed: { type:'sum', sql:'signed_amount' }
  },
  dimensions: { id:{sql:'id', type:'number', primaryKey:true}, region:{sql:'region',type:'string'}, day:{sql:'day',type:'time'}, parent:{sql:'parent',type:'string'}, child:{sql:'child',type:'string'}, customer:{sql:'customer',type:'string'}, product:{sql:'product',type:'string'} }
 });
 cube('Positions', {
  sql: 'SELECT region, (array_agg(balance ORDER BY day DESC) FILTER (WHERE balance IS NOT NULL))[1] AS closing, AVG(balance) AS average FROM neutral_daily GROUP BY region',
  refreshKey:{sql:'SELECT 1'},
  measures:{closing:{type:'sum',sql:'closing'},average:{type:'sum',sql:'average'}},
  dimensions:{region:{sql:'region',type:'string',primaryKey:true,public:true}}
 });
 view('LedgerView', { cubes:[{ joinPath:Ledger, includes:[{name:'income',alias:'activity'}, 'weighted','converted','customers','contracts','signed','region','day','parent','child','customer','product'] }] });
`;
let dataCalls = 0;
const statements = [];
class Driver extends PostgresDriver {
  async query(sql, values, options) {
    if (sql.includes("neutral_daily")) {
      dataCalls++;
      statements.push({ sql, values });
    }
    return super.query(sql, values, options);
  }
}
async function main() {
  const setup = new Client(db);
  await setup.connect();
  await setup.query("DROP TABLE IF EXISTS neutral_daily");
  await setup.query(
    `CREATE TABLE neutral_daily(id int, region text, day date, balance double precision, income double precision, ead double precision, pd double precision, amount double precision, fx double precision, customer text, contract text, book text, parent text, child text, product text)`
  );
  await setup.query(`INSERT INTO neutral_daily VALUES
 (1,'North','2026-01-01',300,100,900,0.01,100,1,'U','X','a','Root','Revenue','P1'),
 (2,'North','2026-01-02',0,-20,100,0.1,100,2,'U','X','b','Root','Cost','P2'),
 (3,'North','2026-01-03',NULL,0,0,0,NULL,NULL,'U','Y','b','Root',NULL,'P2'),
 (4,'South','2026-01-01',50,20,0,0.2,10,3,'V','Z','a','Root','Revenue','P1')`);
  await setup.query(
    "ALTER TABLE neutral_daily ADD COLUMN signed_amount double precision"
  );
  await setup.query(
    "UPDATE neutral_daily SET signed_amount=CASE id WHEN 1 THEN 100 WHEN 2 THEN -20 WHEN 4 THEN 20 ELSE 0 END"
  );
  await setup.end();
  delete process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT;
  process.env.CUBEJS_DB_TYPE = "postgres";
  process.env.CUBEJS_CACHE_AND_QUEUE_DRIVER = "memory";
  process.env.CUBEJS_DEV_MODE = "false";
  process.env.CUBEJS_TELEMETRY = "false";
  const app = express();
  app.use(express.json());
  const core = new Core({
    apiSecret: "synthetic-secret",
    devServer: false,
    driverFactory: () => new Driver(db),
    contextToAppId: () => "neutral_budget_backtest",
    repositoryFactory: () => ({
      dataSchemaFiles: async () => [{ fileName: "neutral.js", content: model }],
    }),
    scheduledRefreshTimer: false,
    telemetry: false,
    queryRewrite: (query, { securityContext }) => {
      if (securityContext.region)
        query.filters = [
          ...(query.filters || []),
          {
            member: query.measures?.[0]?.startsWith("Positions.")
              ? "Positions.region"
              : "LedgerView.region",
            operator: "equals",
            values: [securityContext.region],
          },
        ];
      return query;
    },
    contextToApiScopes: (securityContext) =>
      securityContext.denied ? ["meta"] : ["data", "meta", "graphql", "sql"],
    logger: () => {},
  });
  let server;
  try {
    await core.initApp(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (q, claims = {}, extra = {}) => {
      const response = await fetch(`${base}/cubejs-api/v1/load`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: jwt.sign(claims, "synthetic-secret"),
        },
        body: JSON.stringify({ query: q, ...extra }),
      });
      return { status: response.status, body: await response.json() };
    };
    const cases = [
      {
        name: "flow-ratio-fx-distinct",
        query: {
          measures: [
            "LedgerView.activity",
            "LedgerView.weighted",
            "LedgerView.converted",
            "LedgerView.customers",
            "LedgerView.contracts",
          ],
          dimensions: ["LedgerView.region"],
          order: { "LedgerView.region": "asc" },
        },
        check: (data) => {
          const north = data.find((r) => r["LedgerView.region"] === "North"),
            south = data.find((r) => r["LedgerView.region"] === "South");
          assert.equal(+north["LedgerView.activity"], 80);
          assert.equal(+north["LedgerView.weighted"], 0.019);
          assert.equal(+north["LedgerView.converted"], 300);
          assert.equal(+north["LedgerView.customers"], 1);
          assert.equal(+north["LedgerView.contracts"], 3);
          assert.equal(south["LedgerView.weighted"], null);
        },
      },
      {
        name: "closing-zero-average-null",
        query: {
          measures: ["Positions.closing", "Positions.average"],
          dimensions: ["Positions.region"],
          order: { "Positions.region": "asc" },
        },
        check: (data) => {
          const n = data.find((r) => r["Positions.region"] === "North");
          assert.equal(+n["Positions.closing"], 0);
          assert.equal(+n["Positions.average"], 150);
        },
      },
      {
        name: "signed-ragged-total",
        query: {
          measures: ["LedgerView.signed"],
          dimensions: ["LedgerView.parent"],
          order: { "LedgerView.parent": "asc" },
        },
        check: (data) => assert.equal(+data[0]["LedgerView.signed"], 100),
      },
      {
        name: "ratio-total",
        query: { measures: ["LedgerView.weighted"] },
        check: (data) => assert.equal(+data[0]["LedgerView.weighted"], 0.019),
      },
      {
        name: "dimension-list",
        query: {
          dimensions: ["LedgerView.region"],
          order: { "LedgerView.region": "asc" },
        },
        check: (data) =>
          assert.deepEqual(
            data.map((r) => r["LedgerView.region"]),
            ["North", "South"]
          ),
      },
      {
        name: "time-normalization",
        query: {
          measures: ["LedgerView.activity"],
          dimensions: ["LedgerView.day.month"],
          order: { "LedgerView.day.month": "asc" },
        },
        check: (data) => assert.equal(+data[0]["LedgerView.activity"], 100),
      },
      {
        name: "authorized-region",
        query: {
          measures: ["LedgerView.activity"],
          dimensions: ["LedgerView.region"],
        },
        claims: { region: "North" },
        check: (data) => {
          assert.equal(data.length, 1);
          assert.equal(data[0]["LedgerView.region"], "North");
        },
      },
    ];
    const output = [];
    for (const c of cases) {
      delete process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT;
      const control = await request(c.query, c.claims);
      assert.equal(control.status, 200, JSON.stringify(control));
      c.check(control.body.data);
      const before = dataCalls;
      const points = control.body.data.reduce(
        (n, row) => n + Object.keys(row).length,
        0
      );
      process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT = String(
        Math.max(points, 1)
      );
      const allowed = await request(c.query, c.claims);
      assert.equal(allowed.status, 200, JSON.stringify(allowed));
      assert.deepEqual(allowed.body.data, control.body.data);
      if (points > 1) {
        process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT = String(points - 1);
        const rejected = await request(c.query, c.claims);
        assert.equal(
          rejected.status,
          mode === "candidate" ? 400 : 200,
          JSON.stringify(rejected)
        );
        if (mode === "candidate") {
          assert.equal(rejected.body.type, "UserError");
          assert.equal(rejected.body.data, undefined);
          const followers = await Promise.all([
            request(c.query, c.claims),
            request(c.query, c.claims),
          ]);
          assert.ok(
            followers.every(
              (r) =>
                r.status === 400 &&
                r.body.type === "UserError" &&
                r.body.data === undefined
            )
          );
        }
      }
      delete process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT;
      assert.deepEqual(
        (await request(c.query, c.claims)).body.data,
        control.body.data
      );
      assert.equal(
        dataCalls,
        before,
        `${c.name}: repeated or rejected serialization fetched source again`
      );
      output.push({
        name: c.name,
        points,
        data: control.body.data,
        query: control.body.query,
        annotation: control.body.annotation,
        response: control.body,
        cacheExtraDataCalls: dataCalls - before,
      });
    }
    const denied = await request(cases[0].query, { denied: true });
    assert.equal(denied.status, 403);
    const beforeDenied = dataCalls;
    const hidden = await request({ dimensions: ["Ledger.id"] });
    assert.notEqual(hidden.status, 200);
    assert.match(hidden.body.error, /hidden member/);
    assert.equal(hidden.body.data, undefined);
    const hiddenSourceCalls = dataCalls - beforeDenied;
    const q = {
      measures: ["LedgerView.activity"],
      dimensions: ["LedgerView.region"],
      timeDimensions: [
        {
          dimension: "LedgerView.day",
          compareDateRange: [
            ["2026-01-01", "2026-01-03"],
            ["2026-01-01", "2026-01-03"],
          ],
        },
      ],
    };
    process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT = "6";
    const multi = await request(q, {}, { queryType: "multi" });
    assert.equal(
      multi.status,
      mode === "candidate" ? 400 : 200,
      JSON.stringify(multi)
    );
    process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT = "12";
    const accepted = await request(q, {}, { queryType: "multi" });
    assert.equal(accepted.status, 200, JSON.stringify(accepted));
    assert.equal(accepted.body.results.length, 2);
    process.stdout.write(
      JSON.stringify(
        {
          mode,
          cases: output,
          deniedStatus: denied.status,
          hidden: {
            status: hidden.status,
            error: hidden.body.error,
            sourceCalls: hiddenSourceCalls,
          },
          multiLowStatus: multi.status,
          statements,
          pass: true,
          evidenceLayer:
            "full synthetic Core + PostgreSQL HTTP/cache path; not customer/native DAX acceptance",
        },
        null,
        2
      ) + "\n"
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await core.releaseConnections();
    await core.shutdown();
  }
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
