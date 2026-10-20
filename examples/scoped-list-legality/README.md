# Scoped-list transformation legality

Executable neutral SQL examples for an offered-date list whose right-hand relation is an outer-join tree. These fixtures package optimizer legality evidence; they add no optimizer rule, SQL recognizer or model rewrite. Base: `331b87984939cf585db4675ebc0b6ec228faa503`.

The reusable opportunity is to replace fanout followed by grouping with an existence predicate when the projection and relational contracts permit it. The intended platform pattern is a structured relational transformation before rendering. A regex over rendered SQL, unchecked author assertion or fact-only EXISTS substitutes assumptions for that proof and is rejected here.

The existing public bridge (`rust/cube/cubesqlplanner/cubesqlplanner/src/cube_bridge/join_item_definition.rs`) carries a `MemberSql` join condition; its relationship/multiplication metadata does not prove arbitrary SQL independence, correlation, NULL extension or projection semantics. The full offered-list shape therefore has no implemented automatic rule in this branch. A future rule needs structured ownership/correlation (including required independence), nullability, multiplicity, grouping/ordering and projection facts before it can render a replacement.

## What is tested

`cases.cjs` defines fixed synthetic relations and explicit original/EXISTS SQL. It is a fixture builder, not a transformation implementation. Expected offered keys and tuples in the verifier are independent literal expectations.

Eight equivalence cases execute both plans: populated independent scope; empty facts with a retained outer anchor; entirely empty right relation; populated nonqualifying facts; NULL offered keys with duplicates/fanout; true date correlation; business OR under mandatory tenant scope; nullable correlation with ordinary SQL equality.

Seven further controls disprove unsafe shortcuts or require rejection:

- Fact-only EXISTS loses all twelve offered dates on empty facts.
- Dropping correlation expands two offered dates into twelve.
- Moving the tenant predicate into only one OR arm changes the offered population.
- Replacing equality with NULL-safe equality adds an otherwise absent key.
- Semijoin existence changes fanout counts from two to one; the original SUM is independently checked as ten.
- Empty-fact COUNT(rhs)=0, COUNT(*)=1 and SUM=NULL remain distinct.
- A projected right-side product retains two tuples per offered date and cannot be dropped.

Complete ordered keys, constant projection values, NULLs, counts, sums and right-side tuples are checked. The run passes 15 check groups using 24 actual database statements. These counts are not feature-requirement coverage or a performance measurement. `validation-summary.json` pins the fixtures.

## Reproduce

Node 22.23.3 and PostgreSQL 12.22 were used. Dependencies come from the unchanged base lockfile. No native compiler change/build is needed: this is source SQL legality evidence. Use an owned private synthetic database (`model_test`, user `postgres`, password `synthetic`) with a bounded query timeout; no default host is accepted.

```sh
NEUTRAL_DB_HOST=your-owned-synthetic-db NEUTRAL_RESULT_FILE=result.json node examples/scoped-list-legality/verify.cjs
```

The verifier executes VALUES-only SELECT statements and closes its connection. It does not start engines, write tables or contact a customer. The test database had a 15-second statement timeout; client timeout is 20 seconds. No speedup benchmark is appropriate because no runtime optimization is implemented.

## Consumers and remaining dependency

Offered-list normalization → join/correlation/security tree → constant versus fact-sensitive projection → DISTINCT/grouping/ordering → offered keys → client metadata/list cache. Any optimization must preserve each contract. Security predicates remain mandatory outside business OR. Supported NULL/empty-fact behavior must not be narrowed, and fact-sensitive aggregates/projections must be rejected or separately proven.

These examples build on established legality findings rather than rerunning a large investigation. They do not establish a native slicer fix, customer population equality, all database-dialect behavior or ClickHouse settings compatibility. A later integration must test its actual dialect and NULL-extension settings. Gateway timeouts, end-date failures and native DAX lowering are separate issues.

**REPRO_AND_LEGALITY_ONLY — OPTIMIZATION_NOT_IMPLEMENTED**. Keep the cold-list performance gap open. No deployment, new PR or customer acceptance is included.
