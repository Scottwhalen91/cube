# Compile-time query-context cases

An opt-in `case` form for multi-stage measures selects a formula from the normalized query, before planning its dependencies. This supports displayed hierarchy depth, detail/subtotal formulas and selection-sensitive comparisons through the existing calculation pipeline. It adds no request parameter, environment setting, runtime dependency or DAX function implementation.

```yaml
multi_stage: true
type: number
case:
  when:
    - context:
        filtered: Ledger.depth
      sql: "{raw_amount}"
    - context:
        deepest_grouped: [Ledger.root, Ledger.section, Ledger.account]
        equals: 2
      sql: "{amount2}"
  else:
    sql: "{amount0}"
```

`model.yml` provides a complete numeric example. A leaf is +3 at its own level but contributes -3 at the parent: filtering that leaf must not change the displayed grouping's sign. Other measures demonstrate blank subtotals and a comparison that depends on an explicitly selected sibling measure.

## Predicate contract

Use exactly one operator per predicate. YAML uses snake_case; JavaScript/TypeScript uses camelCase (`QueryContextPredicate` and `ContextCaseDefinition` are exported types).

| Operator | Meaning |
| --- | --- |
| `grouped: member` | The canonical member is grouped. Direct aliases share identity; computed expressions do not implicitly group their input member. |
| `grouped: { member, granularity }` | A time member is grouped at this granularity. A date filter without granularity is not a grouping. |
| `deepest_grouped: [members]` plus `equals: index` | Highest grouped index in the author's ordered list; `-1` means none. Canonical duplicates are rejected. |
| `filtered: member` | Member occurs in the incoming normalized filter tree, including an implicit time-dimension date range. |
| `single_value: member` plus `equals: scalar` | Equality/IN constraints establish a symbolic singleton under AND/OR. Unsupported inference and contradictory/absent selections are unknown. Scalar types, including NULL, are retained without new coercions. |
| `has_measure: member` | Named measure is explicitly selected in the normalized query. Dependency-only measures and anonymous computed expressions do not count as selecting that named measure. |
| `all`, `any`, `not` | Three-valued Boolean composition. Unknown remains unknown through negation; only true selects a branch. |

The first true `when` wins; `else.sql` is mandatory. Context predicates cannot be mixed with row-SQL or switch-value case clauses. References and granularities are validated, including branches that are not selected. Context conditions are data-independent: single-child groups, empty facts and ragged rows cannot determine scope.

## Scope, defaults and consumers

The immutable snapshot and its canonical-member metadata memo belong to one per-query compiler, before view defaults and internal stage filters. Inner `grain.include`, `exclude` and `keep_only` changes inherit that query scope. Independent normalized queries receive independent contexts. Existing compiler/symbol caches are already per-query, so their ownership supplies context isolation; no global context or alternate result-cache key is introduced.

Authorization discovery conservatively visits every possible branch reference before policy injection; only Tesseract selects the execution branch. Consequently an opt-in measure requires access to its possible dependencies, as with ordinary static formula references. Policy filters for those dependencies remain enforced even when a branch is not selected. This can restrict a cross-cube model; this branch does not relax authorization to avoid that restriction.

Incoming filters remain enforced. Upstream policy filters already present in that tree are included; this API does not invent security-versus-business provenance. Opaque segment SQL is not parsed into member selections. Context cannot remove row/member authorization or relax a view default.

A legacy shared depth guard can conflict with a new depth-specific helper. The verifier deliberately retains such a guard and checks that it still restricts the query. Opt-in migration must assign one depth policy to the measure, preserve unrelated guards, and verify lists, explicit overrides, blanks and totals. This example does not migrate a deployed model or remove a hook. No-level blank behavior is expressed by the model, not hard-coded into the engine.

The selected branch is the dependency graph used for SQL and pre-aggregation matching. Materialize the existing branch measures; directly materializing a context-dispatched measure is rejected. Generated SQL/parameters and existing security/source keys retain result-cache ownership. Models without context cases preserve their existing behavior; the legacy planner gives a clear error only when a context-dependent measure is requested.

Separate normalized subtotal queries each have their own grouping. Unsplit ROLLUP/CUBE descriptions are rejected for context cases where the effective grouping cannot be determined. Context-free queries retain their current behavior. This is a bounded query-context capability, not complete SQL grouping-set support.

REST and the public PostgreSQL-wire SQL API are exercised without client translation changes. Proprietary DAX/MDX/XMLA and native report rendering are not tested or implemented. Calculation groups, native dynamic formats, gateway lifecycle and extraction controls are outside this branch.

## Limits of compile-time context

A grouping set supplies grouped member identities, not each returned row's dimension value. Multi-valued selections and data cardinality are not assumed to be singletons. No filter and a client select-all that sends no filter are the same input; an explicit two-value filter is distinguishable through `filtered`.

Domain defaults belong to the model: scenario preference, pinned measures, currency, time windows, account signs and ratio roles reuse existing formulas. A last-actual-month default depends on data, as do missing-rate checks, ratio-account ambiguity and last-nonblank balances; their SQL/blank checks remain. This API does not remove those checks or promise to remove row replication automatically. No new measure-override mechanism is added.

The result cache continues to distinguish generated SQL, parameters and existing source/security keys; the compiler and metadata memo are per query. Different selected formulas must produce the corresponding SQL/parameters. If two contexts produce identical SQL/parameters under the same existing security/source identity, their database result is identical and safe to reuse. A future context feature affecting semantics outside that contract would require an explicit cache extension. Do not add a redundant context cache key merely to encode different names for the same result.

## Why this layer

Filter-only configuration cannot determine displayed grouping. Counting returned/distinct values confuses scope with data cardinality. A query hook duplicates interpretation outside the planner. Resolving a typed context case inside the existing per-query compiler keeps the decision with the query and leaves existing multi-stage, filter, security and pre-aggregation machinery in control. It also avoids planning unused formula branches.

## Reproduction

Build the repository's schema compiler, server core, PostgreSQL driver and matching native module from the same source and pinned lockfiles. Do not combine new compiler sources with a published native binary from another revision.

Run compiler tests from the schema-compiler package using its compiled-test invocation. Run Rust planner tests from the `rust/cube` workspace with its own lockfile.

The example verifiers require an owned disposable PostgreSQL database named `model_test`, user `postgres`, password `synthetic`, private networking and bounded queries. They never start a database or use a default host:

```sh
NEUTRAL_DB_HOST=your-synthetic-db node examples/query-context/verify.cjs
NEUTRAL_DB_HOST=your-synthetic-db NEUTRAL_RESULT_FILE=result.json node examples/query-context/service-backtest.cjs
NEUTRAL_DB_HOST=your-synthetic-db NEUTRAL_PREAGG=true NEUTRAL_RESULT_FILE=rollups.json node examples/query-context/service-backtest.cjs
```

The pre-aggregation mode explicitly enables the existing builder option in this disposable instance and creates only its synthetic rollups. The service runner explicitly shuts down its SQL listener, HTTP listener, timers and pools before exiting; as with the repository's forceExit integration tests, it then exits the native test process. This is not a lifecycle fix.

For unchanged-model comparison, execute `control-backtest.cjs BASELINE_ROOT` and then `control-backtest.cjs CANDIDATE_ROOT` against the same disposable source. Compare complete output objects: only `lastRefreshTime` is normalized. Historical and current financial definitions remain separate; no native calculation-group numerical golden is invented.

Stop other owned tests/builds before cost measurement:

```sh
NEUTRAL_RESULT_FILE=cost.json node examples/query-context/benchmark.cjs BASELINE_ROOT CANDIDATE_ROOT
```

It uses isolated compiler processes, five warmups and 30 serial alternating pairs per shape. Measurement includes authorization reference collection. Disabled models must produce identical SQL/parameters and member references. Context-enabled planning is compared with an explicitly selected equivalent existing measure. Source scan counts and SQL identity are checked; median and p95 budgets are respectively max(5%,2ms) and max(10%,5ms). Measurement noise or unexplained regressions block acceptance.

See VALIDATION.md for the actual tested source, commands, evidence and limits. Synthetic component/service evidence does not establish native-client or production acceptance.
