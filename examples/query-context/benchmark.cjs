const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const shapes = [
  { name: 'small-disabled', dimensions: 1, measures: 3, context: false },
  { name: 'wide-disabled', dimensions: 10, measures: 100, context: false },
  { name: 'ten-level-context', dimensions: 10, measures: 1, context: true },
];
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
if (process.argv[2] === '--worker') {
  const root = path.resolve(process.argv[3]);
  const candidate = process.argv[4] === 'candidate';
  const shape = shapes[Number(process.argv[5])];
  const from = (name) => require(require.resolve(name, { paths: [root] }));
  const { prepareCompiler, PostgresQuery } = from(
    '@cubejs-backend/schema-compiler'
  );
  const yaml = from('yaml');
  const fixture = require('./fixture.cjs')(shape, candidate);
  const dims = fixture.cubes[0].dimensions.slice(0, shape.dimensions);
  const measures = fixture.cubes[0].measures;
  const model = yaml.stringify(fixture);
  const c = prepareCompiler(
    {
      localPath: () => __dirname,
      dataSchemaFiles: async () => [{ fileName: 'bench.yml', content: model }],
    },
    { adapter: 'postgres' }
  );
  c.compiler
    .compile()
    .then(() => {
      process.on('message', (message) => {
        if (message.quit) process.exit(0);
        try {
          const options = {
            useNativeSqlPlanner: true,
            timezone: 'UTC',
            dimensions: dims.map((d) => `Bench.${d.name}`),
            measures: shape.context
              ? ['Bench.amount']
              : measures.map((m) => `Bench.${m.name}`),
          };
          const start = performance.now();
          const query = new PostgresQuery(c, options);
          const result = query.buildSqlAndParams();
          const members = query.collectAllMemberNames();
          const ms = performance.now() - start;
          process.send({
            id: message.id,
            ms,
            sqlHash: hash(JSON.stringify(result)),
            memberHash: hash(JSON.stringify(members)),
            sourceSelects: (result[0].match(/AS fixture_rows/g) || []).length,
          });
        } catch (error) {
          process.send({ id: message.id, error: error.stack });
        }
      });
      process.send({ ready: true, modelHash: hash(model) });
    })
    .catch((error) => {
      console.error(error.stack);
      process.exit(1);
    });
} else {
  const baseline = path.resolve(process.argv[2]);
  const candidate = path.resolve(process.argv[3]);
  let sequence = 0;
  async function worker(root, mode, index) {
    const child = fork(__filename, ['--worker', root, mode, String(index)], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    const ready = await new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
      child.once('exit', (code) =>
        reject(new Error(`Worker init ${code}: ${stderr}`))
      );
    });
    assert.ok(ready.ready);
    return {
      child,
      ready,
      sample: () =>
        new Promise((resolve, reject) => {
          const id = ++sequence;
          const listener = (response) => {
            if (response.id !== id) return;
            child.off('message', listener);
            response.error
              ? reject(new Error(response.error))
              : resolve(response);
          };
          child.on('message', listener);
          child.send({ id });
        }),
      close: () =>
        new Promise((resolve) => {
          child.once('exit', resolve);
          child.send({ quit: true });
        }),
    };
  }
  const quantile = (values, p) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  (async () => {
    const results = [];
    for (let i = 0; i < shapes.length; i++) {
      let a, b;
      try {
        a = await worker(baseline, 'baseline', i);
        b = await worker(candidate, 'candidate', i);
        for (let j = 0; j < 5; j++) {
          await a.sample();
          await b.sample();
        }
        const pairs = [];
        for (let j = 0; j < 30; j++) {
          let base, cand;
          if (j % 2) {
            cand = await b.sample();
            base = await a.sample();
          } else {
            base = await a.sample();
            cand = await b.sample();
          }
          assert.equal(
            cand.sqlHash,
            base.sqlHash,
            'Equivalent SQL/parameters: ' + shapes[i].name
          );
          assert.equal(
            cand.sourceSelects,
            base.sourceSelects,
            'No additional source scan'
          );
          if (!shapes[i].context)
            assert.equal(
              cand.memberHash,
              base.memberHash,
              'Unchanged authorization dependencies'
            );
          pairs.push({ baseline: base.ms, candidate: cand.ms });
        }
        const bm = quantile(
            pairs.map((p) => p.baseline),
            0.5
          ),
          cm = quantile(
            pairs.map((p) => p.candidate),
            0.5
          );
        const bp = quantile(
            pairs.map((p) => p.baseline),
            0.95
          ),
          cp = quantile(
            pairs.map((p) => p.candidate),
            0.95
          );
        const medianBudget = Math.max(bm * 0.05, 2),
          p95Budget = Math.max(bp * 0.1, 5);
        results.push({
          shape: shapes[i],
          modelHashes: {
            baseline: a.ready.modelHash,
            candidate: b.ready.modelHash,
          },
          pairs,
          median: {
            baseline: bm,
            candidate: cm,
            overhead: cm - bm,
            budget: medianBudget,
          },
          p95: {
            baseline: bp,
            candidate: cp,
            overhead: cp - bp,
            budget: p95Budget,
          },
          pass: cm - bm <= medianBudget && cp - bp <= p95Budget,
        });
      } finally {
        if (a) await a.close();
        if (b) await b.close();
      }
    }
    const result = {
      status: results.every((r) => r.pass) ? 'PASS' : 'FAIL',
      warmups: 5,
      pairsPerShape: 30,
      measurement:
        'Fresh query construction, native planning and authorization dependency collection; cached model; alternating processes; equivalent SQL and scan count asserted',
      results,
    };
    if (process.env.NEUTRAL_RESULT_FILE)
      fs.writeFileSync(
        process.env.NEUTRAL_RESULT_FILE,
        JSON.stringify(result, null, 2)
      );
    else console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === 'PASS' ? 0 : 1);
  })().catch((error) => {
    console.error(error.stack);
    process.exit(1);
  });
}
