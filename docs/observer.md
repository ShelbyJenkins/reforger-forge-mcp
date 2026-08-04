# Observer usage guide

Observer captures validated PNG, JPEG, or WebP evidence from either a graphical Arma Reforger
runtime or an already-running Workbench editor. It manages the capture
transaction, camera restoration, and optional evidence export; it does not
prove the gameplay claim shown in an image. A person must review the selected
images before recording a passing or failing result.

Use this guide for normal Observer operation. For installation and configuration,
see [SETUP.md](../SETUP.md). For coding-agent routing and API notes, see
[agents/AGENTS.md](../agents/AGENTS.md). The technical design, safety model, and
maintainer checks live in [observer/README.md](../observer/README.md).

## Before the first capture

1. Complete the Observer portion of [SETUP.md](../SETUP.md), including an
   evidence destination if you intend to finalize a bundle.
2. Call `observer_setup` with `action: "doctor"` to inspect the configured
   roots without changing them. Use `action: "ensure"` to verify and stage the
   runtime observer and Workbench helper.
3. Choose the backend you will use:
   - **Runtime:** prepare an observer launch, then start it externally or with
     the optional managed runtime lifecycle.
   - **Workbench:** launch the exact target `.gproj` with `wb_launch` first.
     Observer never launches Workbench for a capture.

The most useful tool descriptions and full input schemas are advertised by the
MCP client. This guide supplies the safe call order and the values that must be
carried from one call to the next.

## The capture lifecycle

Every evidence capture follows this sequence:

1. Begin a managed evidence run with `observer_run action: "begin"`.
2. Make a renderer available: launch an instrumented runtime or launch
   Workbench.
3. Inventory renderers with `observer_instances` and choose one explicit,
   healthy `instanceId`.
4. Submit `observer_capture`, binding it to the world reported by that exact
   inventory result.
5. Inspect the image and job result. For async work, wait for a terminal job
   before cleanup.
6. Finalize reviewed labels to an allowlisted evidence root, or discard the
   run.
7. If you used a managed runtime, stop it only after every capture has reached
   terminal camera restoration.

Do not reuse an inventory result after a renderer changes world, restarts, or
becomes stale. Inventory again and submit a new world binding.

## Start an evidence run

Use a title that tells a reviewer what is being demonstrated. `caseIds`, source
revision, and procedure revision make the final bundle easier to audit.

```json
{
  "action": "begin",
  "title": "Vehicle damage-state verification",
  "caseIds": ["VEH-DAMAGE-01"],
  "sourceRevision": "<commit-or-working-tree-id>",
  "procedureRevision": "<procedure-id-or-version>",
  "idempotencyKey": "vehicle-damage-01-run"
}
```

Keep the returned `runId`. Every capture belongs to one open run and every
`captureLabel` must be meaningful and unique within that run.

## Choose and prepare a backend

### Runtime capture

Call `observer_prepare_launch` with the normal graphical runtime arguments and
an exclusive, Observer-approved outer `profilePath`. It returns prepared
argument tokens, an opaque `preparedLaunchId`, and session metadata. Preparation
does not start the game. It also assigns one relative, session-specific
`-logsDir` whose physical log is
`<profilePath>/profile/logs/observer-<sessionId>/script.log`; caller-supplied
`-logsDir` values are refused.

Preparation defaults `noFocus` and `forceUpdate` to true. Graphical launches use
the engine's native borderless fullscreen by default without stealing startup
focus. Keep that default for normal Observer work. Raw `-window`, `-screenWidth`,
and `-screenHeight` tokens in `arguments` are refused.

`forceNonNativeWindowSize` is the only supported direct window-size override.
It requires bounded `width` and `height` values plus a meaningful
`justification`, and should be
present only when native fullscreen cannot be used for a compelling external
reason. Screenshot size is not such a reason: use the `observer_capture.image`
output bounds described below while leaving the launched renderer fullscreen.

You can pass the returned arguments unchanged to your own launcher. On Windows,
you can instead call `observer_runtime action: "start"` with the
`preparedLaunchId` and a unique `idempotencyKey`; retain the returned `runtimeId`
for later status and stop calls.

Retain the **`sessionId` returned by launch preparation**. A runtime
`observer_capture` or `observer_job` call requires that `sessionId`. A
`runtimeId` identifies an exact-owned process for lifecycle operations; it does
not replace the runtime session ID used by capture operations.

After the runtime registers, query it with:

```json
{
  "sessionId": "<prepared-session-id>",
  "requiredCapabilities": ["render.capture"],
  "renderersOnly": true,
  "waitMs": 30000
}
```

Select one healthy runtime instance from the response. A runtime that reports
`render.capture` supports `current` capture. `pose` and `lookAt` also require
the same instance to advertise `camera.runtime`.

### Workbench capture

Start the exact project with `wb_launch`, wait for a working Workbench bridge,
and then inventory renderers:

```json
{
  "requiredCapabilities": ["render.capture"],
  "renderersOnly": true,
  "waitMs": 30000
}
```

Select the Workbench instance returned by inventory. Omit `sessionId` for this
backend. A newly launched editor may initially support only `current` capture.
Complete one successful current-view capture after each Workbench restart before
requesting `pose` or `lookAt`; the restoration proof enables the
`camera.editor` capability.

Observer does not start Workbench, enter Play mode, save resources, reload
scripts, or shut down the editor as part of capture. Follow the normal
Workbench workflow in [agents/AGENTS.md](../agents/AGENTS.md) for those
operations.

## Inventory and world binding

Capture requests must identify the chosen renderer and bind it to the world
from the immediately preceding `observer_instances` result. Carry forward:

- `instanceId`
- `worldRevision`

Use the opaque `expectedWorldRevision` from inventory for every new capture.
The public capture input does not accept separate world-ID or epoch fields. A
runtime revision may represent no loaded world; `current` capture remains
available for that rendered state, while `pose` and `lookAt` require an active
world.

If the tool reports `WORLD_CHANGED`, inventory again. Do not reuse a world
binding from a different renderer.

## Capture an image

Start with `current`: it records the existing renderer view and is the least
intrusive choice. Use `pose` only when you have a known position, normalized
quaternion, and field of view. Use `lookAt` for a reproducible position, target,
and field of view; its position and target must differ.

The following is a synchronous runtime current-view capture. For Workbench,
omit `sessionId` but use the selected Workbench `instanceId` and its inventory
world revision.

```json
{
  "runId": "<managed-run-id>",
  "captureLabel": "vehicle-damaged-runtime-current",
  "purpose": "Show the vehicle after the damage sequence.",
  "sessionId": "<prepared-session-id>",
  "instanceId": "<selected-runtime-instance-id>",
  "expectedWorldRevision": "<inventory-world-revision>",
  "view": { "kind": "current" },
  "asynchronous": false,
  "timeoutMs": 30000,
  "settleFrames": 0,
  "performancePolicy": "evidence",
  "image": {
    "maxWidth": 1920,
    "maxHeight": 1080,
    "format": "webp",
    "quality": 75
  }
}
```

The optional `image` object limits the output while preserving aspect ratio and
never enlarging the source. Either dimension may be supplied independently.
`format` accepts `png`, `jpeg`, or `webp`; JPEG and WebP accept quality from 1
through 100 within the operator-configured range. PNG is lossless and rejects a
quality value. Omitting `image` preserves native resolution and returns PNG.
The effective image policy is part of capture idempotency.

Synchronous mode returns one host-validated image with its actual MIME type and metadata when it fits the
MCP inline limit. It is best for interactive review. A completed capture proves
that the image was validated, bound to the selected world, and reached terminal
camera restoration; it does not prove the assertion depicted by the image.

Use `asynchronous: true` when you need to avoid an inline wait. Keep the
returned `jobId`, then call `observer_job action: "status"`. Once complete,
call `observer_job action: "read"` if the image fits the inline limit. Runtime
job calls use the same `sessionId` as capture; Workbench job calls omit it.
If an image is too large to return inline, leave it managed for run
finalization—do not seek a private artifact path.

Use `observer_job action: "cancel"` for unwanted work and wait until the job is
terminal. `observer_job action: "release"` cannot release an artifact retained
by an open run; finalize or discard that run instead.

## Review and finalize

Inspect every selected image at an appropriate resolution before finalizing.
Set `imagesReviewed` to `true` only after that review and supply a stable
reviewer identity. Use `Unreviewed` or `Inconclusive` when the image has not
been reviewed or cannot support a conclusion.

```json
{
  "action": "finalize",
  "runId": "<managed-run-id>",
  "evidenceRoot": "<configured-allowlisted-evidence-root>",
  "includeCaptureLabels": ["vehicle-damaged-runtime-current"],
  "review": {
    "imagesReviewed": true,
    "reviewer": "<stable-reviewer-id>",
    "outcome": "Passed",
    "summary": "Reviewed the bound runtime image against VEH-DAMAGE-01."
  },
  "supportingFiles": [{
    "kind": "relevantLog",
    "label": "runtime",
    "sourceCaptureLabel": "vehicle-damaged-runtime-current"
  }],
  "releaseManagedArtifacts": true
}
```

When exactly one evidence root is configured, `evidenceRoot` may be omitted.
With more than one configured root, provide the intended allowlisted root
explicitly. Finalization creates `<evidenceRoot>/<runId>/` with `RESULT.md`,
`manifest.json`, and selected capture image/JSON pairs using the actual image
extension. It does not overwrite
an existing bundle.

For a selected, completed runtime capture started through `observer_runtime`,
the semantic `sourceCaptureLabel` form above resolves only the private durable
grant for that exact runtime generation and its assigned `script.log`. The
profile directory is not added to an allowlist, and Workbench, unselected,
external, or otherwise unowned captures cannot mint this authority.

The existing `path` form remains available for regular text logs beneath an
explicitly configured `observer.supportingLogRoots` entry. Use that form for
external launches and operator-managed logs. Both forms receive the same size,
UTF-8, redaction, regular-file, link, and identity-change checks before the
copied log is hashed into `manifest.json`. If the run should produce no bundle,
use `observer_run action: "discard"` instead.

## Clean up safely

Before stopping an exact-owned runtime:

1. Cancel unwanted jobs.
2. Poll each job until its camera restoration is terminal.
3. Finalize or discard the evidence run.
4. Call `observer_runtime action: "stop"` with its `runtimeId`, a unique
   `idempotencyKey`, and a bounded `waitForRestorationMs`.

`observer_runtime` stops only a process it started and exactly verified. Do not
substitute a PID, executable name, `taskkill`, or a broad process-tree command
when a stop is refused. Preserve the returned diagnostic and resolve active jobs
or identity issues first.

For Workbench, restore or cancel all captures before ending live automation,
then follow the normal owner-scoped editor shutdown process.

## Common operator problems

| Symptom | What to do |
|---|---|
| `observer_setup` reports a missing or unsuitable root | Run `observer_setup action: "doctor"`, then correct the explicit Observer configuration in [SETUP.md](../SETUP.md). |
| No renderer appears | Confirm the runtime was launched from the prepared arguments, or that the exact Workbench `.gproj` is running through `wb_launch`; then inventory again with a bounded `waitMs`. |
| `CAPABILITY_UNAVAILABLE` for `pose` or `lookAt` | Use `current`, or choose an instance advertising `camera.runtime` or `camera.editor`. A new Workbench instance needs one successful current-view capture first. |
| `WORLD_CHANGED` | Run `observer_instances` again and copy the new world binding into a new capture request. |
| Runtime capture rejects a missing session | Supply the `sessionId` from `observer_prepare_launch`; do not use the runtime lifecycle ID as a substitute. |
| An image cannot be read inline | Leave it managed and finalize the run; oversized images are intentionally not exposed by private path. |
| Finalization is unavailable or ambiguous | Configure an evidence root, or provide the chosen root when several are allowlisted. |
| Semantic runtime log admission is refused | Select the completed runtime capture for export and confirm it came from the exact process started by `observer_runtime`. For external launches, configure a narrow supporting-log root and use the `path` form. |
| Managed runtime stop reports a busy camera | Cancel or finish the captures, wait for terminal restoration through `observer_job`, then retry the same stop operation with an appropriate bound. |
| Runtime status is `identity_mismatch`, `unverifiable`, or `stale` | Do not terminate by PID or name. Preserve the receipt and investigate the configured executable, owner identity, and lifecycle state. |

## API quick reference

| Tool | Use it for |
|---|---|
| `observer_setup` | Inspect, stage, or uninstall managed observer companions. |
| `observer_prepare_launch` | Produce instrumented runtime arguments and a runtime capture session. |
| `observer_runtime` | Start, inspect, or stop an exact-owned Windows runtime. |
| `observer_instances` | Find compatible runtime or Workbench renderers and obtain world bindings. |
| `observer_capture` | Submit a current, pose, or look-at capture to an open run. |
| `observer_job` | Inspect, read, cancel, or release a capture job. |
| `observer_run` | Begin, inspect, finalize, or discard a managed evidence run. |

For exhaustive field descriptions, use the schemas and descriptions supplied by
your MCP client. For technical implementation details and maintainer validation,
see [observer/README.md](../observer/README.md).
