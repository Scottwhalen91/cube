# Existing hierarchy exposure

This configuration example declares a three-level product hierarchy and a separate sector hierarchy using existing Core hierarchy declarations, explicit view inclusion, aliases and prefixing. It adds no Core schema or runtime feature. The base is `331b87984939cf585db4675ebc0b6ec228faa503`.

The source already contains hierarchy/view compilation and metadata projection (`hierarchies.test.ts` and its fixtures). Reusing that contract is simpler than a second hierarchy schema or synthetic level generation. Adding an object need not change ordinary field queries, totals or SQL; that is tested rather than assumed. Native BI discovery is an adapter responsibility and is not established by REST metadata.

`model.yml` contains only synthetic VALUES data. The full view explicitly includes each level; the limited view declares an existing two-level hierarchy and omits leaf/sector members. Existing access policies restrict the full view to the reader group. Source cubes are private. No client marker or private-protocol field is added.

The verifier checks ordered levels, view aliases, prefixing, exclusion and inheritance; exact field-query SQL/parameters with hierarchies enabled versus absent in both planners; the real public metadata endpoint; role-restricted metadata and denial of a full-view load; and complete responses including zero, NULL/ragged values, lists and totals. Only `lastRefreshTime` is normalized. Four field queries produce eight planner SQL comparisons and four complete service comparisons. The five existing hierarchy unit cases also pass. See `validation-summary.json` for hashes and counts.

## Reproduce

Build Core's packages and native module from this base and unchanged lockfiles, or use matching hash-verified artifacts from this exact source. Node 22.23.3, Yarn 1.22.22, Rust 1.98.1 and PostgreSQL 12.22 were used. This example changes no runtime source, so the previously built matching base artifact was reused, not rebuilt against unrelated code.

```sh
NEUTRAL_DB_HOST=your-owned-synthetic-db NEUTRAL_RESULT_FILE=result.json node examples/hierarchy-exposure/verify.cjs
```

The database is `model_test`, user `postgres`, password `synthetic`; no default host is provided. Use private networking and a bounded query timeout. The runner closes its HTTP listeners, pools and timers before explicit test-process exit. Run the compiler package's compiled `hierarchies.test.js` with the repository Jest command and `--runInBand --coverage=false --forceExit`.

## Production dependency and disposition

Model declaration → view inclusion/alias identity → public metadata → native adapter discovery → client hierarchy UI. Only the first three and ordinary queries are validated here. Configuration does not grant access: existing group/policy/member boundaries remain required. Do not expose a restricted member by including its full hierarchy accidentally; explicitly choose the allowed hierarchy and its levels as demonstrated.

The reusable benefit is a working configuration and regression starter without another engine capability. This eliminates redundant public Core implementation. A native surface that does not project this existing metadata still needs integration work; do not label the BI hierarchy request delivered on this evidence.

**EXISTING_CONFIGURATION_VALIDATED — NATIVE_DISCOVERY_PENDING**. No PR, deployment, native discovery or customer acceptance is included. There is no runtime optimization to benchmark; query SQL/parameters and complete responses are unchanged by the declaration.
