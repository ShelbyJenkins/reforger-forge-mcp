# Observer protocol capabilities

Protocol 1.0 uses capabilities as initialized-behavior claims, not executable labels.

- `render.capture`: the selected backend initialized current-view screenshot
  output and its readiness checks.
- `camera.runtime`: camera snapshot, installation, ownership, and exact restoration are available.
- `camera.editor`: the exact running Workbench process has completed a
  current-view transaction and proved restoration of its viewport and
  camera-owner transforms, camera IDs, vertical FOV, and near/far planes.
- `world.query`: an active world can be identified and epoch-tracked.
- `entity.resolve`: stable entity resolution is initialized.
- `authority.server` and `server.coordinate`: authority/coordination facts only; neither implies rendering.
- `transport.rest` and `transport.mailbox`: the named transport initialized successfully.

Unknown capabilities are retained in diagnostics and ignored for routing.
Graphical runtime instances never advertise render/camera claims solely because
their compile-time gates are enabled; the corresponding subsystem must also be
initialized. Dedicated/headless instances strip render and camera claims.
Workbench advertises `render.capture` only when current-view output is ready and
resets `camera.editor` after every lifecycle generation change until that exact
process proves a current-view restoration transaction.
