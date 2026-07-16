# Reforger Forge MCP 1.1.0

This release replaces the previous best-effort Workbench launch/restart path
with a Windows-only, exact-owner lifecycle coordinator.

## Workbench lifecycle changes

- `wb_launch`, automatic launch, `wb_restart`, `wb_shutdown`, cleanup, and
  unexpected-exit recovery share one target-aware coordinator and one global
  Windows named mutex.
- Durable version-2 lifecycle state records the MCP lease and the exact
  Workbench PID, executable path, process creation time, canonical `.gproj`,
  endpoint, generation, owner-token argument, phase, and handler transaction.
- A replacement MCP can claim a lease only after the prior MCP's exact process
  identity is dead. A live owner, a different Windows user, a user-launched
  Workbench, or an unverifiable process fails closed without signalling it.
- `wb_shutdown` stops only the exact verified owner process. Cleanup is refused
  while any Workbench may be watching the target and removes only unchanged,
  manifest-owned handler files.
- Handler installation is hashed and transactional. Restart completes all
  executable, argument, target, bundle, manifest, and collision preflight before
  stopping a healthy Workbench. Failure rollback retains durable recovery data.

## Migration and operator notes

- If a live Workbench still has the legacy version-1 owner marker, close it once
  manually. The next lifecycle operation can then archive the legacy marker and
  initialize version-2 state.
- If no prior verified target exists, omitting `gprojPath` succeeds only when
  configuration resolves to exactly one `.gproj`. Ambiguity is refused and the
  candidates are listed; call `wb_launch` with an explicit path.
- Workbench Play remains an attended manual action. Confirm it with the user,
  enter Play in Workbench, verify with `wb_state`, and use `wb_stop` to return to
  edit mode.
- Exact process-identity and global-mutex guarantees are supported on Windows.
  Other platforms refuse automated lifecycle mutation.
