# Buffered load data-point limit

An optional output-cell budget for Core REST and GraphQL loads. Set
`CUBEJS_DB_QUERY_DATA_POINT_LIMIT=35` to permit 35 returned cells. Seven rows with
five data columns fit; 36 cells fail with a non-retryable user error and no partial
result. NULL, zero, blank and generated data fields count. Unset preserves current
behavior. Multi-result loads share one budget; GraphQL sibling resolver loads do
not share a cumulative HTTP-request budget.

The guard runs over the existing transformed native response immediately before
serialization. It allocates no extra complete result, does not read individual
cell values, and leaves query planning, SQL, row limits and cached source results
unchanged. SQL/streaming/DAX/MDX are excluded. This does not bound query execution,
bytes, memory already spent producing a result or cumulative extraction.

## Design

Reuse the shared configuration parser and the native serializer. One budget
checker serves single/multi-result serialization and all output layouts. Count
actual fields rather than requested members: aliases may deduplicate keys and
time/compare-range output may add fields. Subtract from the budget to avoid
arithmetic overflow. Keep error classification in the existing API user-error
path. No model option, dependency, query-rewrite hook or second planner is added.

Early LIMIT injection was rejected because it can change totals and downstream
post-processing. Counting query member arrays misses generated/aliased fields.
A proxy duplicates normalization and misses native results. New output caps do
not belong in query cache keys because they govern delivery, not result identity.

## Reproduce

Compile baseline and candidate from the pinned source, including their native
modules and package dependencies; do not mix a published binary with new JS.
Run the existing configuration, gateway/GraphQL and native serializer suites and
the added `data-point-limit.test` cases. `cubestore-result.test` also covers native
legacy and Arrow protocol results. The SQL transport exclusion is regression-tested.

Run:

```sh
node examples/buffered-data-point-limit/verify.cjs <baseline-native-package> <candidate-native-package>
```

The verifier compares response hashes and independent synthetic golden cells,
proves baseline non-enforcement and candidate rejection, then measures five
warmups/30 alternating samples per small/wide/near-limit shape. It exits 2 if the
median/p95 budgets fail. Raw samples are emitted; noise is not a passing result.

See [VALIDATION.md](VALIDATION.md) for completed tests, exact hashes, commands and cost samples.
Synthetic serialization tests do not establish native BI integration, financial
model parity, real identity acceptance or production readiness.

## Changed contracts and controls

- The native JS binding gains one optional fourth argument; callers that omit it
  retain their existing result. The package JS and native binary must come from
  the same source, as in the tested builds.
- The result wrappers own delivery policy. The gateway validates configuration
  at startup, then REST and GraphQL use the same wrappers. There is no second
  counter in GraphQL or in the HTTP response handler.
- The transformation remains authoritative for aliases, generated columns,
  NULLs and output layouts. The budget checks only the lengths of those existing
  containers, without another materialization or cell-value pass.
- Planning, SQL, cache identity, refresh keys, security rewriting, visibility,
  cancellation and shared source-result ownership have no source changes.
  Disabled byte/structure comparisons, unchanged source SQL/parameters, hidden
  member and denied-role controls, and reuse after rejected serialization are
  the compatibility falsifiers. They are bounded evidence, not universal proof.

The service verifier runs a disposable synthetic PostgreSQL fixture through the
real compiler, driver, queue/cache, gateway and HTTP delivery. Set
`NEUTRAL_DB_HOST` to that isolated database container, create the database
`core_budget_fixture`, then run each build sequentially:

```sh
node examples/buffered-data-point-limit/service-backtest.cjs <baseline-workspace> baseline
node examples/buffered-data-point-limit/service-backtest.cjs <candidate-workspace> candidate
```

The script resets only its synthetic `neutral_daily` table. It uses an explicit
throwaway fixture password and API secret; do not point it at a real database.
The outputs retain source SQL and parameters for baseline/candidate comparison.
The golden calculations distinguish closing stocks, flows, weighted totals,
row-level conversion, signed amounts and distinct book identities. Serializer
fixtures retain conflicting example financial contracts as separate outputs;
they do not select a new financial definition or implement calculation groups.

## Architecture review boundary

This adds one policy owner, one native counting kernel and no runtime dependency,
model syntax, expression language, planner branch or persistent state. A new
extract-budget service would add identity and distributed state requirements;
those are outside a per-load returned-cell cap. The reusable workloads are narrow
lists, wide analytical outputs and multi-result comparisons. None establishes
SQL, streaming, native DAX/MDX, cumulative extraction or customer acceptance.
