# Workbench adapter boundary

Workbench capture is implemented by the MCP-managed companion add-on under
`observer/workbench-addon`. The lifecycle stages that add-on outside the target
project, launches it with an exclusive profile, and verifies its exact build
identity before exposing capture. It reuses the shared `WorkbenchClient`,
activity gate, canonical project identity, and exact-process ownership checks.

No Workbench implementation is loaded from this standalone runtime addon. This
directory is retained only to make that package boundary explicit.
