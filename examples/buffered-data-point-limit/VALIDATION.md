# Validation receipt

Base: `331b87984939cf585db4675ebc0b6ec228faa503` (Core 1.8.8).
Node 22.23.3, Yarn 1.22.22, Rust 1.98.1, Linux x86_64. Baseline and candidate
native modules were compiled from their matching sources and lockfiles. Builds
used 2 CPUs/8 GiB/512 PIDs. The disposable PostgreSQL 12.22 source used 1 CPU/2 GiB,
a 15-second statement timeout, an internal network and no published ports.

The exact lockfile/binary hashes and test counts are in
[validation/summary.json](validation/summary.json). The branch commit identifies
the tested source diff; no binaries or private traces are included.

| Layer                                                 | Result                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| Configuration                                         | 77 tests passed                                                             |
| Native JS serialization and Cube Store wire results   | 36 tests passed                                                             |
| Gateway, GraphQL, permissions, SQL and subscriptions  | 409 tests, 23 snapshots passed                                              |
| Rust result transformation                            | 67 tests passed                                                             |
| Compiler base queries, hierarchies and dimension keys | 138 tests passed                                                            |
| Query cache, refresh keys and orchestrator            | 127 tests passed                                                            |
| Matched service backtest                              | 7 financial/visibility/cache cases;9 source SQL statements/parameters match |
| Serialization backtest                                | 16 fixture groups have identical default response hashes                    |

The service comparison includes the complete response, excluding only the
explicitly volatile `lastRefreshTime`. NULLs, numeric strings, ordering, fields,
annotations and normalized queries remain identical. Rejected cached loads and
concurrent rejected followers leave data reusable, without additional data-source
queries. Denied scopes remain 403. Hidden members remain rejected with no data;
the baseline can execute their SQL before visibility rejection, and that behavior
is unchanged. This output guard does not promise to prevent source work.

## Cost

Five warmups and 30 alternating measured pairs per shape, with compilation and
other tests stopped. Both disabled and enabled candidate modes pass the approved
median `max(5%,2ms)` and p95 `max(10%,5ms)` overhead budgets. One run; no failed
measurement was discarded.

| Shape                   | Baseline median/p95 ms | Enabled median/p95 ms |
| ----------------------- | ---------------------- | --------------------- |
| 10 rows x 3 columns     | 0.166 /0.198           | 0.152 /0.177          |
| 100 rows x 64 columns   | 5.131 /6.573           | 4.997 /7.997          |
| 49,999 rows x 5 columns | 222.257 /274.005       | 229.089 /260.864      |

[Raw samples](validation/serialization-benchmark.json) include disabled results.
These are bounded matched-build measurements, not a production performance claim.
Source review confirms the check reads existing container lengths and adds no
full-result allocation or native-to-JS materialization.

## Commands

Install each clean worktree with its pinned lockfile (`yarn install --frozen-lockfile`). Compile TypeScript with:

```sh
node_modules/.bin/tsc --build packages/cubejs-server-core packages/cubejs-postgres-driver
```

For each baseline/candidate, build the native package from its own source with:

```sh
export CARGO_BUILD_JOBS=2 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_DEV_INCREMENTAL=false
export RUSTFLAGS='-C link-arg=-fuse-ld=lld'
cd packages/cubejs-backend-native
cargo +1.98.1 build --locked
cp target/debug/libcubejs_native.so index.node
```

If using a shared `CARGO_TARGET_DIR`, copy each resulting binary to its worktree
before compiling the other. No published native binary was used for acceptance.
The dev profile retains the package's opt-level 1; Python is not enabled.

Run Jest from each package directory with `--runInBand --coverage=false`:

- Shared: `test/env.test.ts`.
- Native: `dist/test/data-point-limit.test.js dist/test/cubestore-result.test.js`.
  A temporary module exporting an empty async function replaced `globalSetup`
  for this invocation only, to avoid deletion of fallback snapshots. Test setup
  and assertions were unchanged.
- Gateway: `CUBE_JS_NATIVE_API_GATEWAY_INTERNAL=true`, `--forceExit dist/test`.
- Compiler: `--forceExit dist/test/unit/base-query.test.js dist/test/unit/hierarchies.test.js dist/test/unit/dimension-key.test.js`.
- Orchestrator: `CUBEJS_CACHE_AND_QUEUE_DRIVER=memory`, `--forceExit test/unit/QueryCache.test.ts test/unit/QueryOrchestrator.test.ts test/unit/LocalRefreshKeyCache.test.ts`.

From `rust/cube`, run `cargo +1.98.1 test --locked -p cubeorchestrator --lib query_result_transform::`. This component test uses that workspace's own pinned
lockfile; the native binding suites use the actual built native-package artifact.
Run both example verifiers as documented in the README.

Affected-file lint has zero errors and one pre-existing unused-catch warning in
unchanged authentication code. Rust formatting and Git whitespace checks pass.

## Limits and recovered attempts

Initial fixture/configuration invocations failed before the intended checks:
missing workspace-local dependencies, an incorrect Jest discovery path, missing
package-required environment switches, outdated fixture constructor/signature
usage, an invalid annotation fixture and unsupported unaligned multi-query input.
They were corrected without runtime/source dependency changes; final checks pass.
A hidden-member negative control disproved an initial no-source-read assumption;
its actual existing behavior is now explicitly preserved. Failed/recovered logs
remain available separately.

This tests synthetic PostgreSQL and in-memory-cache Core service behavior, plus
real native parsing of synthetic Cube Store legacy/Arrow protocol fixtures. No
live Cube Store server, SQL/streaming guard, distributed extraction policy,
DAX/MDX integration, Power BI, customer model or production release is claimed.
