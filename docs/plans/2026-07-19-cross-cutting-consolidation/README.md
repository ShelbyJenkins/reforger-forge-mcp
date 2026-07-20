# Cross-cutting consolidation implementation guide

## Task guide index

| Task | Standalone guide |
| --- | --- |
| 0 | [Baseline](00-task-0-baseline.md) |
| 1 | [Foundation redaction boundary](01-task-1-foundation-redaction-boundary.md) |
| 2 | [Time, deadline, and ordinary-poll foundation](02-task-2-time-deadline-and-ordinary-poll-foundation.md) |
| 3 | [Public observer error projection and safe rendering](03-task-3-public-observer-error-projection-safe-rendering.md) |
| 4 | [Source-manifest and tar package-archive verification](04-task-4-tar-package-archive-verification.md) |
| 5 | [Enforce protocol generation and consumer migration](05-task-5-enforce-protocol-generation.md) |
| 6 | [Shared test support](06-task-6-test-support.md) |

## Independent follow-ons

- [LMDB persistence migration](90-independent-lmdb-persistence-migration.md)
- [Local observer failure-matrix acceptance](91-independent-local-observer-failure-matrix.md)
- [LMDB lifecycle Node-authority migration](92-lmdb-lifecycle-node-authority-migration.md)

The `90` and `91` prefixes are sort keys only; they are not parent task
numbers.

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

[Task 0 baseline](00-task-0-baseline.md)

### Task 1: introduce the foundation redaction boundary

[Foundation redaction boundary implementation guide](01-task-1-foundation-redaction-boundary.md)

### Task 2: add the time, deadline, and ordinary-poll foundation

[Time, deadline, and ordinary-poll foundation implementation guide](02-task-2-time-deadline-and-ordinary-poll-foundation.md)

### Task 3: centralize public observer tool-error projection with safe rendering

[Public observer error projection and safe rendering implementation guide](03-task-3-public-observer-error-projection-safe-rendering.md)

### Task 4: make source manifests the only add-on file inventories

[Task 4 source-manifest and tar package-archive verification guide](04-task-4-tar-package-archive-verification.md)

### Task 5: extend protocol generation to Enforce and migrate consumers

[Task 5 Enforce protocol generation and consumer migration](05-task-5-enforce-protocol-generation.md)

### Task 6: introduce and adopt tests/support

[Task 6 shared test support](06-task-6-test-support.md)

### Manual closeout: remove temporary validation artifacts

After the other consolidation checks are reviewed, perform this cleanup
manually:

1. Keep `docs/validation/` ignored at the repository root.
2. Audit scripts, tests, and documentation so validation evidence defaults to
   an external evidence root or a fresh OS-temporary directory.
3. Remove any tracked `docs/validation/` artifacts and confirm that a clean
   checkout does not recreate that directory by default.
4. Verify package contents contain no validation artifacts and that maintainers
   can still select an explicit external evidence location.

## Review boundaries

Keep reviews small enough that a behavioral regression has an obvious source:

1. **Foundation security and time:** Tasks 0-2, with no Enforce or package
   inventory change.
2. **Public boundary projection:** Task 3, including fixed-message and
   redaction tests.
3. **Inventory and generated Enforce vocabulary:** Tasks 4-5, including
   generated-file and controlled Enforce evidence.
4. **Test ergonomics:** Task 6, including the final deletion diff.

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
- The normal build, full tests, package smoke test, protocol/manifest checks,
  and available controlled Enforce checks pass.
- Manual closeout confirms `docs/validation/` is absent from the repository,
  ignored for local output, and no validation harness defaults to recreating
  it.

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

- [LMDB persistence migration implementation guide](90-independent-lmdb-persistence-migration.md):
  independent durable-state storage migration; do not mix it into this
  consolidation work.
- [Tar package-archive verification implementation guide](04-task-4-tar-package-archive-verification.md):
  Task 4 package-tarball evidence and archive inspection.
- [Public observer error projection and safe rendering implementation guide](03-task-3-public-observer-error-projection-safe-rendering.md):
  Task 3's public error policy, redaction boundary, and safe structured-detail
  rendering.
- [Local observer failure-matrix acceptance implementation](91-independent-local-observer-failure-matrix.md):
  maintainer-only local acceptance work; it does not alter the ordinary CI
  contract.
