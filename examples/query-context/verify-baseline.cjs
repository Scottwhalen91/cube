const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2]);
const { prepareCompiler, PostgresQuery } = require(require.resolve(
  '@cubejs-backend/schema-compiler',
  { paths: [root] }
));
const model = fs.readFileSync(path.join(__dirname, 'model.yml'), 'utf8');
(async () => {
  const compilers = prepareCompiler(
    {
      dataSchemaFiles: async () => [{ fileName: 'ledger.yml', content: model }],
    },
    { adapter: 'postgres' }
  );
  let observed;
  await assert.rejects(
    async () => {
      await compilers.compiler.compile();
      new PostgresQuery(compilers, {
        measures: ['Ledger.amount'],
        dimensions: ['Ledger.root'],
        useNativeSqlPlanner: true,
      }).buildSqlAndParams();
    },
    (error) => {
      observed = error.message;
      return /case|context|match any of the allowed types/i.test(observed);
    }
  );
  console.log(
    JSON.stringify(
      {
        status: 'PASS',
        expected: 'Unmodified baseline rejects the new model contract',
        observed,
      },
      null,
      2
    )
  );
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
