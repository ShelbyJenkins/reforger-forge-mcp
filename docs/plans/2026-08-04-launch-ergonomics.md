# Launch Ergonomics: making Workbench and game launch cheap for agents

## Context

Agents burn minutes launching Workbench or the game through this MCP. Tracing both
paths showed the cost is **not** a missing endpoint:

- `wb_launch` is already one call. Helper staging, dependency audit, mutex claim,
  spawn, and readiness all happen inside it. The cost is that it has ~45 distinct
  refusal codes and roughly **3** name a concrete next action. `PROJECT_COMPILE_FAILED`
  never mentions `wb_check`. `UNOWNED_WORKBENCH` returns PIDs and stops. An agent
  that hits any of the other ~42 goes exploring.
- The game path forces an agent to invent **two values from nothing**: the
  `profilePath` leaf (no helper computes one — it must call `observer_setup doctor`,
  read `profileRoot`, and concatenate) and **the entire engine `arguments` array**.
  `runtimeKind` contributes nothing to argv — `mergeLaunchArguments`
  (`observer/agent/launch-arguments.ts:62-159`) never reads it, so `"client"` does not
  emit `-client`. Nothing in the MCP says how to boot into a given world or scenario.
- `observer_prepare_launch` returns argv but **no executable path**, which makes
  `docs/observer.md:100-103` ("pass the returned arguments unchanged to your own
  launcher") unfollowable as written.

Outcome: cold game start goes 4 calls → 1 with zero invented inputs; refusals name
their next tool call; and both launches can emit a runnable script.

**Non-negotiable:** no change to exact-process ownership, one-shot prepared launches,
TTL expiry, machine-mutex fencing, the host/private-child process boundary, or the
native-fullscreen default (`assertNativeFullscreenLaunch`, `src/observer/tools.ts:133-151`).

Ship as four PRs: **A → B → C → D**. A is independent and delivers most of the win.

---

## Phase A — Actionable refusals

Highest value per unit of risk. No new tools, no lifecycle changes.

**Create `src/workbench/refusal-remedy.ts`** (pure, no I/O):

```ts
export interface WorkbenchRemedy {
  readonly nextCall: string;    // 'wb_check { gprojPath: "<path>" }'
  readonly why: string;
  readonly toolCanFix: boolean; // false ⇒ needs a human or an MCP restart
}
export function workbenchRemedy(code: WorkbenchErrorCode): WorkbenchRemedy | null;
export function formatWorkbenchRefusal(
  error: unknown,
  options: { readonly operation: string; readonly gprojPath?: string },
): string;
```

Key **only on `WorkbenchErrorCode`** (`src/workbench/session-controller.ts:320-347`) — never
on message substrings. Declare with `satisfies Record<WorkbenchErrorCode, …>` so a new
code fails typecheck until it has an entry.

Load-bearing entries:

| Code | `nextCall` | `toolCanFix` |
|---|---|---|
| `PROJECT_COMPILE_FAILED` | `wb_check { gprojPath }` | true |
| `TARGET_REQUIRED` / `AMBIGUOUS_TARGET` | `wb_projects action="list"` → `wb_launch { gprojPath }` | true |
| `TARGET_SESSION_REQUIRED` / `TARGET_CONFLICT` | `wb_shutdown` → `wb_launch { gprojPath, resourcePath }` | true |
| `LIFECYCLE_BUSY` | `wb_state`, then retry `wb_launch` | true |
| `IDENTITY_UNVERIFIABLE` | `wb_diagnose` → `wb_launch` | true |
| `INVALID_CONFIG` | restart MCP with `--workbench-addon-dir <dir>` per missing root | **false** |
| `UNOWNED_WORKBENCH` | close the listed PIDs by hand (`wb_shutdown` will refuse) | **false** |
| `OWNED_BY_OTHER_MCP` | another live MCP owns the lease | **false** |
| `RECOVERY_REQUIRED` | terminal — `wb_diagnose`, then restart the MCP | **false** |

`toolCanFix: false` is the point of the table. Today an agent retries `INVALID_CONFIG`
forever because nothing tells it that no tool will help.

**Modify `src/workbench/compile-diagnostics.ts:213-219`** — add one sentence naming
`wb_check { gprojPath }`. Pass the project path in from `startReserved`
(`session-controller.ts:3476` already holds `preflight.project.displayPath`) rather than
adding a persisted field to `WorkbenchCompileFailure`.

**Modify `src/tools/wb-launch.ts:66-77`** to render through `formatWorkbenchRefusal`,
appending the remedy **after** the raw `error.message` — `tests/workbench/wb-launch-tool.test.ts:70-74`
asserts the GUID and `--workbench-addon-dir <directory>` survive verbatim. Then adopt in
`wb-shutdown.ts:42`, `wb-restart.ts:34`, `wb-state.ts:41`. Leave `wb-check.ts` alone
(deliberate structured JSON).

**Create `src/observer/refusal-remedy.ts`**: `observerRemedy(code: string): string | undefined`.
**Do not touch `src/observer/public-contract.ts`** — its 512-char bound and fixed-message
redaction (`:107-164`) are load-bearing. Append the remedy as a separate line inside the two
`toolError` helpers (`src/observer/tools.ts:190-201`, `src/tools/observer-runtime.ts:26-37`).
Remedies are constants keyed on already-public codes, so they leak nothing. Emit **none** for
`STORAGE_UNVERIFIABLE` / `INTERNAL_ERROR` / `UNAUTHORIZED`.

Entries: `PREPARED_LAUNCH_EXPIRED|_CONSUMED|_STALE` → re-prepare then start;
`RUNTIME_NOT_FOUND` → `observer_setup action="doctor"` to confirm `gamePath`;
`INSTANCE_NOT_FOUND`/`NO_RENDER_ENDPOINT` → `observer_instances { sessionId, renderersOnly: true, waitMs: 30000 }`;
`ARGUMENT_CONFLICT` → drop `-window`/`-screenWidth`/`-screenHeight` or use `forceNonNativeWindowSize`.

---

## Phase B — Derive game launch args

Nothing today can enumerate an addon's worlds or scenarios (checked `asset-search.ts`
— base game tree only; `wb-scenario.ts` — places entities, no read path;
`scenario-create.ts` — writes `<addonRoot>/Missions/<name>.conf`, confirming the
convention; `wb-resources.ts` — exact-path lookup needing live Workbench). New discovery
is required, but assembles almost entirely from existing pure parts.

**Create `src/launch/game-launch-plan.ts`** — pure, read-only:

```ts
export function readResourceMetaGuid(metaPath: string): string | null;   // moved from wb-entity-duplicate.ts:274
export function canonicalizeScenarioTarget(ref, project): CanonicalScenarioTarget;
export function discoverProjectScenarios(project): readonly CanonicalScenarioTarget[];
export function resolveGameLaunchTarget(input): GameLaunchTarget;
export function deriveGameLaunchArguments(target, options?): readonly string[];
export function deriveObserverProfilePath(profileRoot, target): string;
```

Reuse, don't rewrite:

- `resolveGameLaunchTarget` = `canonicalizeGproj` (`project-identity.ts:70`) +
  `auditWorkbenchAddonDependencies` (`addon-dependencies.ts:269`). Use the **audit**, not
  `assertWorkbenchAddonDependenciesAvailable` — a missing dependency becomes a `warnings`
  entry, since the runtime tolerates more than the editor. Roots =
  `dirname(project.modDirectory)` first, then `audit.resolvedDependencies[].addonRoot`,
  deduped by `pathComparisonKey`.
- `readResourceMetaGuid` is promoted out of `wb-entity-duplicate.ts:274` and imported back
  there — removes a duplicate rather than adding one.
- `canonicalizeScenarioTarget` accepts an absolute `.conf`, a project-relative
  `Missions/X.conf`, or a formed `{GUID}Missions/X.conf`. Validate exactly like
  `resource-target.ts:84-124`: `.conf` and its `.meta` both regular files, both contained by
  `project.modDirectory`.
- `discoverProjectScenarios` — bounded scan of `<modDirectory>/Missions`, depth ≤ 2, cap 256,
  mirroring `discoverCandidateGprojFiles` (`addon-dependencies.ts:191-260`). Auto-selects when
  exactly one registered scenario exists; otherwise enumerates candidates in the refusal so the
  agent's next call is trivially correct. **No cache** — a stale list after
  `scenario_create_conflict` is worse than the scan.
- `deriveGameLaunchArguments` returns
  `["-addonsDir", roots.join(","), "-addons", ids.join(","), ...(scenario ? ["-scenarioId", ref] : []), ...extra]`.
  This is the designed extension point, not a bypass: `mergeLaunchArguments`
  (`observer/agent/launch-arguments.ts:98-99,118-140`) consumes `-addonsDir`/`-addons`,
  canonicalizes and dedupes, and appends the observer addon; unknown flags fall through the
  `unrelated` bucket (`:81-83`) untouched. Refuse `-profile`, `-logsDir`, `-window`,
  `-screenWidth`, `-screenHeight`, and any `-reforgerForgeOwnerToken*` in `extra`.
- `deriveObserverProfilePath` = `join(profileRoot, "derived", sha256(project.comparisonKey).slice(0,16))`.
  **Per project, not per scenario** — per-scenario multiplies profiles and re-downloads
  settings. A hash avoids `MAX_PATH` and charset problems. Satisfies `prepareProfile`'s
  containment check (`observer/agent/control-api.ts:214-228`); needs no pre-creation
  (`ensureCanonicalDirectory`, `src/foundation/managed-path.ts:152`).

**A `.conf` without a sibling `.meta` has no GUID.** Refuse with `SCENARIO_UNREGISTERED`
naming the remedy ("open once with `wb_launch`, or `wb_resources action="register"`").
Never guess.

**Modify `src/observer/application.ts`** — add `readonly profileRoot: string` to the
`ObserverApplication` interface, assigned from the existing computation at `:184`. Do not
recompute in `server.ts`; that would fork a security-relevant containment root.

---

## Phase C — Launch descriptor + script emitter

**Create `src/launch/launch-script.ts`**:

```ts
export interface LaunchCommandDescriptor {
  readonly kind: "game_runtime" | "workbench_editor";
  readonly executablePath: string;
  readonly argv: readonly string[];
  readonly workingDirectory: string;
  readonly commandLine: string;
  readonly ownership: "unowned_by_mcp" | "preview_only";
  readonly grants: readonly string[];
  readonly doesNotGrant: readonly string[];
  readonly expiresAt?: string;
}
export function renderPowerShellLaunchScript(d: LaunchCommandDescriptor): string;
export function writeLaunchScript(managedRoot: string, name: string, script: string): string;
```

Export three currently-private pure helpers from `src/observer/owned-runtime-manager.ts`:
`quoteWindowsArgument` (`:605`, libuv-compatible), `assertWindowsCommandLineFits` (`:625`),
`assertNoOwnerArgument` (`:704`). `knip.jsonc` sets `include` without `exports`, so new
exports will not trip `lint:unused`.

Non-negotiable safety rules:

- `renderPowerShellLaunchScript` calls `assertNoOwnerArgument(d.argv)` first. The owner token
  must never reach a file.
- `writeLaunchScript` writes **only** under `<observer managedRoot>/launch-scripts/`, filename
  `^[A-Za-z0-9_-]{1,64}$` + `.ps1`, via `resolveManagedPath`. Never a caller-chosen path.
- **PowerShell only.** No `.bat`/`.cmd` — they cannot quote these paths safely.

**What an emitted game script does and does not grant** (state verbatim in the descriptor,
the tool description, and `docs/observer.md`):

> **Grants.** A runnable command line starting Arma Reforger with the derived addon roots,
> addon IDs, scenario, staged observer addon, and observer-exclusive profile. Registration
> flows through the session contract at `<profilePath>/profile/ReforgerForgeObserver/session.json`
> (`observer/protocol/constants.ts:10-11`), so `observer_instances`, `observer_capture`, and
> `observer_job` **will** work against it.
>
> **Does not grant.** Exact-process ownership. No owner token ⇒ no durable receipt, no
> consumption record, no mutex fencing. `observer_runtime action="status"|"stop"` **will
> refuse** it. The MCP will not terminate it, seal its session at shutdown, or reconcile its
> exit. **Closing it is the human's job.**

**The double-start hazard and its one-line fix.** A script emitted from a *recorded* prepared
launch would let an agent run the script *and* call `observer_runtime start` on the same
`preparedLaunchId` — two live games. Fix, using existing behavior: **script mode calls
`prepareObserverLaunch(application, input)` with no recorder.** `src/observer/launch.ts:80`
is already `if (!recorder) return prepared;`, and `startLocked` cannot resolve a descriptor
never written (`owned-runtime-manager.ts:1994`). The modes become mutually exclusive **by
construction**. This is the most important decision in Phase C.

**Workbench preview folds into `wb_diagnose` — do not add a tool.** The Workbench plan cannot
be emitted as a runnable owned launch: `immutableArguments` (`launch-plan.ts:565-577`) requires
exactly one owner slot, and `preflightLaunch` mints a live token (`session-controller.ts:3252`)
and calls `ensureStaged()`, which **writes to disk** (`helper-addon.ts:452-465`).

- **Modify `src/workbench/launch-plan.ts`** — add `WORKBENCH_OWNER_ARGUMENT_PLACEHOLDER`
  (carrying `WORKBENCH_OWNER_ARG_PREFIX`, so `immutableArguments` still validates) and
  `previewMcpEditorLaunchPlan(input: Omit<McpEditorLaunchPlanInput, "ownerArgument">)`.
  The frozen builders are reused **unchanged**.
- **Modify `src/tools/wb-diagnose.ts`** — schema `{}` → `{ gprojPath?, includeLaunchPlan? }`
  (all optional ⇒ backward compatible). Render a `### Planned Launch Command` section with
  `ownership: "preview_only"`. Use read-only `companionProvider.managedCompanionStatus()`;
  if unstaged, print "helper not staged — `wb_launch` will stage it" rather than staging.

---

## Phase D — `game_launch` composite

Keep `observer_prepare_launch` and `observer_runtime` registered as primitives; layer above
them. Register **inside `registerObserverTools`** (`src/observer/tools.ts`, beside the
`registerObserverRuntime` call at `:489-491`), gated on `defaults.ownedRuntimeManager`.
`tests/observer/application-composition-architecture.test.ts:14-15,33` deliberately forbids
`server.ts` from touching `OwnedRuntimeManager`.

**Create `src/tools/game-launch.ts`** — `registerGameLaunch(server, application, manager, defaults)`.

```ts
{
  action: z.enum(["start", "script", "status", "stop"]).default("start"),
  gprojPath: z.string().optional(),   // falls back to the running Workbench target
  scenario: z.string().optional(),    // .conf path, project-relative, or {GUID}Missions/X.conf
  runtimeKind: z.enum(["client", "listenServer", "dedicated"]).default("client"),
  arguments: z.array(z.string().max(32_768)).max(256).default([]),
  waitForInstanceMs: z.number().int().min(0).max(300_000).default(60_000),
  sessionTtlMs, forceUpdate, noFocus, forceNonNativeWindowSize,   // same bounds as prepare
  scriptName: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  runtimeId: z.string().optional(),
  waitForRestorationMs: z.number().int().min(0).max(300_000).default(20_000),
}
```

**Deliberately absent: `profilePath` and `idempotencyKey`** — the two invented inputs this
tool exists to remove. `testRunner` is excluded (no meaningful scenario derivation); reach it
via `observer_prepare_launch`.

`action: "start"` sequence:

1. Resolve `gprojPath`, falling back to the running Workbench target.
2. `resolveGameLaunchTarget({ gprojPath, scenario, configuredAddonRoots })`.
3. `assertNativeFullscreenLaunch(...)` — **reuse `src/observer/tools.ts:133-151` verbatim.**
4. `profilePath = deriveObserverProfilePath(application.profileRoot, target)`.
5. `args = mergeConfiguredAddonDirectories(deriveGameLaunchArguments(target, …), defaults.workbenchAddonDirs)`
   — reuse `src/observer/tools.ts:167`.
6. `prepareObserverLaunch(..., deriveGameLaunchPrepareIdempotencyKey(canonical), manager)`.
7. `manager.start({ preparedLaunchId, idempotencyKey: deriveObserverRuntimeIdempotencyKey(...) })`
   — reuse `src/tools/observer-runtime.ts:44-56` unchanged.
8. If `waitForInstanceMs > 0`: `application.instances({ sessionId, requiredCapabilities: ["render.capture"], renderersOnly: runtimeKind !== "dedicated", waitMs, signal })`.
9. Return one JSON block: `{ runtimeId, pid, state, sessionId, preparedLaunchId, profilePath, scenario, addonRoots, addonIds, argv, warnings, instances, nextSteps }`.

**Idempotency — two derived layers.** New `deriveGameLaunchPrepareIdempotencyKey`, same
pattern as the existing start-key derivation:

```ts
`mcp-game-launch-prepare-v1-${sha256(JSON.stringify(canonical))}`
```

Canonical fields in fixed order: `{ v: 1, projectComparisonKey, scenarioResourceRef,
runtimeKind, derivedArguments, profilePath, sessionTtlMs, forceUpdate, noFocus,
forceNonNativeWindowSize }`. **Exclude `waitForInstanceMs`** — a read-only wait must never
fork launch identity. The private child already de-dupes on this key
(`observer/agent/control-api.ts:242-249`), and `recordPreparedLaunch` returns the same
`preparedLaunchId` via the session index (`owned-runtime-manager.ts:1318-1336`).

Property to assert: **a lost `game_launch` response, retried with byte-identical inputs,
yields the same `runtimeId` and starts no second game.**

Other actions: `script` runs steps 1-5, then `prepareObserverLaunch` **with no recorder**,
then `manager.resolveRuntimeExecutablePath(runtimeKind)`, then builds the descriptor and
optionally writes the file. `status`/`stop` delegate to `manager` byte-identically to
`observer_runtime`, so an agent never switches tools mid-workflow.

**Modify `src/observer/owned-runtime-manager.ts`** — add a public
`resolveRuntimeExecutablePath(runtimeKind)` wrapping the existing private `resolveExecutable`,
so `gamePath` stays encapsulated and the allowlist/containment checks at `:730-765` are reused.

Tool count 59 → **60**. Rejected: a separate `game_launch_script` tool (the `action`
discriminator carries it) and `wb_launch_script` (folded into `wb_diagnose`).

---

## Risks

1. **`-scenarioId` as a client CLI flag is unproven in this repo.** Every `scenarioId`
   reference is a dedicated-server *config JSON* field (`src/tools/server-config.ts:35`,
   `src/templates/server-config.ts:11`) — not a command line. Mitigation: the token set lives
   in exactly one pure function (`deriveGameLaunchArguments`), unit-tested as a vector, and
   **release is gated on the live acceptance run in the verification section.** If the real
   flag differs, one function changes.
2. **`.meta` regex fragility.** `readResourceMetaGuid`'s pattern was written for `.et`/`.ent`.
   Fixture-test against a real `Missions/*.conf.meta`; fall back to a bare
   `/\{([0-9A-Fa-f]{16})\}/` scan of the first 4 KB with an explicit "GUID inferred" warning.
3. **Prepare-key drift.** If zod defaults or field order change, retries silently stop
   de-duping and a second game starts. Version the key (`-v1-`), freeze the canonical shape in
   one exported type, and assert the exact digest for a fixed input.
4. **`profileRoot` on the `ObserverApplication` interface** is an additive public-surface
   change — check whether `tests/observer/application-contract.test.ts` enumerates members.
5. **`wb_diagnose` schema change.** All fields optional, so cached schemas keep working.

## Rejected

- **Making `observer_prepare_launch.profilePath` optional with a derived default** — silently
  changes an existing public contract and lets unrelated callers collide on one profile. Keep
  the primitive strict; let `game_launch` own derivation.
- **Any owner token in an emitted script** — would let a hand-started process wear MCP
  ownership without the receipt, consumption record, or mutex.
- **Emitting a script from a recorded prepared launch** — double-start hazard (see Phase C).
- **Sniffing remedies from message substrings** — codes are the contract, prose is not.
- **Guessing a GUID for an unregistered `.conf`**, **adding `-world` alongside `-scenarioId`**,
  **`.bat`/`.cmd` output**, **caller-chosen script paths**, **relaxing
  `assertNativeFullscreenLaunch` for the composite**, **recursive project-wide `.conf` walks**.

---

## Verification

**Phase A** — new `tests/workbench/refusal-remedy.test.ts` (every `WorkbenchErrorCode` has an
entry), `tests/observer/refusal-remedy.test.ts`. Extend `wb-launch-tool.test.ts`,
`compile-diagnostics.test.ts`, `observer-mcp-tools-schema-responses.test.ts`.
`tests/observer/public-contract.test.ts` must stay green **untouched** — that is the proof the
projection boundary did not move. Run `npm run test:stage3`, `npm run test:stage4`, `npm run typecheck`.

**Phase B** — new `tests/launch/game-launch-plan.test.ts` with fixtures (`.gproj` +
`Missions/X.conf` + `.meta`): single-scenario auto-select, ambiguous, missing `.meta`, scenario
outside the project, dependency root ordering/dedup, reserved-token refusal, profile-path
determinism and containment. Extend `tests/observer/launch-arguments.test.ts` to prove a
derived vector survives `mergeLaunchArguments` with `-scenarioId` preserved. Run
`npm run test:stage4`, `npm run typecheck`, `npm run lint:unused`.

**Phase C** — new `tests/launch/launch-script.test.ts`: owner-token rejection,
`quoteWindowsArgument` round-trip on paths with spaces/quotes/backslashes, write-path
containment (reject `..`, absolute, over-long), grants/doesNotGrant text present. Extend
`tests/workbench/workbench-launch-plan.test.ts` (preview produces the same argv shape with the
placeholder) and assert no descriptor is written when the recorder is omitted. Run
`npm run test:stage3`, `npm run test:stage4`, `npm run build`.

**Phase D** — new `tests/observer/game-launch-tool.test.ts`: derived-key stability, retry
returns the same `runtimeId`, script mode records no descriptor, `-window` still refused,
`forceNonNativeWindowSize` rejected for `dedicated`, `SCENARIO_UNREGISTERED` names the register
remedy. These must stay green **untouched**:
`tests/observer/owned-runtime-manager-mutex-fencing.test.ts`, `-restart-sealing`,
`-termination-vacancy`, `-restoration-gating`. Run `npm run test:stage4`,
`npm run test:cross-cutting:baseline`, `npm run test`, `npm run build`, `npm run mcp:verify`.

**End-to-end (required before shipping D).** Extend `scripts/run-runtime-observer-acceptance.ts`
with a `game_launch` start → capture → stop path against the real game. This is the **only**
way to confirm `-scenarioId` actually boots the client into the scenario rather than the main
menu. Do not ship Phase B or D without it.
