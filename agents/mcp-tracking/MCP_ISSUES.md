# Outstanding MCP Issues

This FIFO queue contains open contract decisions, acknowledged limitations, and
deferred improvements that are not currently a broken supported behavior.
Append new findings at the bottom; move resolved or verified records to
[MCP_ISSUES_RESOLVED.md](MCP_ISSUES_RESOLVED.md).

## MCP-052 - add a guarded compile-only Enforce Script check

**Status:** Open

**Priority:** P1

**Observed:** 2026-08-02

**Classification:** Deferred workflow and API improvement; the current tools
behave as documented, but neither is an efficient script-compilation preflight.

**Observed behavior:** An agent can currently discover Enforce Script compiler
errors by launching an attended editor with `wb_launch` or by running the full
`wb_build` data-build transaction. The former opens Workbench and may spend its
readiness interval diagnosing a compile failure; the latter requires a unique
empty output directory and builds resources that are irrelevant to a fast
edit/check loop. `mod(action: "validate")` is static and explicitly does not
compile Enforce Script.

**Research:** Bohemia's
[official Workbench startup-parameter reference](https://community.bistudio.com/wiki/Arma_Reforger%3AStartup_Parameters)
documents a native compile-only route:

- `-wbModule=ScriptEditor` selects Script Editor; the equals-sign form is
  required;
- `-validate [configuration]` checks whether game scripts compile and returns
  Workbench code `0` for success or `-1` for compilation failure; its optional
  value is a script configuration such as `PC`;
- `-wbsilent` initializes the engine and Workbench modules without opening
  windows, then exits, and is explicitly described as usable for script
  compilation validation;
- `-gproj`, `-gprojConfig`, `-profile`, and `-noThrow` provide the existing
  exact-project, configuration, private-state, and unattended-dialog controls.

This is still a Workbench executable invocation, not a separate Enforce
compiler. It is nevertheless materially narrower than `ResourceManager
-buildData`, which builds all add-on data and produces a resource database.

The current implementation already owns most of the safety boundary needed by
this feature. [`wb_build`](../../src/tools/wb-build.ts) enters the active MCP
owner's lifecycle, and the
[runner](../../src/workbench/runner.ts) plus
[launch planner](../../src/workbench/launch-plan.ts) perform dependency-GUID
preflight, target re-attestation, private-profile creation, exact-child
supervision, timeout/abort handling, attributed-log discovery, cleanup, and
endpoint-vacancy proof. Existing
[compile diagnostics](../../src/workbench/compile-diagnostics.ts) already
recognize `Can't compile "<module>" script module!`, retain bounded diagnostics,
and attribute them only through a private owner token. MCP-051 verified that
parser for failed editor launches.

**Recommended contract:** Add one implementation with two surfaces:

```text
MCP: reforger-forge.wb_check
CLI: reforger-forge-workbench check --gproj <path> --configuration PC --timeout-ms <n>
```

The MCP input should require an exact absolute `gprojPath`, accept an explicit
script `configuration` (initial default: `PC`), and accept a bounded timeout.
It should not accept or create a build-output directory. Before spawn, validate
that the named configuration is declared by the target `.gproj` (apart from
any deliberately supported engine sentinel such as `ALL`) and re-attest both
the project identity and dependency resolution at the same boundaries as a
guarded build.

The public operation is an Enforce Script compilation check, not a general
project validator. Its description, result fields, and human-readable output
must say that scripts compiled or failed to compile; they must not describe an
exit-zero result as proof that the project, resources, or packaged add-on are
valid.

The receipt should identify intent `check`, scope `enforceScripts`, and
`engineValidated: true`, along with the exact target add-on and configuration,
exact process identity and lifecycle generation, attributed log directory,
terminal exit classification, and a compilation result. The MCP surface should
declare an output schema for this machine-readable receipt when it is
introduced, with any text rendering derived from the same result. A compiler
failure should be a normal, actionable `PROJECT_COMPILE_FAILED` result carrying
the module and bounded diagnostics when the exact attributed log supports that
classification. Timeouts, aborts, dependency failures, native exceptions, log
attribution failures, and other nonzero exits must remain distinct. The CLI
must map Workbench's documented `-1` failure to a portable nonzero process exit
without losing the native value in its JSON receipt.

**Scope and non-goals:** MCP-052 does not add material or texture validation,
offline resource checks, prefab/world/config validation, or a general claim of
add-on validity. It must not implicitly run `mod(action: "validate")`, stage or
reload the Workbench helper, replace the existing live `wb_validate` contract,
or combine those independently meaningful results into the compile receipt.

**Lifecycle design notes:** Implement this as a helper-free, hidden,
foreground, bounded-exit target operation. It must refuse a live attended or
unowned Workbench, concurrent lifecycle mutation, unresolved spawn recovery,
or a non-vacant endpoint; it must never terminate or reuse such a process.
Generalize the build-specific owner-scoped admission and execution primitives
where their invariants are identical instead of copying them into a second
process launcher. Keep build-output reservation and output attestation confined
to `build`. Review durable operation names, spawn-journal purposes, errors, and
shutdown cancellation so a check is not incorrectly persisted or reported as
a build. The shared primitive must remain operation-neutral, with check-specific
launch planning and terminal-result classification supplied at its boundary;
the initial public contract remains compile-only.

Do not implement this through the older speculative
[`wb_compile` helper plan](../../docs/superpowers/plans/2026-03-19-workbench-api-expansion.md#task-7-new-tool-wb_compile).
That plan guessed unverified in-process APIs such as `ScriptEditor.CompileAll`
and describes a live-editor compile/reload action. A compile-only preflight is
a fresh-process validation transaction and must not reload game scripts in an
attended editor or a loaded world.

**Required characterization before fixing the public argv contract:** The
official reference documents the individual switches but does not fully state
whether the most reliable current-tools invocation combines `-validate` and
`-wbsilent`, whether `-run` is necessary or harmful for validation, or exactly
where the `-1` result appears through Windows/Node process APIs. Use a private
managed profile and the guarded acceptance harness to characterize valid and
intentionally broken fixture projects. Record exact arguments, window
visibility, automatic exit behavior, native exit value, owner-token log
attribution, compiler log shape, and behavior for at least `PC` and one absent
configuration. The implementation should encode only the proven combination.

**Affected areas:** `src/tools/wb-check.ts`, `src/server.ts`,
`src/workbench/launch-plan.ts`, `src/workbench/runner.ts`,
`src/workbench/runner-cli.ts`, the owner-scoped lifecycle boundary in
`src/workbench/session-controller.ts`, compile/log attribution as needed,
focused Workbench tests and acceptance fixtures, the
[runner CLI reference](../../docs/runner-cli.md), `SETUP.md`, and current agent
tool-routing and validation guidance.

**Acceptance criteria:**

1. A valid fixture returns an exit-zero MCP/CLI receipt with intent `check`,
   scope `enforceScripts`, and `engineValidated: true`, without showing a
   Workbench window or producing build artifacts; it reports compilation
   success without claiming whole-project validity.
2. A syntax-broken fixture returns `PROJECT_COMPILE_FAILED` with the exact
   module, useful bounded diagnostics, and exact attributed log evidence.
3. Missing/ambiguous dependencies and unknown configurations fail before
   Workbench spawn with actionable details.
4. Live-editor, unowned-process, endpoint-conflict, timeout, abort, native
   exception, and recovery cases preserve the existing fail-closed lifecycle
   guarantees and leave no unowned child or falsely vacant lease.
5. Target or dependency drift between preflight and spawn is rejected.
6. Registered MCP input/output schemas and description, standalone parser and
   exit mapping, focused unit/integration tests, packaged CLI smoke coverage,
   and operator guidance agree on the same contract.
