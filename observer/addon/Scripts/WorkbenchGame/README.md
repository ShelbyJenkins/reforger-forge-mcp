# Workbench adapter boundary

Workbench capture is implemented by the MCP server's existing transactional
handler bundle under `mod/Scripts/WorkbenchGame/EnfusionMCP`. It reuses the
shared `WorkbenchClient`, lifecycle activity gate, canonical project identity,
and exact-process ownership checks.

No Workbench implementation is loaded from this standalone runtime addon. This
directory is retained only to make that package boundary explicit.
