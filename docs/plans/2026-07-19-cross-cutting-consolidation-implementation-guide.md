# Cross-cutting consolidation implementation guide
 
OUTSTANDING closeout
  → Cross-cutting 0–2
  → reforger-forge-mcp\docs\plans\2026-07-19-safe-stable-stringify-public-rendering-implementation-guide.md + Cross-cutting 3
  → Cross-cutting 4–5 + reforger-forge-mcp\docs\plans\2026-07-19-tar-package-archive-verification-implementation-guide.md
  → Cross-cutting 6–7
  → reforger-forge-mcp\docs\plans\2026-07-19-lmdb-persistence-migration-implementation-guide.md
  -> reforger-forge-mcp\docs\plans\2026-07-19-local-observer-failure-matrix-implementation.md

## Outcome

This follow-on removes the cross-cutting duplication that remains after the
main maintainability roadmap:

1. Both Enforce add-ons consume generated observer vocabulary instead of
   independently spelling shared protocol values.
2. One security-reviewed redactor owns every diagnostic, command-line, and
   evidence-portability redaction rule.
3. One small time foundation owns abortable sleeps, deadline arithmetic, and
   ordinary polling loops without weakening durable lifecycle deadlines.
4. One public-error renderer owns what may leave the MCP tool boundary.
5. The two source manifests become the only maintained observer add-on file
   inventories; packaging and tests consume them.
6. A shared test-support package replaces repetitive temporary-directory,
   clock, polling, and observer fixture setup.
7. A deliberately small architecture check prevents the same categories from
   returning.

The desired dependency direction is:

~~~text
observer/protocol registry
        |
        +--> generated TS / JSON / schemas / docs
        +--> generated Game Enforce vocabulary class
        +--> generated WorkbenchGame Enforce vocabulary class
        |
        +--> host observer adapter vocabulary

foundation/redact ----> agent logs, child logs, CLI/runner output, evidence
foundation/time ------> ordinary waits and polls
observer/public-contract --> both MCP tool error boundaries

source manifests ------> staging, package check, contract tests
tests/support ---------> observer and Workbench suites
architecture check ----> prevents new local owners
~~~

This is consolidation, not a protocol or behavior redesign. Existing public
error codes, supported capture states, ownership checks, deadline bounds, and
Enforce transport semantics remain unchanged unless a separately reviewed
change says otherwise.

## Starting-point inventory

The exact occurrence counts will change while the current worktree settles.
Before implementation, rerun the baseline commands below and record their
output in the first review or PR description. Treat the categories, rather
than a stale count, as the contract.

| Concern | Current examples to inspect | Intended single owner |
| --- | --- | --- |
| Enforce vocabulary | RFO_ObserverJob.c, RFO_ObserverCameraProjection.c, EMCP_WB_ObserverCommon.c, observer-adapter.ts | Protocol registry plus generated vocabulary classes |
| Diagnostic redaction | observer/agent/logger.ts, src/observer/coordinator.ts, observer/agent/runs.ts, Workbench runner/NET/session code, live-acceptance support | src/foundation/redact.ts |
| Deadline/sleep/polling | observer agent artifact intake, coordinator, process guard, runner, lifecycle execution, owned-runtime manager, acceptance scripts | src/foundation/time.ts, with durable policy retained by its current owners |
| Tool error formatting | src/observer/tools.ts and src/tools/observer-runtime.ts | src/observer/public-contract.ts |
| Add-on inventory | both source manifests, helper-addon.ts, check-package.mjs, package-contract.test.ts | The two source manifests |
| Test setup | tests/observer/helpers.ts and direct temporary-directory setup across observer/Workbench suites | tests/support/ |
| Regression guards | local redaction/sleep/path-key implementations and raw test mkdtemp calls | One scoped architecture check |

Suggested characterization commands:

~~~powershell
rg -n "function redact|redact[A-Za-z]+\\(" observer src scripts tests -g "*.ts"
rg -n "function sleep|pollUntil|waitFor|deadline|remaining" observer src scripts tests -g "*.ts"
rg -n "RFO_Observer|EMCP_WB_Observer|reforger-forge-workbench-observer" observer src scripts tests
rg -n "mkdtemp(Sync)?\\(" tests -g "*.ts"
npm run protocol:check
npm run test:package
~~~

Run the focused source, package, and Enforce checks described under
[Validation](#validation) before moving any call site. The existing master
guide and its closeout evidence remain the baseline for lifecycle behavior.

## Decisions fixed by this guide

1. **Generate values, not cross-module Enforce code.** Game and WorkbenchGame
   cannot import one another. Each receives a distinct generated constants
   class with the same registry-derived vocabulary where it is meaningful.

2. **Separate shared protocol values from backend tuning.** A numeric value is
   generated into both classes only when its equivalence is intentional and
   tested. The current different matrix tolerances must remain explicitly
   backend-local until camera acceptance evidence justifies convergence; do
   not silently choose either value as the new universal threshold.

3. **The canonical TypeScript protocol model is authoritative.** Existing
   constants and registries, plus a typed Enforce-contract layer derived from
   them, own the values. Generated C files, JSON, schemas, Markdown, and host
   adapter constants are outputs. Neither an Enforce literal scan nor a
   manifest is allowed to become a competing source of protocol truth.

4. **Redaction is a sink policy, not an authorization policy.** A redactor
   removes secrets from material that may be displayed or persisted. Validation
   that must reject a secret-bearing input, such as evidence configuration,
   stays rejecting; it must not be converted into silent sanitization. Each
   boundary keeps its established replacement spelling through policy
   configuration, rather than silently changing a CLI or evidence contract.

5. **Never redact operational matching inputs.** Exact owner tokens and
   contract data remain available to the narrow internal code that must verify
   them. Redaction happens only at logging, receipt-presentation, diagnostic,
   and evidence-export sinks.

6. **A deadline is absolute and injected.** A derived sub-budget may only
   shorten its parent. The generic time layer does not decide public error
   codes, durable recovery, or retry authority; those policies remain with the
   coordinator, runner, and owned-runtime lifecycle owners.

7. **Persisted wall-clock deadlines stay wall-clock deadlines.** Do not
   replace the Stage 0/V5 owned-runtime deadline record with a process-local
   monotonic timer. The time foundation may provide a view or adapter over its
   absolute expiry, but it must not alter its persistence or failure mapping.

8. **Public error projection is policy, not tool plumbing.** It canonicalizes
   a code, applies the fixed-message gate, redacts allowed details, bounds
   rendered text, and returns a transport-neutral result. Tools retain only
   their error-class classifier and their user-facing subject line.

9. **A source manifest remains verified input.** Consumers derive file lists
   from it, but still verify shape, normalized relative paths, regular files,
   digests, and the permitted generated-resource exception. A manifest alone
   is not proof that an arbitrary staged directory is safe.

10. **Architecture lint is narrow and AST-based.** It guards owners that are
    otherwise difficult to observe dynamically. It must not become a broad
    source-text test suite or ban ordinary string lowercasing, timers, or
    temporary directories that have a documented special purpose.

## Target contracts

Names may evolve slightly during implementation, but the boundaries below are
part of the design.

### Redaction

~~~ts
export type RedactionProfile =
  | "diagnostic"
  | "command_argument"
  | "evidence_portability";

export interface RedactionOptions {
  readonly profile: RedactionProfile;
  readonly maxLength?: number;
  readonly replacement?: string;
  readonly knownSecretValues?: readonly string[];
}

export function redactText(value: string, options: RedactionOptions): string;
export function redactDiagnostic(value: unknown, options: RedactionOptions): unknown;
export function redactArguments(
  values: readonly string[],
  options: RedactionOptions
): readonly string[];
~~~

The implementation needs composable rules rather than one opaque regular
expression: key/value secrets, bearer values, nonce and owner-token arguments,
contract bodies, caller-provided exact secret values, nested data, and absolute
paths for portability-only output. Replacement text is policy-configurable so
the established CLI, diagnostic, and evidence spellings remain stable.
Redaction is idempotent.

### Time

~~~ts
export interface Clock {
  now(): number;
}

export interface Sleeper {
  sleep(milliseconds: number, options?: { signal?: AbortSignal }): Promise<void>;
}

export class Deadline {
  static after(milliseconds: number, clock?: Clock): Deadline;
  static at(expiresAtMs: number, clock?: Clock): Deadline;
  remaining(): number;
  expired(): boolean;
  derive(maximumMilliseconds: number): Deadline;
}

export function sleep(
  milliseconds: number,
  options?: { signal?: AbortSignal; sleeper?: Sleeper }
): Promise<void>;

export function pollUntil<T>(
  probe: (remainingMs: number) => Promise<T | undefined> | T | undefined,
  options: {
    deadline: Deadline;
    intervalMs: number;
    signal?: AbortSignal;
    sleeper?: Sleeper;
  }
): Promise<T>;
~~~

The final API may expose a result form instead of throwing a foundation error,
but it must retain the same semantics: probe immediately, never sleep beyond
the remaining budget, check cancellation before and after waiting, remove
listeners/timers, and distinguish deadline expiry from an aborted signal.

### Public observer tool errors

~~~ts
export interface PublicObserverToolErrorOptions {
  readonly subject: string;
  readonly codeOf: (error: unknown) => unknown;
  readonly detailsOf?: (error: unknown) => unknown;
}

export function projectObserverToolError(
  error: unknown,
  options: PublicObserverToolErrorOptions
): { content: readonly { type: "text"; text: string }[]; isError: true };
~~~

This belongs in src/observer/public-contract.ts beside the existing canonical
code/message policy. It must not import a concrete server instance or acquire
any lifecycle capability.

### Generated Enforce vocabulary

Add observer/protocol/enforce-contract.ts as a typed declarative layer derived
from the existing protocol constants and registries. It owns:

- runtime observer and Workbench-adapter protocol versions;
- job-state names and the terminal subset;
- registry-derived error codes and capability names;
- shared directory-name segments;
- reviewed shared numeric limits;
- an explicit backend-tuning ledger for values that intentionally differ.

Keep these identities distinct: runtime observer protocol 1.0, the
Workbench-adapter protocol string, and the Workbench helper bundle protocol
maintained by generated RFWB_HelperBuild.c. They are not aliases for one
version constant.

The generator emits at least:

~~~text
observer/protocol/generated/enforce-contract.json

observer/addon/Scripts/Game/ReforgerForgeObserver/
  RFO_ObserverProtocol.c

observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/
  EMCP_WB_ObserverProtocol.c
~~~

Each file has a unique class name, a generated-file header, and literal-only
static constants suitable for its Enforce module. Use named fields such as
STATE_COMPLETED, ERROR_RESTORATION_UNCONFIRMED, and CAP_RENDER_CAPTURE; avoid
generated arrays or maps unless an Enforce consumer demonstrably needs one. A
Game class is never referenced from WorkbenchGame or vice versa.

### Source inventory

The two manifest files are the canonical inventories:

~~~text
observer/addon/.reforger-forge-observer-source.json
observer/workbench-addon/.reforger-forge-workbench-helper-source.json
~~~

Consumers receive a small shared manifest reader/validator or equivalent
pure helper. Package verification reads the manifest from the packed archive,
not from the source checkout, and proves that every declared file is present
and every payload file is declared.

## Implementation tasks

### Task 0: freeze behavior and establish an executable baseline

**Goal:** Give every migration a behavioral comparison point before the
existing duplicates are moved or deleted.

**Actions:**

. Record fresh search results for the categories in
   [Starting-point inventory](#starting-point-inventory). Include both source
   and test occurrences, with no hard-coded expectation that an old count is
   still correct.
. Add characterization tests before changing behavior:
   - every known secret sentinel is absent from diagnostic and evidence output;
   - each existing wait/poll path retains its first-attempt, interval, timeout,
     cancellation, and error-mapping behavior;
   - both tool boundaries produce the current stable public code/message
     policy;
   - a source-manifest file addition/removal is detected by staging and
     packaging checks;
   - generated C output is stable for a representative registry input.
. Make the protocol generator's render function accept an injected registry
   source, as its current artifact tests already do. This permits pure tests
   of generated C without mutating the real add-ons.
. Add a focused follow-on test command only after the new suites exist. It
   should be additive; do not weaken the existing full-suite command.

**Acceptance:** The baseline is recorded, the focused tests are green without
production changes, and a reviewer can identify which existing behavior each
later task preserves.

### Task 1: introduce the foundation redaction boundary

**Goal:** One reviewed implementation removes credentials, authority material,
and portability-sensitive paths at every output sink.

**Primary files:**

- Add src/foundation/redact.ts and tests/foundation/redact.test.ts.
- Migrate observer/agent/logger.ts, src/observer/coordinator.ts, and
  observer/agent/runs.ts.
- Migrate src/workbench/runner-cli.ts, net-api-client.ts,
  session-controller.ts, and runner.ts, plus
  src/observer/owned-runtime-manager.ts diagnostic sinks.
- Migrate TypeScript acceptance/evidence support, including
  scripts/observer-live-acceptance-support.ts and the controlled acceptance
  evaluators, with the portability profile only where path masking is needed.
- Migrate the packaged Enforce-mailbox acceptance script through the
  built-module bridge described below.

**Actions:**

1. Define profiles rather than a Boolean redaction switch:
   - diagnostic: bearer values, authorization-like keys, nonce/token/secret
     values, owner arguments, and contract bodies;
   - command_argument: exact owner-token argument forms in either
     equals-separated or whitespace-separated notation;
   - evidence_portability: diagnostic rules plus absolute Windows-path
     substitution, including comma-separated all-absolute path lists.
2. Make structured redaction recursive only over arrays and plain record-like
   data. Bound recursion/depth and preserve primitives. Do not claim an
   arbitrary class instance is safely serializable.
3. Keep the contract-body rule deliberately broad: once a recognizable
   contract body assignment is found, redact its entire value rather than
   trying to enumerate sensitive child fields.
4. Make text redaction idempotent and apply caller-selected truncation only
   after redaction. This prevents a secret from surviving because a string was
   shortened before its matching suffix was considered.
5. Support a caller-supplied exact-secret rule. In particular, the NET client
   must collect dynamic token values from token-bearing request fields, order
   them longest-first, and redact those values exactly; a general regular
   expression cannot discover an arbitrary token returned by Workbench.
6. Migrate output sinks one at a time. The internal operation that compares an
   exact owner argument, verifies a process, hashes an artifact, or validates a
   source bundle must continue to receive the original bytes.
7. Retain reject-on-input policy such as the evidence runtime-config
   secret check. It answers a different security question from output
   sanitization.
8. Treat published JavaScript acceptance scripts as a separate packaging
   boundary. A packaged .mjs file cannot import unbuilt TypeScript; have it
   consume the built foundation module only after its installed-package
   contract guarantees that module exists, or explicitly revise that execution
   contract. Do not copy the redactor into a second .mjs implementation.

**Tests:**

- Use distinct sentinel values for a bearer token, nonce, authorization header,
  owner argument, contract body, nested token key, and Windows path.
- Assert that no sentinel occurs anywhere in the rendered string or serialized
  structured result for each applicable profile.
- Cover case variation, quoted JSON assignments, repeated application,
  nested arrays/records, value length limits, and a safe non-secret control.
- Verify that the operational matcher still receives an unredacted owner token
  through a narrow injected fake; only its reported diagnostic is redacted.

**Acceptance:** No production output sink owns its own redact-prefixed helper
or owner-token regular expression. The sentinel suite passes, and every
migrated caller preserves its externally visible non-secret text and error
code.

### Task 2: add the time, deadline, and ordinary-poll foundation

**Goal:** Eliminate ad hoc sleep and remaining-budget arithmetic while
preserving the special durable lifecycle semantics already proven by the
parent plan.

**Primary files:**

- Add src/foundation/time.ts and tests/foundation/time.test.ts.
- Adapt, rather than replace, src/foundation/reservation-gate.ts.
- Migrate ordinary local waits in artifact intake, coordinator, process guard,
  runner/log attribution, lifecycle execution, and repository-only acceptance
  scripts.
- Treat src/observer/owned-runtime-manager.ts as the final, high-risk
  migration.

**Actions:**

1. Implement the target contracts with injected clock/sleeper seams. The
   system implementation uses real timers; tests use a deterministic sleeper
   or fake-timer adapter.
2. Validate every duration at the boundary. Negative, non-finite, and
   overflow-prone values fail before a timer is allocated.
3. Have pollUntil perform its first probe immediately. On each retry it:
   computes remaining time from the absolute deadline, waits no more than that
   remainder, observes cancellation, and probes again. It must not make a
   final unbounded attempt after expiry.
4. Keep domain policy at the caller. A poll may map expiry to
   ARTIFACT_INCOMPLETE, LOG_ATTRIBUTION_FAILED, CANCELLED, or a durable
   lifecycle recovery result, but time.ts itself does not choose those codes.
5. Reuse the existing reservation-gate retry semantics where durable
   idempotent reservation is required. Do not replace its retry ordering with
   a generic polling loop just because the names are similar.
6. Adapt the existing readiness timing seam rather than replacing it. Its
   delay must still race child exit/error and abort, so a generic sleep cannot
   delay that wakeup. Do not move unrelated IPC, socket, fetch, or response
   timeout timers merely because they call setTimeout.
7. Keep operational-baseline performance measurements on their intentionally
   monotonic clock. They are measurements, not lifecycle wall-clock
   deadlines.
8. Introduce a thin adapter for the owned-runtime wall deadline only after the
   lower-risk migrations and contract tests pass. Its persisted absolute
   expiry, fence checks, recovery record, and public error mapping stay in
   OwnedRuntimeManager.

**Migration order:**

1. Artifact stable-file wait and repository-only acceptance waits.
2. Coordinator's abortable sleep and ordinary Workbench status polling.
3. Process-guard and runner local polling/wait helpers.
4. Lifecycle-execution retry loops that have no durable receipt semantics.
5. Owned-runtime calls through a compatibility adapter, retaining all V5
   focused lifecycle tests.

**Tests:**

- immediate success, delayed success, deadline before first retry, exact final
  budget, probe exception, abort before call, abort during sleep, and timer
  cleanup;
- a derived deadline never outlives its parent;
- a fake clock proves no real-time sleep is required for unit tests;
- existing durable reservation, exact-process, recovery, and endpoint tests
  run unchanged through the adapter before any old deadline helper is removed.

**Acceptance:** New ordinary sleeps and poll loops use the foundation. No
generic time helper changes a durable lifecycle result, and the focused
owned-runtime/Workbench liveness suites remain green.

### Task 3: centralize public observer tool-error projection

**Goal:** Both public tool boundaries apply exactly the same registry policy
and redact details before they can be rendered.

**Primary files:**

- Extend src/observer/public-contract.ts.
- Reduce src/observer/tools.ts and src/tools/observer-runtime.ts to classifier
  and label adapters.
- Add or extend observer public-projection tests.

**Actions:**

1. Move code canonicalization, fixed-message selection, diagnostic-details
   gating, detail redaction, safe JSON presentation, and 512-character
   message bounding into one public-contract export.
2. Keep each tool's subject line stable: capture tools may continue to say
   "Observer error"; runtime tools may continue to say "Observer runtime
   error". Only the policy implementation is shared.
3. Give the common formatter a callback or guard that extracts a known
   ObserverCoordinatorError or OwnedRuntimeError code/details. Unknown errors
   still map to the existing internal public error policy.
4. Do not pass raw Error objects or stack traces to the renderer. If structured
   details are permitted by the registry, redact them before JSON encoding.
5. Preserve the transport-neutral return shape so public-contract.ts does not
   gain lifecycle, server-composition, or tool-registration dependencies.

**Tests:**

- a known bounded-diagnostic error exposes a bounded, redacted detail;
- a fixed-message error emits no source diagnostic or detail;
- an unknown error maps to the existing internal public code/message;
- a circular or non-JSON detail cannot replace the original error with a
  formatter failure;
- both tool adapters produce their existing subject line while sharing all
  policy outcomes.

**Acceptance:** There is one public-error rendering implementation. Searching
for local toolError definitions finds only compatibility forwarding wrappers,
which are removed in the same review boundary if no external import needs
them.

### Task 4: make source manifests the only add-on file inventories

**Goal:** Adding or removing an observer add-on file requires updating one
canonical generated manifest, not hand-maintained lists in packaging, host
code, and tests.

**Primary files:**

- scripts/update-observer-source-manifest.mjs;
- scripts/check-package.mjs;
- scripts/lib/addon-inventory.mjs or an equivalent reusable pure helper;
- src/workbench/helper-addon.ts, a generated helper-payload descriptor, and
  observer/agent/staging.ts;
- tests/observer/package-contract.test.ts;
- package scripts and the two source manifests.

**Actions:**

1. Extract a pure manifest reader/validator usable by the manifest updater and
   package checker. It validates manifest version/role, normalized relative
   paths, no duplicates under the platform comparison rules, digest shape, and
   the allowed generated resource-database exception.
2. Add a check mode to the manifest updater, or an equivalent pure rendered
   comparison. CI must be able to fail for a stale manifest without rewriting
   the checkout.
3. Change check-package.mjs to read each manifest from the packed tarball.
   Verify every manifest entry is packaged and that every add-on payload file
   is declared, allowing only the manifest itself and explicitly documented
   derived resources.
4. Replace hard-coded runtime script arrays, Workbench handler arrays, and
   tests that assert a manually copied inventory/count with derivation from
   the appropriate verified manifest. Keep semantic assertions about required
   handler behavior; remove only copied filenames.
5. Have source-manifest generation also write a checked-in TypeScript
   descriptor, such as src/workbench/helper-addon-payload.generated.ts. It
   exports the exact helper payload/handler lists derived from the verified
   manifest. Helper staging imports that descriptor rather than dynamically
   trusting a source manifest at runtime; its fail-closed allowlist and
   immutable identity checks remain intact.
6. Include the inventory helper and generated descriptor in package-content
   expectations where they are needed by the installed package. Remove the
   current incomplete hard-coded runtime list as well as copied Workbench
   handler lists.
7. Establish the generation order:

~~~text
protocol generation
    -> generated Enforce C files
    -> source-manifest generation
    -> manifest check / package check
~~~

**Tests:**

- an omitted declared file, undeclared added file, duplicate path, symlink,
  invalid digest, and stale generated file all fail closed;
- a tarball fixture proves the package checker reads the archive manifest,
  not the source working tree;
- adding a temporary valid source file and regenerating the manifest makes all
  inventory consumers and the generated helper descriptor see it without
  editing a copied list;
- helper staging still rejects a missing or unexpected payload after the
  descriptor migration;
- generated resourceDatabase.rdb handling remains narrowly limited to its
  existing staged-bundle purpose.

**Acceptance:** The manifests are the sole maintained filename inventories.
No packaging or contract test contains a copied list of observer add-on
payload filenames.

### Task 5: extend protocol generation to Enforce and migrate consumers

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

### Task 6: introduce and adopt tests/support

**Goal:** Make the shortest correct test setup the shared setup, without
forcing native/integration tests into inappropriate fakes.

**Primary files:**

- Add tests/support/temporary-directory.ts, tests/support/manual-time.ts,
  tests/support/wait.ts, and tests/support/observer-fixtures.ts.
- Move or adapt tests/observer/helpers.ts into tests/support/.
- Reuse the existing shared exact-process fake rather than creating another.
- Add a small Workbench fixture module only for shared construction that is
  genuinely reused.

At this snapshot, direct temporary-directory allocation appears in dozens of
test sites across more than two dozen files. Recount at Task 0 rather than
turning that incidental number into a completion criterion.

**Actions:**

1. Provide a test-scoped temporary-directory helper with automatic cleanup
   after each test. It must support a caller-provided prefix and expose the
   path only; it must not hide a mid-test cleanup action when that action is
   the behavior under test.
2. Make the manual clock implement the new foundation time seam. It should support
   deterministic now/advance behavior and a controlled sleeper for polling
   tests, not merely a mutable Date.now substitute.
3. Move observer session/registration builders out of the observer-local
   helper. Make defaults valid, deterministic, and easy to override without
   duplicating a full InstanceRegistration object.
4. Provide a test wait helper only where it delegates to the foundation polling
   contract. Do not add another hand-written waitFor loop.
5. Migrate in reviewable groups: foundation/observer unit tests first,
   Workbench unit tests second, then integration tests where the helper is
   appropriate. Preserve an explicit exception for tests that require a real
   OS-created directory, child process, or cleanup timing as the assertion.
6. Delete the old observer-local helper or leave a short forwarding module for
   one migration boundary only. Do not maintain two fixture implementations.

**Tests:**

- temporary roots are removed after success, assertion failure, and rejected
  async work;
- two concurrent tests receive distinct roots;
- fake clock/sleeper drives deadline and abort tests without wall-clock waits;
- fixture builders produce protocol-valid defaults and preserve explicit
  overrides;
- representative observer and Workbench tests migrate with no loss of their
  domain assertion.

**Acceptance:** Ordinary tests no longer import node temporary-directory APIs
directly. Any remaining raw call has a documented behavioral reason and is
listed as a narrow architecture-check exception.

### Task 7: enforce the new ownership boundaries and delete stragglers

**Goal:** Finish the migration without allowing future movement work to
recreate the old owners.

**Actions:**

1. Add a repository architecture check, preferably using the TypeScript AST,
   with a small rule set:
   - local production function declarations named sleep outside
     src/foundation/time.ts;
   - new production redact-prefixed implementations outside
     src/foundation/redact.ts;
   - copied observer add-on filename arrays outside the manifest tooling;
   - raw test mkdtemp calls outside tests/support/ and an explicit exception
     table;
   - new filesystem path-comparison helpers that case-fold a path instead of
     using the managed-path owner.
2. Scope the path rule to filesystem comparison. Do not flag ordinary
   case-folding for identifiers, display text, JSON keys, or virtual paths.
3. Store exceptions beside the checker with a reason, owning test, and
   expiration/review condition. The checker must fail if an exception no
   longer matches a real prohibited use. Do not add a broad baseline-violation
   allowance; migrate known ordinary uses before enabling the rule.
4. Put the check in a focused architecture test, such as
   tests/architecture/foundation-ownership.test.ts, and use the TypeScript AST
   in the same narrow style as the existing Stage 3 architecture test. Document
   each rule and its exceptions beside it; do not parse source with broad
   regular expressions.
5. Audit existing filesystem comparison helpers before enabling the path rule.
   Migrate actual case-folding stragglers to managed-path, but retain a wrapper
   that already delegates to the foundation rather than creating churn for its
   own sake.
6. Add the check to the normal static/CI tier before the full test suite.
7. Remove superseded helpers only after their call sites, contract tests, and
   package checks have migrated. Do not leave a dead forwarding layer merely
   to preserve an internal name.

**Deletion order:**

1. Local redaction helpers and inline owner-token substitutions.
2. Local ordinary sleep/poll helpers after their domain tests use time.ts.
3. Duplicated toolError renderers.
4. Copied add-on filename arrays.
5. Observer-local test helper after support adoption.
6. Architecture-check temporary exceptions as their special tests are adapted
   or retired.

**Acceptance:** The architecture check is green with no broad allowlist, the
full suite is green, and each deleted owner has one clearly named replacement.

### Task 8: remove temporary validation artifacts from the repository

**Goal:** Validation artifacts are local, temporary evidence—not repository
content or release documentation.

**Actions:**

1. Keep `docs/validation/` in the root `.gitignore` immediately. New logs,
   receipts, screenshots, package-smoke reports, and live-acceptance evidence
   under that path must remain untracked and must never be staged or committed.
2. Audit every script, test, and document that currently defaults to
   `docs/validation`. Change production and local-acceptance defaults to a
   caller-selected external evidence root or a fresh directory beneath the OS
   temporary root. Retain an explicit path option for a maintainer who needs
   to preserve sanitized evidence outside the repository.
3. Update the related hermetic tests so they use temporary roots and prove no
   default execution creates a repository `docs/validation` directory.
4. After all retained claims have been reviewed, delete the existing tracked
   `docs/validation/` directory and remove every tracked artifact beneath it.
   Do not copy its machine-local evidence to another repository location.
5. Update documentation and package checks to describe validation evidence as
   external and uncommitted. A final source search must find no production
   default or user instruction that writes validation artifacts into the
   repository.

**Acceptance:** `git ls-files docs/validation` returns no paths;
`git check-ignore docs/validation/example.json` confirms the ignore rule; a
clean checkout has no `docs/validation` directory; package contents contain no
validation artifact; and the validation harnesses retain evidence only in an
external or OS-temporary location.

## Review boundaries

Keep reviews small enough that a behavioral regression has an obvious source:

1. **Foundation security and time:** Tasks 0-2, with no Enforce or package
   inventory change.
2. **Public boundary projection:** Task 3, including fixed-message and
   redaction tests.
3. **Inventory and generated Enforce vocabulary:** Tasks 4-5, including
   generated-file and controlled Enforce evidence.
4. **Test ergonomics and guardrails:** Tasks 6-7, including the final
   deletion diff and architecture-check configuration.
5. **Temporary validation cleanup:** Task 8, after all other validation has
   been accepted; keep it as one deletion-and-defaults review.

Do not combine a numeric camera-tolerance decision with a bulk generated-file
move. It needs independent review and real acceptance evidence.

## Validation

Run checks progressively, then run the complete relevant set before declaring
the follow-on complete.

~~~powershell
npm run protocol:check
npm run observer:manifest:check
npm run build
npm test
npm run test:package
~~~

When a controlled Windows/Workbench environment is available, also run:

~~~powershell
npm run observer:validate:enforce -- --target both
npm run observer:acceptance:enforce-mailbox
~~~

The exact Enforce command may require the existing local configuration and
controlled add-on roots. Record the Workbench version, compiler result, and
any live acceptance evidence outside the repository in an ignored or external
location. Do not describe a skipped controlled check as a pass.

Focused checks should additionally prove:

- generated protocol and Enforce vocabulary are current;
- source manifests are current and package checks inspect the tarball;
- redaction sentinels do not survive any public output;
- deadlines, cancellation, and durable recovery behavior remain intact;
- both public tool error boundaries return the same policy result;
- tests/support cleanup works under parallel test execution;
- the architecture check has no stale exceptions.

## Completion criteria

This follow-on is complete when all of the following are true:

- The registry generates every shared observer vocabulary artifact, including
  both Enforce constants classes, and drift fails before compilation.
- Any backend-specific numeric tolerance is explicitly documented and covered
  by backend-appropriate acceptance evidence.
- One foundation redactor serves every diagnostic, command-line, and
  portability sink, and the sentinel suite proves secrets do not survive.
- One foundation time layer serves ordinary sleeps/deadlines/polls without
  changing durable V5 lifecycle authority or error mapping.
- One public-contract function shapes both observer tool error responses.
- Each observer add-on manifest is the sole maintained payload inventory, and
  the packed tarball is verified against it.
- Shared test support is adopted by ordinary observer and Workbench suites;
  remaining direct temporary-directory calls are intentional and documented.
- A narrow architecture check prevents new duplicate owners and has no
  unreviewed exception.
- The normal build, full tests, package smoke test, protocol/manifest checks,
  and available controlled Enforce checks pass.
- `docs/validation/` is absent from the repository, ignored for local output,
  and no validation harness defaults to recreating it.

## Non-goals

- Do not merge Game and WorkbenchGame Enforce modules or pretend they can share
  a runtime class.
- Do not change public observer protocol values, tool names, or error
  semantics solely to make generation easier.
- Do not normalize camera tolerance values without real capture/restoration
  evidence.
- Do not replace exact-process, reservation, or durable wall-deadline policy
  with a generic helper.
- Do not turn all source-text tests into architecture lint; retain behavioral
  contract tests as the primary proof.
- Do not force native/integration tests to use a fake temporary directory when
  real filesystem/process behavior is under test.
- Do not modify the parent roadmap as part of this deferred follow-on.

## Related implementation guides

- [LMDB persistence migration implementation guide](2026-07-19-lmdb-persistence-migration-implementation-guide.md):
  independent durable-state storage migration; do not mix it into this
  consolidation work.
- [Tar package-archive verification implementation guide](2026-07-19-tar-package-archive-verification-implementation-guide.md):
  Task 4 package-tarball evidence and archive inspection.
- [Safe-stable-stringify public rendering implementation guide](2026-07-19-safe-stable-stringify-public-rendering-implementation-guide.md):
  Tasks 1 and 3 safe presentation of already-redacted public error details.
