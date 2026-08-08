# Commit 13 plan: make MCP host processes operator-identifiable

> **Commit:** `feat(setup): label MCP host processes`
>
> **Series position:** independent operator/setup follow-up. It may land before,
> during, or after the game-launch series.
>
> **Dependency:** none. The later
> [idle-readiness foundation](2026-08-04-launch-ergonomics-14-mcp-idle-readiness.md)
> depends on this identity, and the
> [bounded auto-shutdown actor](2026-08-04-launch-ergonomics-15-mcp-idle-shutdown.md)
> consumes both contracts.
>
> **Migrated requirement:** MCP-056. The queue draft used MCP-054, but that global
> ID was already assigned to the resolved `wb_log_query` defect. The duplicate
> draft entry was removed from `MCP_ISSUES.md` after this plan became its
> implementation owner.

## Why this is its own commit

The current client registrations launch `node` with only `dist/index.js`, and the
shared PowerShell launcher ultimately invokes the same generic Node executable.
The Workbench process guard and owned-runtime manager also generate separate MCP
lifecycle UUIDs. As a result, Task Manager shows generic Node images and the
operator lacks one process-wide identity that connects the client registration,
PID, diagnostics, and lifecycle records.

This does not belong in Commit 11. That commit enumerates allowlisted game-runtime
executables to prove an exact profile vacant; broadening it to inspect or label
MCP hosts would mix setup/CLI behavior with a security-sensitive game-process
proof. Host labeling is independently reviewable and reversible.

## Goal

Make every managed MCP launch visibly identify `reforger-forge-mcp` and its
owning client in Task Manager's Command line view, then expose one generated
process-instance UUID and exact PID through bounded diagnostics. Preserve stdio
purity and do not claim that a Node title or argument renames `node.exe`.

## Research and current-code constraints

- Microsoft defines `Win32_Process.Name` as the executable image name used by
  Task Manager, while `CommandLine` is the command used to start the process.
  A Node argument can therefore make the command line identifiable but cannot
  turn the image into `ReforgerForgeMCP.exe`.
  [Win32_Process documentation](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process)
- Node's `--title` sets `process.title`, but Node warns that process-manager
  applications on Windows may not display the assigned title accurately. Treat
  it as supplemental presentation, never as the acceptance proof.
  [Node CLI documentation](https://nodejs.org/api/cli.html#--titletitle),
  [Node process documentation](https://nodejs.org/api/process.html#processtitle)
- A true product-named image would require a separately built executable. Node's
  single-executable support remains an active-development packaging surface, and
  this repository has ESM, native modules, and external data/add-on assets that
  require an explicit bundle, asset, update, signing, and package-verification
  design.
  [Node single-executable documentation](https://nodejs.org/api/single-executable-applications.html)
- `src/setup/client-registration.ts` currently emits `command: "node"` and
  `args: [serverPath]` for managed clients. `agents/configs/stdio-template.json`
  does the same. `scripts/start-mcp-stdio.ps1` validates Node 24+ but invokes it
  without a host label.
- `WorkbenchProcessGuard.mcpInstanceId` and
  `OwnedRuntimeManager.managerInstanceId` are currently generated independently.
  They identify valid subsystem lifecycles, but neither is a single host identity
  created at the MCP entry point.

## Files

- new `src/mcp-host-identity.ts`
- `src/index.ts`
- `src/server.ts`
- `src/workbench/process-guard.ts`
- `src/workbench/session-controller.ts`
- `src/workbench/diagnostics.ts`
- `src/tools/wb-diagnose.ts`
- `src/observer/application.ts`
- `src/observer/owned-runtime-manager.ts`
- `src/setup/client-registration.ts`
- `src/setup/server-verification.ts`
- `scripts/start-mcp-stdio.ps1`
- `scripts/verify-mcp-server.mjs`
- `scripts/setup.ps1`
- `agents/configs/stdio-template.json`
- `agents/configs/claude-desktop.json`
- `agents/configs/cursor-global.json`
- `agents/configs/vscode-template.json`
- `agents/install-agents.ps1`
- `agents/README.md`
- `agents/AGENTS.md`
- `scripts/check-package.mjs`
- `package.json` only if the focused tests are added to an enduring stage
- new `tests/mcp-host-identity.test.ts`
- `tests/workbench/diagnostics.test.ts`
- `tests/workbench/wb-diagnose-tool.test.ts`
- `tests/workbench/process-guard.test.ts`
- `tests/workbench/server-composition.test.ts`
- `tests/workbench/workbench-session-controller.test.ts`
- new `tests/observer/owned-runtime-manager-host-identity.test.ts`
- `tests/setup/client-registration.test.ts`
- `tests/setup/client-registration-inspection.test.ts`
- `tests/setup/client-registration-issue03-safety.test.ts`
- `tests/setup/start-mcp-stdio.test.ts`
- `tests/setup/server-verification.test.ts`
- `tests/setup/build-verification-deduplication.test.ts`
- new `tests/setup/mcp-host-process-identity-windows.test.ts`
- `tests/config-installation-contract.test.ts`
- `README.md` and `SETUP.md`

## Process-wide identity contract

Create one immutable value at the start of server mode:

```ts
interface McpHostIdentity {
  readonly schemaVersion: 1;
  readonly product: "reforger-forge-mcp";
  readonly clientLabel: string;
  readonly instanceId: string;
  readonly pid: number;
  readonly startedAt: string;
}
```

Parse a new server-only `--mcp-client-label <value>` before configuration
arguments. Accept a lowercase bounded slug such as `codex`, `claude-code`,
`cursor`, `vscode`, or `manual`; reject duplicates, blanks, controls, path-like
values, and values outside `[a-z0-9][a-z0-9._-]{0,47}`. The label is diagnostic
provenance, never ownership authority. Direct/manual launches default to
`manual` rather than guessing a client.

For CLI server mode, generate `instanceId` exactly once with
`crypto.randomUUID()` inside `src/index.ts`. Do not accept it from the command line
or environment. Capture PID and start time there, freeze the value, and inject it
through `registerTools` instead of letting subsystems silently create unrelated
production UUIDs.

`registerTools` is also a public embedder composition seam. When
`RegisterToolsOptions.hostIdentity` is absent, create exactly one validated
`manual` fallback identity at that boundary and inject it into both subsystems and
diagnostics; do not let one embedded composition fall back to two unrelated UUIDs.
Direct standalone `WorkbenchProcessGuard` and `OwnedRuntimeManager` constructors
may retain their random defaults. Validate the complete injected object before
use or public projection: exact schema/product, bounded client slug, UUID, current
PID, and finite canonical ISO `startedAt`. Reject an injected object for another
PID rather than relabeling it.

Add explicit optional injection seams to
`WorkbenchProcessGuardOptions.mcpInstanceId` and
`OwnedRuntimeManagerOptions.managerInstanceId`, validating both as UUIDs. Thread
the trusted host identity through `RegisterToolsOptions`,
`createWorkbenchServerComposition`, and `CreateObserverApplicationOptions`; do
not reach for a module-global singleton. Production `src/index.ts` supplies the
entry-point value, the registerTools fallback covers embedders, and existing
isolated subsystem constructors retain random defaults.

Use the host `instanceId` as the production
`WorkbenchProcessGuard.mcpInstanceId` and
`OwnedRuntimeManager.managerInstanceId`. This does not weaken their existing PID,
creation-time, installation, user-SID, lease, or owner-token checks; the UUID is
only one field in those exact identities. Test that two server compositions still
receive different UUIDs and cannot claim each other's evidence.

Set `process.title` to
`ReforgerForge-MCP-<client>-<shortInstanceId>`, where `shortInstanceId` is the
first eight lowercase hex characters of the UUID after removing hyphens. With the
48-character label cap, reject any result over 80 ASCII characters rather than
silently truncating it. Also start managed Node commands with
`--title=ReforgerForge-MCP-<client>` before the script path so the original command
line contains a stable product/client marker. Neither mechanism is represented as
changing the executable image name.

Write one fixed-field startup diagnostic to stderr only, containing product,
client label, complete instance UUID, and PID. Do not include argv, environment,
paths, tokens, or configuration values. Replace the existing generic
`ReforgerForge MCP server started` log rather than emitting a second startup line.
Keep stdout byte-clean for JSON-RPC.

## Managed client and launcher changes

Make every managed registration derive its client slug from the existing trusted
`ClientDefinition.id`, not display text read back from a mutable config. Audit all
current IDs: `antigravity`, `codex`, `cursor`, `claude-desktop`, `claude-code`,
`windsurf`, `vscode`, `continue`, and `kiro`. Emit:

```text
node --title=ReforgerForge-MCP-<client> <absolute dist/index.js> --mcp-client-label <client>
```

The Node option must precede the script path; the server option must follow it.
Update JSON, VS Code, Claude CLI, Continue, and other supported registration
builders and their current-entry comparison logic together. An old unlabeled
entry is `different`, not `already_current`. Preserve the current migration
distinction: JSON/YAML file-backed clients use their atomic backup path, while
Codex/Claude CLI remove/add flows retain their explicit restoration path. Preserve
current client-specific schemas and quoting, including the guarded updater's
existing removal of conflicting `TRANSPORT_OVERRIDE_KEYS` such as env, cwd, URL,
auth, and headers; do not accidentally start preserving authority-bearing fields.

Add a validated `-ClientLabel` parameter to `start-mcp-stdio.ps1`, defaulting to
`manual`. Serve passes the Node title before the server path and the client label
after it. Verify passes the label as verifier control input to
`verify-mcp-server.mjs`; the verifier consumes and validates it separately from
configuration arguments, then gives `verifyMcpServer` a typed `hostClientLabel`.
The spawned MCP session must use the same Node-title/server-label layout;
labeling only the short-lived verifier process is insufficient.

Export one strict `partitionMcpHostArguments` implementation from
`src/mcp-host-identity.ts` and reuse it in `src/index.ts` and the verifier-facing
setup path. `verify-mcp-server.mjs` passes only the partitioned configuration
arguments as `startupArguments`; `verifyMcpServer`, `explicitConfigPath`, and
`loadConfig` must never receive the host flag.

Keep `ServerVerificationReport.startupArguments`, setup receipts, and
`register-clients-cli`'s zero-configuration-argument gate scoped only to actual
server configuration. `--mcp-client-label` must never reach `loadConfig` or be
stored in that array. Extend `ServerVerificationSessionOptions` with separate
Node and host-identity arguments; the default transport constructs
`[...nodeArguments, serverPath, ...hostArguments, ...startupArguments]`. Preserve
direct injected-test session seams and the compiled-server probe.
`ServerVerificationReport.startupArguments` remains configuration-only, so this
commit does not bump the verification-report or setup-receipt schema.

Upgrade Describe to schema version 2 with these exact fields:

```text
schemaVersion: 2
mode: Describe
command
nodeVersion
nodeArguments: [--title=ReforgerForge-MCP-<client>]
serverPath
verifierPath
hostArguments: [--mcp-client-label, <client>]
configurationArguments: [...]
```

Remove the ambiguous v1 `startupArguments` field from the v2 descriptor. The full
Serve argv is `[...nodeArguments, serverPath, ...hostArguments,
...configurationArguments]`. Describe must not start a process. The external
sibling-workspace `start_mcp.ps1` wrappers are not generated by this repository;
leave them unchanged and let the shared launcher's `manual` default label them.
Do not promise out-of-repo wrapper edits.

Update the Claude Desktop, Cursor, and VS Code templates with their exact trusted
labels. The generic stdio template uses an explicit
`REPLACE_WITH_CLIENT_LABEL` placeholder in both positions, alongside its existing
path placeholder; template validation must reject either placeholder if it reaches
an attempted launch/verification. Do not silently claim the generic template is a
known client.

Update `agents/install-agents.ps1`. It currently reuses one direct-Node stdio
entry across several clients and has hardcoded Codex comparison/add arguments;
derive a separate labeled entry from each trusted agent key, update every
current-entry comparison, and keep its one pre-selection verification invocation
with the truthful host label `agent-installer`. Do not move verification inside
the per-client loop or mislabel an `-All` verification as one installed client.
Pin its legacy `claude` selector to the canonical
`claude-desktop` label; the other selector/label mappings are `codex`, `cursor`,
`antigravity`, `windsurf`, `vscode`, `continue`, and `kiro`. Preserve its
supported-client set and existing mutation semantics. The installer's unguarded
Codex remove/add rollback weakness is separate work and must not be described as
already protected by this labeling commit.

Update `scripts/setup.ps1`'s direct verifier invocation to pass the trusted
diagnostic label `setup` through the verifier-control path. This label must not
appear as a configuration startup argument in its receipt.

Update `scripts/check-package.mjs` so its explicit distribution inventory requires
the new `dist/mcp-host-identity.js`; `package.json.files` already includes all of
`dist` and needs no packaging entry solely for that module.

Do not create or copy a renamed `node.exe`, add a resident wrapper process, or
change the Node installation. A branded native/single executable is a separate
future packaging decision, not a hidden side effect of setup.

## Diagnostic projection

Add a bounded `mcpHost` block to `wb_diagnose` containing exactly the public host
identity fields above. `wb_diagnose` obtains its report through
`WorkbenchSessionController.diagnose()` and `diagnoseWorkbench`; add the trusted
identity to the controller/diagnostic option path rather than constructing it in
the tool registrar. The same instance UUID must match Workbench lease-owner
diagnostics and owned-runtime manager evidence created by this process. Do not
expose executable identity, user SID, owner tokens, command lines, environment,
or any other/unvalidated client-provided strings.

The diagnostic is informational. PID or instance UUID alone does not authorize
termination, lifecycle mutation, lease preemption, or runtime stop. Documentation
must tell operators to use the exact supported shutdown/status surfaces rather
than killing a process by name.

Keep `mcpHost` and this commit's fixed-field startup record identity-only. Commit
14 uses this UUID for host-scoped readiness and admission fencing; Commit 15 adds
a sibling bounded `mcpLifecycle` block keyed to the same `instanceId`. Its
effective timeout remains in runtime/setup diagnostics rather than weakening this
commit's prohibition on configuration values in the startup record. Neither
follow-up may reinterpret client label, PID, process title, or UUID as
cross-process idle or termination authority. Commit 15's two-host acceptance must
prove that one host's idle exit never signals, releases, or mutates the other host
or the other's lifecycle evidence.

## Tests

Cover:

- strict host-label parsing, defaulting, bounds, and hostile inputs;
- one generated UUID reused by startup diagnostics, Workbench diagnostics,
  Workbench lifecycle ownership, and the owned-runtime manager;
- two hosts receiving distinct identities;
- stderr-only startup reporting with no stdout bytes;
- exact eight-hex process-title formatting, the 80-character cap, and rejection
  without treating the title as executable identity;
- every supported client registration receiving the correct Node-title and
  server-label argument order;
- old unlabeled registration detection, idempotent labeled reinspection, and the
  distinct file-backed rollback versus CLI restoration guarantees;
- PowerShell Serve/Verify/Describe parity and `manual` default behavior;
- verifier stripping host controls before `loadConfig`, preserving configuration-
  only report/receipt arguments, and placing Node options before the real child
  server path;
- package/template/setup contracts including all changed files;
- installer-generated entries for Codex, Cursor, Antigravity, Claude Desktop,
  Windsurf, VS Code, Continue, and Kiro, plus rejection of unreplaced generic
  template labels and exactly one `agent-installer` verification for `-All`;
- `wb_diagnose` public bounds and absence of private identity fields;
- the rendered `wb_diagnose` MCP response carrying the same bounded `mcpHost`
  fields exactly once;
- unchanged PID/creation-time/SID/lease/token enforcement in Workbench and owned
  runtime lifecycle tests.

In `tests/setup/mcp-host-process-identity-windows.test.ts`, add a Windows black-box
acceptance that starts the built server from an exact managed descriptor, captures
its PID/creation identity, and invokes `workbench-lifecycle.ps1 InspectProcess`
directly with `expectedArguments` to attest the product/client marker in the real
command line. The current TypeScript backend's public `inspectProcess` forwards
only `expectedOwnerTokenArgument`, so do not pretend it exposes this assertion.
Assert separately that the image path/name remains the configured Node executable.
Start two different client labels concurrently, prove they are distinguishable,
and clean up only the exact spawned handles. Do not make WMI availability or Task
Manager UI automation a CI dependency.

## Validation

```powershell
npx vitest run tests/mcp-host-identity.test.ts tests/workbench/diagnostics.test.ts tests/workbench/wb-diagnose-tool.test.ts tests/workbench/process-guard.test.ts tests/workbench/server-composition.test.ts tests/workbench/workbench-session-controller.test.ts tests/observer/owned-runtime-manager-host-identity.test.ts tests/setup/client-registration.test.ts tests/setup/client-registration-inspection.test.ts tests/setup/client-registration-issue03-safety.test.ts tests/setup/start-mcp-stdio.test.ts tests/setup/server-verification.test.ts tests/setup/build-verification-deduplication.test.ts tests/setup/mcp-host-process-identity-windows.test.ts tests/config-installation-contract.test.ts
npm run test:stage3
npm run test:stage4
npm run test:cross-cutting:baseline
npm run test:package
npm run typecheck
npm run build
```

Run the Windows black-box command-line attestation with a built package before
shipping. Manually confirm the Task Manager Details view can enable Command line
and distinguish at least two supported client labels. Record that Image name
remains `node.exe` for the ordinary distribution.

## Commit acceptance

- Every managed client launch has a visible product/client command-line marker.
- One process-wide UUID/PID appears consistently in bounded diagnostics and both
  lifecycle subsystems.
- Task Manager documentation accurately distinguishes Command line, process
  title, PID, and executable Image name.
- Existing registrations migrate through guarded setup semantics and remain
  idempotent afterward.
- Stdio stdout, lifecycle authority, shutdown, and runtime ownership behavior are
  unchanged.
- No game-process inventory, game-launch behavior, native wrapper, copied Node
  binary, or single-executable packaging is added.
