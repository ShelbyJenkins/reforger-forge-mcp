# Outstanding MCP Bugs

This FIFO queue contains unintended, reproducible failures of the supported
MCP contract. Append new findings at the bottom; move resolved entries to
[MCP_BUGS_RESOLVED.md](MCP_BUGS_RESOLVED.md).

### MCP-006 — resource registration can stall and disconnect Workbench

**Status:** Open

**Severity:** Non-breaking authoring failure

**Observed:** 2026-07-28

`wb_resources(action: "register")` timed out after 10 seconds while registering
a newly created Sedan material. The next request reported an unknown Workbench
mode, and `wb_diagnose` found that bridge Ping also timed out.

**Impact:** Registration cannot be relied on during an active target-bound
authoring session and may require closing the exact owned editor.

**Workaround:** Safely close the unsaved target session, reopen the same
explicit prefab after the material files exist, and use Workbench to create the
material slots and save the assignment. Do not patch the prefab directly as a
substitute.

### MCP-010 — guarded build reports a non-vacant endpoint after its process exits

**Status:** Open

**Severity:** Breaking validation failure

**Observed:** 2026-07-28

A fresh `wb_build` retry failed with `ENDPOINT_UNVERIFIABLE`, reporting that TCP
`127.0.0.1:5775` remained owned by a PID after Workbench exited. An immediate
read-only process check could not find that PID.

**Impact:** The guarded lifecycle can block subsequent builds after a
Workbench crash even when the reported owner no longer exists.

**Workaround:** Pending. Do not terminate a process when the reported target
cannot be verified as a currently owned Workbench process.
