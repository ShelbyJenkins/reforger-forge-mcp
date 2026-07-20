# Enforce protocol generation and consumer migration implementation guide

**Status:** Proposed follow-on work
**Parent context:** [Cross-cutting consolidation implementation guide](README.md), Task 5
**Research snapshot:** 2026-07-19, against the active working tree
**Prerequisites:** Task 0's behavior baseline and Task 4's generated-artifact
and source-manifest checks are available. Do not merge this task until Task 4
makes manifests the sole maintained add-on inventories.

## Outcome

One typed TypeScript protocol model becomes the only source for observer
vocabulary that crosses the host, runtime Game add-on, and WorkbenchGame
helper boundaries. A single generation pipeline produces the existing JSON,
schemas, and Markdown artifacts plus two literal-only Enforce constant
classes and a machine-readable Enforce contract descriptor.

The migration removes hand-spelled shared state names, error codes,
capabilities, protocol identifiers, and reviewed directory-name segments from
the observer consumers. It deliberately does **not** merge the Game and
WorkbenchGame modules, collapse their protocol identities, or make their
independent camera tolerances appear equivalent.

The resulting dependency path is:

~~~text
constants.ts + registry.ts
          |
          v
  enforce-contract.ts (typed ownership and target ledger)
          |
          +--> TypeScript host vocabulary
          +--> JSON schemas and Markdown
          +--> enforce-contract.json
          +--> RFO_ObserverProtocol.c       (Game)
          +--> EMCP_WB_ObserverProtocol.c   (WorkbenchGame)
          |
          v
 source-manifest generation -> package verification -> controlled Enforce checks
~~~

## Scope and fixed decisions

1. **Generate values, never cross-module Enforce code.** The Game and
   WorkbenchGame add-ons receive separately generated classes. Neither module
   imports, includes, nor references the other's class.
2. **Keep the existing protocol model authoritative.**
   `observer/protocol/constants.ts` owns scalar observer constants and
   `observer/protocol/registry.ts` owns the error and capability registries.
   The new `observer/protocol/enforce-contract.ts` is a typed, derived
   declaration of what may be emitted for each target. Generated C, JSON,
   schemas, Markdown, and adapter constants are outputs, not alternate sources
   of truth.
3. **Keep these identities distinct.** The runtime observer protocol is
   `1.0`; the Workbench observer-adapter protocol is
   `reforger-forge-workbench-observer/1`; and the Workbench helper-bundle
   protocol is `2.0` in `RFWB_HelperBuild.c` and
   `src/workbench/helper-addon.ts`. They are not aliases and must never be
   represented by one generic `PROTOCOL_VERSION` field.
4. **Generate only values with intentional cross-boundary equivalence.** A
   target receives only the states, codes, capabilities, path segments, and
   numeric values that its protocol-facing consumer needs. Target-local
   implementation tuning stays local.
5. **Make target-specific tuning explicit.** The contract contains a reviewed
   ledger explaining every intentionally divergent numeric value. At minimum,
   it records the runtime camera-projection matrix tolerance (`0.001`), the
   Workbench restoration matrix comparison (`0.0001`), and the separate
   Workbench matrix-input validation tolerance (`0.001`). The shared value is
   not the same thing as the same-looking number.
6. **Emit literal-only Enforce declarations.** Generated classes contain a
   header and `static const string`, `int`, or `float` fields only. Do not emit
   arrays, maps, methods, dynamic initialization, inheritance, or helper code
   unless an Enforce consumer has a reviewed need for it.
7. **Preserve local state-machine representations.** `RFO_ObserverJobState`
   remains a Game implementation enum. The generated Game class supplies its
   protocol string names, not a replacement enum or transition engine.
8. **Use narrowly scoped static checks.** The validator may inspect known
   generated files and named semantic consumers. It must not become a blanket
   ban on quoted strings, numeric literals, comments, JSON field names, or
   unrelated Enfusion values.
9. **Check generated artifacts before compilation.** Any target validation
   first reports registry-to-artifact or JSON-to-C drift. A successful compiler
   exit never compensates for stale generated source.
10. **Source manifests remain the package inventory authority.** The two
    generated C files are ordinary declared source payloads. Regenerate the
    manifests after protocol artifacts; do not add copied filename lists to
    staging, package checks, or tests.
11. **Keep host runtime behavior unchanged.** The change is vocabulary
    consolidation. Public error codes, transition rules, ownership checks,
    capture/recovery behavior, and adapter transport semantics must retain
    their existing meaning.
12. **Generation is deterministic and reviewable.** Given the same canonical
    registry, the generator writes byte-identical UTF-8/LF artifacts in stable
    registry insertion order. It must not read the clock, environment, or a
    live Workbench installation.

## Non-goals

- Do not merge Game and WorkbenchGame scripts or introduce a shared Enforce
  library.
- Do not make the runtime protocol, observer-adapter protocol, and helper
  bundle protocol share a version number.
- Do not change error semantics, capability proofs, or job transitions merely
  to make generation convenient.
- Do not normalize `0.0001` and `0.001` tolerances without separate
  restoration/capture acceptance evidence.
- Do not generate `RFWB_HelperBuild.c` from this contract. Its identity is
  deliberately generated by the helper-bundle/manifest path and is verified
  through the existing helper staging contract.
- Do not parse generated C at host runtime. The host imports the typed
  TypeScript contract; C inspection is a build-time check only.
- Do not claim controlled Workbench compilation or mailbox acceptance passed
  when that environment was unavailable.

## Starting-point inventory

At the start of implementation, rerun and record the following output in the
review. Counts are characterization evidence, not a permanent contract.

~~~powershell
rg -n 'PROTOCOL_VERSION|JOB_STATES|TERMINAL_JOB_STATES|ERROR_CODES|CAPABILITIES|SESSION_DIRECTORY_NAME|SESSION_CONTRACT_NAME' observer/protocol
rg -n '"(completed|failed|cancelled|accepted|capturing|restoring)"|"[A-Z][A-Z0-9_]+"|"(render\.capture|camera\.editor|camera\.runtime)"' observer/addon/Scripts/Game/ReforgerForgeObserver observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP src/workbench/observer-adapter.ts -g '*.c' -g '*.ts'
rg -n 'ADAPTER_PROTOCOL|TERMINAL_STATES|reforger-forge-workbench-observer' src/workbench observer scripts -g '*.ts'
rg -n 'RFWB_HelperBuild|WORKBENCH_HELPER_PROTOCOL_VERSION' src/workbench observer/workbench-addon scripts tests -g '*.ts' -g '*.mjs' -g '*.c'
npm run protocol:check
~~~

The current implementation has these important seams:

| Concern | Current owner/seam | Migration result |
| --- | --- | --- |
| Runtime constants and job vocabulary | `observer/protocol/constants.ts` | Canonical input plus derived Enforce contract |
| Error and capability metadata | `observer/protocol/registry.ts` | Canonical input plus target-filtered fields |
| Existing generated artifacts | `scripts/generate-protocol-artifacts.ts` | Extended deterministic renderer and drift check |
| Game wire-state strings | `RFO_ObserverJob.c`, especially `StateName()` | `RFO_ObserverProtocol.STATE_*` constants |
| Game error/capability/protocol literals | session, service, transport, and capabilities sources | `RFO_ObserverProtocol.*` fields where the value is protocol-owned |
| Workbench adapter protocol/state/error literals | `EMCP_WB_ObserverCommon.c` | `EMCP_WB_ObserverProtocol.*` fields |
| Host adapter schemas and terminal-state set | `src/workbench/observer-adapter.ts` | Imports contract-derived TypeScript values |
| Helper-bundle identity | `src/workbench/helper-addon.ts` and generated `RFWB_HelperBuild.c` | Remains independent and explicitly cross-checked |
| Existing compiler gate | `scripts/validate-observer-enforce.mjs` | Protocol-only drift mode plus runtime/workbench/both targets |
| Payload inclusion | two source manifests and Task 4 inventory consumers | Generated C declared by manifests, not copied lists |

## Protocol identity and ownership model

Use distinct named values in the typed contract. This table is the minimum
reviewer-facing proof that a migration has not silently conflated protocols.

| Identity | Canonical owner | Consumers | Must not be substituted with |
| --- | --- | --- | --- |
| Runtime observer protocol (`1.0`) | `observer/protocol/constants.ts` | Runtime schemas, Game add-on, host runtime agent | Adapter or helper-bundle protocol |
| Workbench observer-adapter protocol (`reforger-forge-workbench-observer/1`) | `enforce-contract.ts`, derived from a named canonical constant | Workbench C handler responses and `observer-adapter.ts` | Runtime or helper-bundle protocol |
| Helper-bundle protocol (`2.0`) | `src/workbench/helper-addon.ts` | `RFWB_HelperBuild.c`, ping/readiness/session lifecycle | Runtime or observer-adapter protocol |

`enforce-contract.ts` may reference the helper-bundle identity in its
descriptor and tests to show the distinction, but it must not take ownership
of it or cause a normal observer-vocabulary regeneration to rewrite
`RFWB_HelperBuild.c`.

### Contract shape

Use a small declarative shape that is easy to validate and render. Exact names
may differ, but preserve the ownership boundary and target filters:

~~~ts
type EnforceTarget = "game" | "workbench";

interface EnforceStringValue {
  readonly field: string;
  readonly value: string;
}

interface EnforceNumberValue {
  readonly field: string;
  readonly value: number;
  readonly kind: "int" | "float";
}

interface BackendTuningEntry {
  readonly owner: "runtime" | "workbench";
  readonly source: string;
  readonly value: number;
  readonly reason: string;
  readonly acceptance: string;
}

interface EnforceTargetContract {
  readonly className: string;
  readonly outputPath: string;
  readonly strings: readonly EnforceStringValue[];
  readonly numbers: readonly EnforceNumberValue[];
}

interface ObserverEnforceContract {
  readonly identities: {
    readonly runtimeObserver: string;
    readonly workbenchAdapter: string;
    readonly workbenchHelperBundle: string;
  };
  readonly targets: Readonly<Record<EnforceTarget, EnforceTargetContract>>;
  readonly backendTuning: readonly BackendTuningEntry[];
}
~~~

The actual values should be built from named exports, `JOB_STATES`,
`TERMINAL_JOB_STATES`, `ERROR_REGISTRY`, and `CAPABILITY_REGISTRY`; do not copy
their contents into a new array. The declaration should make it obvious why a
member is included and which target receives it.

Use predictable field names such as:

~~~text
RUNTIME_PROTOCOL_VERSION
ADAPTER_PROTOCOL
STATE_ACCEPTED
STATE_AWAITING_ARTIFACT
STATE_COMPLETED
ERROR_RESTORATION_UNCONFIRMED
CAP_RENDER_CAPTURE
DIRECTORY_SESSION_ROOT
FILE_SESSION_CONTRACT
~~~

The renderer derives uppercase field suffixes from the canonical values. It
must reject an invalid field name or collision rather than "fixing" it with an
unstable suffix. For example, two capability names that both map to
`CAP_RENDER_CAPTURE` are a generation error.

### Target membership

Build target membership from protocol semantics, not from convenience:

- The **Game** class receives the runtime observer protocol, all job-state
  strings, terminal-state strings, runtime-emittable error codes, runtime
  capabilities, and runtime-owned session directory/file segments.
- The **WorkbenchGame** class receives the observer-adapter protocol, all
  job-state strings used by its handler responses, terminal-state strings,
  Workbench-emittable error codes, Workbench capabilities, and the reviewed
  observer capture-directory segment if it is truly shared protocol
  vocabulary.
- A code that belongs to both backends is emitted in both classes. A code that
  only the host may synthesize is not injected into an Enforce module merely
  because it appears in the global registry.
- The helper-bundle version does not appear as an ordinary observer-adapter
  constant. The existing generated helper build class remains the compiled
  source of that value.

If a currently emitted Game or Workbench code is absent from the filtered
registry, stop and correct the registry ownership before migrating the
consumer. Do not make the generator silently widen a target's vocabulary.

### Backend-tuning ledger

Keep numeric policy out of the generic string vocabulary. The first ledger
entries should be explicit enough for a future reviewer to know why equality
is unsafe:

| Owner | Current value | Source | Meaning | Required evidence before change |
| --- | ---: | --- | --- | --- |
| Runtime | `0.001` | `RFO_ObserverCameraProjection.c` | Runtime camera-projection matrix comparison | Runtime capture/restoration acceptance |
| Workbench | `0.0001` | `EMCP_WB_ObserverCommon.c` | Exact Workbench restoration matrix comparison | Workbench editor-camera restoration acceptance |
| Workbench | `0.001` | `EMCP_WB_ObserverCommon.c` | Submitted matrix orthonormality/input validation | Workbench invalid-input acceptance |

The JSON descriptor contains this ledger for review and static validation. It
does not require those values to be emitted into both classes. Keep each
numeric literal in its current backend owner until the acceptance evidence
explicitly supports a shared protocol value.

## Generated artifact contract

Extend `PROTOCOL_ARTIFACT_PATHS` so every generated artifact has one checked
in path and participates in `renderProtocolArtifacts`,
`writeProtocolArtifacts`, and `findProtocolArtifactDrift`:

~~~text
observer/protocol/generated/enforce-contract.json
observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverProtocol.c
observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_ObserverProtocol.c
~~~

Each generated C file begins with a stable provenance header naming
`npm run protocol:generate` and `observer/protocol/enforce-contract.ts`. It
uses the repository's Enforce formatting style and ends with one LF. A typical
output is intentionally boring:

~~~c
// Generated by npm run protocol:generate from observer/protocol/enforce-contract.ts. Do not edit.
class RFO_ObserverProtocol
{
	static const string RUNTIME_PROTOCOL_VERSION = "1.0";
	static const string STATE_COMPLETED = "completed";
	static const string ERROR_RESTORATION_UNCONFIRMED = "RESTORATION_UNCONFIRMED";
	static const string CAP_RENDER_CAPTURE = "render.capture";
}
~~~

The Workbench class has the same literal-only layout with class name
`EMCP_WB_ObserverProtocol`. It may have a different member subset. Do not
create an include file, a shared base class, or generated methods such as
`IsTerminal`; the call site retains its own control flow and references the
generated literal fields.

### Rendering requirements

1. Preserve registry insertion order for registry-derived members. Use a
   separately documented fixed order for scalar identity and directory fields.
2. Escape Enforce string literals correctly for quotes, backslashes, CR, LF,
   and control characters. Reject NUL or values that cannot be represented
   safely; a generated C source must never be malformed by a protocol edit.
3. Render integer literals only from finite safe integers. Render float
   literals with a deterministic decimal representation that Enforce accepts,
   including a decimal point where required.
4. Reject duplicate field names, duplicate target output paths, an unsupported
   class name, an empty target vocabulary, or a numeric field without an
   explicit ledger/ownership decision.
5. Produce JSON that contains the exact target member lists, all three
   identities, the terminal-state subset, and the backend-tuning ledger. The
   static validator must be able to verify C from this JSON without importing
   TypeScript.
6. Do not make generated C depend on a particular checkout path, line ending,
   locale, or installed Workbench version.

## Implementation tasks

### P5-0: freeze behavior and define the migration allowlist

1. Run the starting-point inventory and the existing protocol, package, and
   focused observer/Workbench tests. Record the current protocol values,
   terminal-state subset, error/capability membership, and current literal
   locations in the review.
2. Add characterization tests for the runtime protocol (`1.0`), adapter
   protocol (`reforger-forge-workbench-observer/1`), and helper-bundle protocol
   (`2.0`). Each test must fail if any two are accidentally coupled.
3. Establish a named semantic-consumer allowlist for the first migration:
   `RFO_ObserverJob.c`, `RFO_ObserverSession.c`,
   `RFO_ObserverService.c`, `RFO_ObserverCapabilities.c`, relevant runtime
   transport sources, `EMCP_WB_ObserverCommon.c`, the observer handler files,
   `src/workbench/observer-adapter.ts`, and the two observer acceptance
   scripts that locally reproduce the terminal-state set.
4. Classify every matched literal as one of: generated protocol vocabulary,
   backend tuning, engine/API token, local diagnostic, JSON field name, or
   unrelated implementation value. Only the first category belongs in this
   task's migration.
5. Do not start C edits until the generator can render all new artifacts in a
   temporary root and unit tests describe their expected shape.

**Acceptance:** The review has an auditable, finite migration set. Existing
behavior and the three independent protocol identities are characterized before
any consumer changes.

### P5-1: add the derived typed Enforce contract

1. Create `observer/protocol/enforce-contract.ts`. Import named canonical
   values and registries; use types and exhaustive construction to prevent a
   new registry member from becoming invisible by accident.
2. Export named host-facing values/selectors for the adapter, such as the
   Workbench adapter protocol, terminal state tuple, and target-filtered
   error/capability vocabulary. `src/workbench/observer-adapter.ts` must not
   retain a private duplicate of `ADAPTER_PROTOCOL` or terminal strings.
3. Model the Game and Workbench targets explicitly, with their intended class
   names and generated output paths. Assert at module construction/test time
   that a target's fields are unique and every target-filtered registry entry
   has a stable field name.
4. Add the backend-tuning ledger and comments that name its source, semantic
   purpose, and acceptance proof. Keep the numeric values in their existing C
   owners unless they meet the shared-value rule.
5. Keep helper-bundle identity represented only as an independently owned
   descriptor field. Importing it from `helper-addon.ts` would reverse the
   dependency direction, so use a deliberate type-level/documented assertion
   or a contract test instead of making the observer protocol package depend
   on Workbench lifecycle code.

**Acceptance:** The contract can answer, deterministically, which literal
members each target receives, why each numeric value is local or shared, and
which of the three protocol identities a consumer is using.

### P5-2: extend deterministic protocol generation

1. Extend `ProtocolRegistrySource` or introduce a compatible source parameter
   so generator unit tests can supply a small synthetic registry plus contract
   fixture. Do not make tests mutate the production registry.
2. Add renderers for the JSON descriptor and each C class. Register their
   paths in `PROTOCOL_ARTIFACT_PATHS` in a stable, documented order.
3. Make `renderProtocolArtifacts()` produce all artifacts from one in-memory
   model. `writeProtocolArtifacts()` and `findProtocolArtifactDrift()` must
   automatically include the new outputs.
4. Maintain `npm run protocol:generate` as the focused protocol renderer and
   add, if needed, one explicit orchestration command such as
   `npm run observer:generate` that runs protocol generation followed by
   manifest generation. A single canonical edit must have one documented
   command that refreshes every checked-in dependent artifact.
5. Keep check commands non-mutating. `npm run protocol:check` reports every
   stale JSON, schema, Markdown, and C file without rewriting the checkout.
6. Ensure a modified generated C file appears by its exact path in the drift
   output, just as a modified schema does today.

**Acceptance:** A canonical test-model edit changes the descriptor, C
artifacts, and existing registry-derived artifacts in deterministic order; a
second run produces no diff.

### P5-3: migrate TypeScript host and acceptance consumers first

1. Replace `src/workbench/observer-adapter.ts`'s local adapter protocol
   literal and `TERMINAL_STATES` construction with imports from the typed
   contract. Its Zod response schemas, lifecycle gate release, release checks,
   and error mapping retain their present behavior.
2. Replace only registry-owned capability/error literals in adapter validation
   with contract-derived symbols. Leave PNG chunk tags, CRC details, NET API
   handler names, MCP diagnostics, and adapter-local errors alone unless they
   are explicitly promoted into the protocol model.
3. Update `scripts/run-workbench-observer-acceptance.ts` and
   `scripts/run-runtime-observer-acceptance.ts` to import the canonical
   terminal-state tuple instead of maintaining their own terminal sets. Keep
   their polling/deadline behavior out of scope.
4. Update source and host contract tests to assert imports/semantic behavior,
   not the old text spelling. For example, test that a terminal `completed`,
   `failed`, or `cancelled` response still releases the activity gate only when
   restoration is proven.
5. Confirm that host code still treats `RFWB_HelperBuild` readiness protocol
   through `WORKBENCH_HELPER_PROTOCOL_VERSION`, not through the adapter
   vocabulary.

**Acceptance:** The host has no independent observer-adapter protocol or
terminal-state vocabulary, while helper readiness still uses the distinct
helper-bundle identity.

### P5-4: migrate Game Enforce protocol vocabulary

1. Add the generated `RFO_ObserverProtocol.c` to the Game add-on source tree
   and ensure it is loaded by the normal Game script discovery path.
2. In `RFO_ObserverJob.c`, retain `RFO_ObserverJobState` and transition
   control flow. Replace wire-name returns in `StateName()` with
   `RFO_ObserverProtocol.STATE_*` fields, including the queued fallback. Keep
   enum names as local implementation identifiers.
3. Replace runtime protocol-version comparisons and JSON response fields in
   `RFO_ObserverSession.c`, `RFO_ObserverService.c`, and the JSON/transport
   sources with the generated runtime protocol field where they represent the
   public observer protocol.
4. Replace runtime-emitted error-code strings with generated `ERROR_*` fields
   in the service and related transport/error paths. Do not replace a local
   diagnostic sentence or an engine error token merely because it is quoted.
5. Replace runtime capability strings in `RFO_ObserverCapabilities.c` with
   `CAP_*` fields. Preserve each capability's readiness/proof logic.
6. Replace the reviewed session root and contract filename literals only where
   they are shared wire/profile vocabulary. Do not move arbitrary filesystem
   layout or implementation-only temporary names into the protocol class.
7. Keep camera projection, near/far-plane, and input-validation numerical
   comparisons unchanged. The ledger documents them; it does not authorize a
   numerical refactor.

**Acceptance:** Runtime status, heartbeat, command, and artifact wire values
are byte-for-byte compatible, but their shared vocabulary comes from
`RFO_ObserverProtocol` rather than repeated literals.

### P5-5: migrate WorkbenchGame Enforce protocol vocabulary

1. Add the generated `EMCP_WB_ObserverProtocol.c` beside the existing
   Workbench observer files and ensure it is included by the helper add-on's
   normal WorkbenchGame resource discovery.
2. In `EMCP_WB_ObserverCommon.c`, replace the service adapter protocol literal
   with `EMCP_WB_ObserverProtocol.ADAPTER_PROTOCOL`.
3. Replace `EMCP_WB_ObserverJob.IsTerminal()`'s string comparisons and the
   observer handler response state strings with `STATE_*` fields. Do not add a
   generated terminal-state method; keep local control flow transparent.
4. Replace Workbench-owned shared error and capability literals with the
   target class's `ERROR_*` and `CAP_*` fields. Preserve the existing behavior
   for private handler failures and engine diagnostics that are not registry
   values.
5. Leave `MATRIX_EPSILON = 0.0001` and the `0.001` matrix-input checks in
   their current source locations. Add comments linking them to the ledger if
   that makes the distinction clearer, but do not replace them with a falsely
   shared constant.
6. Do not change `RFWB_HelperBuild.c`, `EMCP_WB_Ping.c` helper identity
   fields, or their readiness checks except for tests that prove they stay
   independent from observer-adapter generation.

**Acceptance:** Workbench observer handler responses remain protocol
compatible, and all generated-value consumers compile in the WorkbenchGame
module without relying on Game code.

### P5-6: add static protocol and semantic-consumer validation

Implement a cross-platform, repository-only validator, for example
`scripts/validate-observer-enforce-contract.mjs`. It reads
`observer/protocol/generated/enforce-contract.json` and the generated C
files; it does not parse TypeScript or need a Workbench installation.

Its checks are intentionally layered:

1. Validate the JSON descriptor's shape, version, target paths, distinct
   identity values, unique member fields, target membership, terminal-state
   subset, and tuning-ledger entries.
2. Render or parse the expected literal-only C declaration from the descriptor
   and require exact normalized bytes for the selected generated C file. This
   proves JSON-to-C agreement independently of source-registry drift.
3. Verify only the named semantic consumers from P5-0. Examples include the
   Game `StateName()` mappings, Game capability insertion calls, runtime
   emitted error-code paths, Workbench `IsTerminal()`, Workbench adapter
   protocol response, and TypeScript adapter contract imports. Each check
   should state the violated contract and expected generated symbol.
4. Reject a known raw literal only at its documented consumer seam. A matching
   comment, JSON key, engine token, or backend-tuning entry must not fail the
   check.

Extend `scripts/validate-observer-enforce.mjs` with:

~~~text
--protocol-only
--target runtime|workbench|both
~~~

`--protocol-only` runs the static descriptor/C/consumer checks and performs no
Workbench launch. Normal compilation mode runs the protocol check first, then
compiles the selected target(s). A `both` run must compile the Game add-on and
the Workbench helper add-on separately, with separately attributed output and
clear reporting for drift versus compiler failures. Preserve the current
runtime compile evidence format where possible; extend it rather than
overwriting one target's facts with the other's.

Suggested failure categories:

~~~text
PROTOCOL_SOURCE_DRIFT       protocol:check found a stale checked-in artifact
ENFORCE_DESCRIPTOR_DRIFT    JSON descriptor and generated C disagree
ENFORCE_CONSUMER_DRIFT      named consumer still bypasses a generated symbol
ENFORCE_RUNTIME_COMPILE     Game module failed or was not proven to compile
ENFORCE_WORKBENCH_COMPILE   WorkbenchGame module failed or was not proven to compile
~~~

**Acceptance:** A reviewer can tell whether a failure is caused by canonical
source drift, C/JSON drift, an unmigrated consumer, or one specific compiler
target.

### P5-7: regenerate manifests and prove package inclusion

1. Run the documented generation order after every contract or C output
   change:

   ~~~text
   npm run protocol:generate
       -> npm run observer:manifest
       -> npm run protocol:check
       -> npm run observer:manifest:check
       -> npm run test:package
   ~~~

   Until Task 4 adds `observer:manifest:check`, use its current non-mutating
   equivalent and record the limitation.
2. Confirm the Game manifest declares
   `Scripts/Game/ReforgerForgeObserver/RFO_ObserverProtocol.c` and the
   Workbench manifest declares
   `Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_ObserverProtocol.c` with current
   digests.
3. Keep the special `RFWB_HelperBuild.c` generation/exclusion flow intact.
   The new Workbench protocol class is an ordinary manifest payload, not a
   second generated-resource exception.
4. Remove or avoid every hard-coded package/staging/test filename list made
   obsolete by Task 4. Retain semantic assertions that the generated classes
   are present and used.
5. Verify the packed tarball, rather than the source checkout, contains both
   generated C files and manifests that declare them.

**Acceptance:** An altered or omitted generated C file fails protocol drift,
manifest validation, or packed-tarball verification before a release can use
it.

### P5-8: run controlled Enforce and behavior acceptance

1. Run `npm run observer:validate:enforce -- --protocol-only --target both`
   on every platform supported by ordinary CI.
2. In a controlled Windows environment with the required add-on roots and
   Workbench installation, run
   `npm run observer:validate:enforce -- --target both`. Record Workbench
   version, selected configuration, target-specific compiler evidence, and
   artifact location outside the repository.
3. Run `npm run observer:acceptance:enforce-mailbox` when that environment is
   available. This behavioral acceptance complements compilation; it does not
   prove Workbench camera restoration.
4. Run the focused Workbench observer acceptance suite where it can prove
   terminal states, adapter protocol, and restoration behavior remain stable.
5. Treat an unavailable controlled environment as `not run`, never as a pass.

**Acceptance:** Both generated classes are syntactically usable in their own
Enforce modules, and the existing runtime/Workbench behavior evidence still
matches the unchanged protocol contract.

## Test plan

Add focused tests before or alongside each implementation phase. The suite
should distinguish renderer defects, stale artifacts, consumer migration
defects, and compiler availability.

| Area | Required proofs |
| --- | --- |
| Derived contract | Target membership derives from registries; all three identities differ; terminal subset derives from `TERMINAL_JOB_STATES`; target-local tuning remains explicitly local. |
| C renderer | Correct class names/paths/header; deterministic field order; C escaping; stable float/int rendering; invalid identifiers, duplicate fields, collisions, and unsupported scalar values fail closed. |
| Existing artifacts | A synthetic registry edit changes schema/JSON/Markdown plus descriptor/C outputs; a second render is byte-identical. |
| Source drift | Editing, deleting, or not generating either C file causes `findProtocolArtifactDrift` and `npm run protocol:check` to identify the exact path. |
| JSON-to-C drift | Changing descriptor JSON, one generated C member, class name, or header independently fails the static validator with `ENFORCE_DESCRIPTOR_DRIFT`. |
| Consumer drift | Reintroducing a raw state, error, capability, or adapter-protocol literal at one named consumer fails only the relevant semantic-consumer rule. A comment, JSON key, PNG tag, and tuning literal remain permitted. |
| Host behavior | Adapter Zod schemas use contract-derived protocol values; terminal/recovery activity gates preserve present behavior; helper readiness still validates helper protocol separately. |
| Game behavior | `StateName()` returns the same wire values; runtime errors/capabilities remain allowed by the registry; session/response protocol values stay `1.0`. |
| Workbench behavior | Handler responses use the unchanged adapter protocol; terminal detection and restoration gate behavior are unchanged; target-specific tolerances retain their current values. |
| Inventory/package | Both C outputs are manifest-declared, staged, and present in the inspected package tarball; an undeclared or modified C payload fails. |
| Controlled compilation | Runtime and WorkbenchGame targets are separately compiled and reported; an unavailable environment is reported as such. |

Avoid snapshot-only C tests. Assert the provenance header, class name, exact
field-to-value map, and absence of disallowed executable constructs. This makes
an intentional vocabulary addition easy to review without hiding an accidental
source-format change.

## Validation sequence

Run checks in this order while implementing, then run the full relevant set
before declaring the task complete:

~~~powershell
npm run protocol:generate
npm run protocol:check
npm run observer:manifest
npm run observer:manifest:check
npm run observer:validate:enforce -- --protocol-only --target both
npm run build
npm test
npm run test:package
~~~

The manifest check is supplied by Task 4; use the pre-Task-4 equivalent only
until that work is merged. In a controlled Windows/Workbench environment, add:

~~~powershell
npm run observer:validate:enforce -- --target both
npm run observer:acceptance:enforce-mailbox
~~~

Record controlled compiler and live-acceptance evidence externally or in an
ignored local artifact directory. Do not commit machine paths, profile paths,
logs containing secrets, or temporary build output.

## Review and rollout plan

Keep the review boundary narrow enough that behavior and generated changes can
be inspected together:

1. **Contract and renderer:** `enforce-contract.ts`, generator extension,
   JSON/C artifacts, deterministic unit tests, and no consumer migration.
2. **Host and Game migration:** TypeScript adapter/acceptance imports, Game
   vocabulary consumers, focused behavior tests, and static validator rules.
3. **Workbench migration:** WorkbenchGame consumers, helper-identity
   independence tests, Workbench target validation, and tuning-ledger review.
4. **Inventory and controlled evidence:** manifest/package deltas, complete
   validation, and externally recorded compiler/acceptance evidence.

If a review changes a matrix tolerance, protocol identity, public error code,
or capture/restoration policy, stop and split it into a separately justified
change. Those decisions are not incidental fallout from generation.

## Completion criteria

This task is complete only when all of the following are true:

- One typed canonical model drives existing registry artifacts, the Enforce
  descriptor, and both generated C classes.
- `npm run protocol:check` fails for stale/missing/modified generated C before
  a compiler is launched.
- The Game and Workbench classes are literal-only, target-scoped, deterministic
  Enforce source files with correct provenance.
- Runtime, adapter, and helper-bundle protocol identities remain explicit and
  independently tested.
- Shared state/error/capability/protocol/directory vocabulary is no longer
  hand-spelled in the named Game, WorkbenchGame, host-adapter, and acceptance
  consumers; backend tuning remains deliberately local and documented.
- Static validation independently catches source-artifact drift, descriptor-C
  drift, and a bypass in a named semantic consumer without broad literal bans.
- Both generated C files are current manifest payloads and the packed tarball
  proves their inclusion.
- Focused tests, build, full test suite, protocol/manifest/package checks, and
  available controlled runtime and WorkbenchGame Enforce checks pass.
- Any unavailable controlled validation is documented as not run with its
  environmental reason.
