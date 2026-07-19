# Observer protocol capabilities

Generated contract view of `CAPABILITY_REGISTRY` in `registry.ts`. A capability
is routable only on a backend listed below and only after that backend's
producer proves initialization. Unknown claims remain diagnostic and are never
used for routing.

| Capability | Proving backend | Required proof |
|---|---|---|
| `render.capture` | runtime, workbench | Initialized native PNG capture with backend readiness checks. |
| `camera.runtime` | runtime | Runtime camera lease, ownership, and exact restoration transaction. |
| `camera.editor` | workbench | Per-lifecycle current-view transaction proves exact editor-camera restoration. |
| `world.query` | runtime | Runtime reports nullable world identity and monotonic world epoch. |
| `authority.server` | runtime | Runtime replication API proves active server authority. |
| `transport.rest` | runtime | Runtime REST transport completed initialization. |
| `transport.mailbox` | runtime | Runtime mailbox transport completed initialization and bounded disposition handling. |

`entity.resolve` and `server.coordinate` are deliberately absent until an
implementation and conformance test can prove them. Headless runtimes also
strip render/camera claims; a runtime can never route `camera.editor` merely
because that capability is globally known for Workbench.
