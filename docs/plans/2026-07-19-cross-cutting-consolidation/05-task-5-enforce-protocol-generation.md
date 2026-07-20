# Task 5 — Enforce protocol generation and consumer migration

**Status:** Planned follow-on work
**Parent context:** [Cross-cutting consolidation implementation guide](README.md), Task 5
**Prerequisites:** Tasks 0 and 4 establish the baseline, generated-artifact,
and source-manifest checks that this task extends.

## Intended outcome

One typed observer-protocol registry generates the shared TypeScript, Markdown,
JSON, Game Enforce, and WorkbenchGame Enforce vocabulary. The runtime observer,
Workbench observer, and host adapter consume generated symbols while preserving
their intentionally distinct protocol identities and numeric tuning values.

## Planned work

1. Move shared job states and protocol values into the canonical typed
   registry, with an explicit ledger for target-specific values.
2. Generate literal-only Enforce contract classes for both add-ons and JSON
   suitable for static drift checks.
3. Migrate observer consumers and host-adapter validation from hand-spelled
   shared vocabulary to generated symbols.
4. Fail protocol checks for stale generated C before compilation, then validate
   both Game and WorkbenchGame targets in a controlled environment.
5. Regenerate source manifests and verify package contents after generated C
   changes.

## Completion signals

- A single registry edit regenerates every shared protocol artifact.
- Generated-C, registry, and semantic-consumer drift fail independently.
- Both targets compile when the controlled Enforce environment is available.
- Distinct target-specific tuning remains explicit and covered by its own
  acceptance evidence.


## Detailed task plan

**Goal:** Use the successful protocol-artifact generator to prevent the Game,
WorkbenchGame, and host observer adapter from drifting in vocabulary.

**Primary files:**

- observer/protocol/constants.ts, observer/protocol/registry.ts, and a new
  observer/protocol/enforce-contract.ts;
- scripts/generate-protocol-artifacts.ts;
- scripts/validate-observer-enforce.mjs;
- a static Enforce-contract validator;
- generated vocabulary C files in both add-ons;
- runtime observer C sources, Workbench observer C sources, and
  src/workbench/observer-adapter.ts;
- protocol-artifact, package-contract, and Enforce validation tests.

**Actions:**

1. Move the hard-coded job-state list presently embedded in schema rendering
   into a typed canonical value. Derive schemas, TypeScript constants,
   Markdown, host adapter vocabulary, and both C outputs from it.
2. Add enforce-contract.ts, derived from the existing constants and registry.
   It identifies which values are shared, which are target-specific, and why
   any numeric tuning value remains target-specific. Keep the runtime observer
   protocol, Workbench observer-adapter protocol, and helper-bundle protocol
   as distinct identities.
3. Render one literal-only class for each target:
   - RFO_ObserverProtocol in the Game add-on;
   - EMCP_WB_ObserverProtocol in the Workbench helper add-on;
   - observer/protocol/generated/enforce-contract.json for static validators
     that should not parse TypeScript.
4. Migrate raw protocol/error/capability/state/directory literals in the
   observer portions of both add-ons. For example, the runtime enum-to-name
   switch returns generated state constants, and the Workbench terminal-state
   test compares against generated constants.
5. Migrate host adapter protocol validation and generated artifact-path
   expectations to the registry-derived TypeScript vocabulary. Do not make the
   host parse C sources at runtime.
6. Preserve the current distinct matrix/input tolerances in the
   target-specific tuning ledger. Runtime camera validation uses 0.001,
   Workbench restoration comparison uses 0.0001, and a separate Workbench
   input-validation path uses 0.001; they have different semantics. A
   cosmetic "make the numbers match" edit is not acceptable.
7. Extend protocol check so stale or modified generated C fails exactly as
   stale JSON/schema/Markdown does. Run that check before Enforce compilation.
8. Add a cross-platform static validator that reads the generated JSON,
   confirms both C files exactly match generation, and checks known semantic
   consumers use generated symbols. Do not use a blanket literal ban; comments,
   JSON field names, and unrelated engine values would produce false positives.
9. Extend validate-observer-enforce.mjs with a protocol-only mode and runtime,
   Workbench, or both target selection. It reports registry/C drift separately
   from compilation. The current runtime-only compile is insufficient:
   compilation of both target modules proves each generated class is included
   and usable by Enforce.
10. Regenerate both source manifests after generated C changes and verify the
   package contains those exact files.

**Tests:**

- generator unit tests cover C escaping, class names, registry insertion order,
  terminal-state derivation, and intentionally divergent tuning values;
- drift tests modify generated C, a C consumer literal, and a registry entry
  independently and prove the right check fails;
- source/host contract tests prove adapter protocol and artifact-directory
  expectations come from the registry-derived vocabulary;
- run the real Enforce compiler/acceptance path for both Game and WorkbenchGame
  when the controlled environment is available.

**Acceptance:** A canonical protocol-model edit produces every dependent
artifact in one generation step. Both add-ons compile, their manifests are
current, and no
shared observer vocabulary is hand-spelled outside generated files or the
explicit backend-tuning ledger.
