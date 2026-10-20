# Validation receipt

Base: `331b87984939cf585db4675ebc0b6ec228faa503` (Core 1.8.8). Node 22.23.3, Yarn 1.22.22, Rust 1.98.1, PostgreSQL 12.22. Lockfiles are unchanged. `runtime-sources.json` pins the changed source files; `validation-summary.json` contains exact hashes, measurements and test counts. No native binary is included. The candidate native module was built from these matching sources. The unchanged baseline artifact was hash-verified against its prior build from this exact base.

The pinned base is deliberate. A subsequent public upstream inspection at `f91ecd8cfe93da6f9b6b278c9faa6c212134a15c` found no competing context owner. Later TypeScript file moves/API changes require a mechanical port and fresh validation before upstream integration; this branch does not claim to be based on that later head.

## Results

- Rust planner: 1,660 passed, 9 pre-existing ignored.
- Compiler: 253 passed across six suites, including 21 context cases; final focused context rerun after formatting passed all 21.
- Gateway: 402 passed, 23 snapshots. Cache/orchestrator: 127 passed.
- Independent PostgreSQL values: 38 signed/predicate/default/mask controls and 20 grain/month controls.
- Full REST/PostgreSQL-wire SQL API: 16 checks for raw source, 16 with eligible branch rollups and 16 with intentionally coarse rollups; actual rollup use/miss asserted. Access-policy mode: 17 checks, including denial of a branch dependency directly and through context dispatch.
- Unchanged synthetic model: 10 complete responses and eight SQL/parameter records match the baseline exactly after removing only `lastRefreshTime`. Stock, zero/blank, flow, weighted ratios, source-level FX, populations and tuple semantics remain distinct. Historical/current financial definitions are labelled separately; native calculation-group precedence has no fabricated numerical golden.
- Unmodified baseline rejects the new model contract. Candidate resolves the formula, preserving the parent −3 versus leaf +3 falsifier, explicit overrides, independent hierarchy identities, inner-stage grain, aliases, blank output and masks.

Counts describe different test units and are not added into a claim of requirement coverage.

## Cost

Five warmups and 30 serial alternating baseline/candidate pairs per shape; fresh query construction, native planning and authorization dependency collection, with cached model and isolated processes. Equivalent SQL/parameters and source scan count are asserted; disabled models also retain identical member references. Other owned tests/database were paused for measurement.

| Shape | Median baseline → candidate | p95 baseline → candidate |
| --- | --- | --- |
| Small, disabled | 2.512 → 2.620 ms | 3.593 → 3.481 ms |
| Wide, disabled | 13.762 → 14.038 ms | 18.895 → 17.335 ms |
| Ten-level context vs fixed equivalent formula | 4.817 → 6.216 ms | 6.284 → 8.609 ms |

All pass median max(5%, 2 ms), p95 max(10%, 5 ms). These are planning measurements, not production latency or a speedup claim. Initial enabled runs failed with repeated bridge resolution (~13 ms median overhead); a memo owned by the same per-query context removed that repeated work. Failed attempts remain in the private run record. No additional result copy, source scan or duplicated formula execution is introduced.

## Reproduction commands

Build matching native code and compiler/service packages, using the repository's pinned lockfiles:

```sh
CARGO_BUILD_JOBS=2 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_DEV_INCREMENTAL=false RUSTFLAGS="-C link-arg=-fuse-ld=lld" cargo +1.98.1 build --locked --manifest-path packages/cubejs-backend-native/Cargo.toml
# Install the produced native artifact into the package using its normal source-build workflow.
yarn tsc --build packages/cubejs-schema-compiler packages/cubejs-server-core packages/cubejs-postgres-driver
cargo +1.98.1 test --locked --manifest-path rust/cube/Cargo.toml -p cubesqlplanner --lib
```

From `packages/cubejs-schema-compiler`, run the compiled Jest tests with `--runInBand --coverage=false --forceExit`: `query-context-case`, `base-query`, `hierarchies`, `dimension-key`, `pre-agg-masked-members`, `yaml-schema`. Use `NODE_OPTIONS=--experimental-vm-modules`. Run the gateway `dist/test` suite with `CUBE_JS_NATIVE_API_GATEWAY_INTERNAL=true`; run orchestrator `QueryCache`, `QueryOrchestrator` and `LocalRefreshKeyCache` with memory cache/queue. The repository's `oxlint` reports no errors in changed JS/TS; eight pre-existing warnings match the baseline. Rust formatting and Git whitespace checks pass.

```sh
node examples/query-context/verify-baseline.cjs BASELINE_ROOT
NEUTRAL_DB_HOST=your-synthetic-db node examples/query-context/verify.cjs
NEUTRAL_DB_HOST=your-synthetic-db node examples/query-context/verify-grains.cjs
NEUTRAL_DB_HOST=your-synthetic-db NEUTRAL_POLICIES=true NEUTRAL_RESULT_FILE=policy.json node examples/query-context/service-backtest.cjs
NEUTRAL_DB_HOST=your-synthetic-db NEUTRAL_PREAGG=true NEUTRAL_BAD_ROLLUP=true NEUTRAL_RESULT_FILE=coarse.json node examples/query-context/service-backtest.cjs
```

See README for raw/eligible-rollup, baseline comparison and cost commands. Tests require an owned private synthetic database and must not target a shared service. Database query time was capped at 15 seconds; build/test capacity was capped at two CPUs, 8 GiB and 512 PIDs, with a separate one-CPU/2-GiB database. No host-wide settings were changed.

## Review boundary

One context owner, existing typed model/schema bridge, existing case/SQL-call IR and multi-stage planner. JavaScript conservatively discovers possible authorization dependencies; it does not select formulas. Only the chosen native branch participates in execution planning. No new request/config setting, runtime dependency, expression parser, query hook, data-dependent scope inference, cache/freshness policy or customer migration is included.

This is a Core starter with model opt-in required. Native DAX/MDX/XMLA discovery/translation, native subtotal split, report rendering, runtime hook removal and production acceptance remain unexecuted. Existing data-dependent defaults, financial checks and policies must stay in place during any later model migration.
