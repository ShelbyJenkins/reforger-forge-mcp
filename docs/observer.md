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

1. Begin a managed evidence run with `observer_run_begin`. It becomes the
   active run for this MCP process.
2. Make a renderer available: launch an instrumented runtime or launch
   Workbench.
3. Submit `observer_capture`. If exactly one compatible renderer exists,
   selection is automatic; otherwise inventory with `observer_instances` and
   pass one returned opaque `target`.
4. Let Observer allocate the capture label, or provide a meaningful label when
   the evidence procedure requires one.
5. Inspect the image and job result. For async work, wait for a terminal job
   before cleanup.
6. Finalize reviewed labels to an allowlisted evidence root, or discard the
   run.
7. If you used a managed runtime, stop it only after every capture has reached
   terminal camera restoration.

Do not reuse a target after a renderer restarts or becomes stale. Inventory
again and use the new opaque target. A targetless delegated capture may refresh
one submit-time world change on the same exact renderer; it never switches
instances during that retry.

## Start an evidence run

Use a title that tells a reviewer what is being demonstrated. `caseIds`, source
revision, and procedure revision make the final bundle easier to audit.

```json
{
  "title": "Vehicle damage-state verification",
  "caseIds": ["VEH-DAMAGE-01"],
  "sourceRevision": "<commit-or-working-tree-id>",
  "procedureRevision": "<procedure-id-or-version>",
  "idempotencyKey": "vehicle-damage-01-run"
}
```

The returned run becomes active in this MCP process, so later captures and run
status/finalize/discard calls may omit `runId`. Capture labels may also be
omitted; Observer allocates durable labels such as `current-1` or `pose-2`.
Pass an explicit run ID when intentionally operating on another run.

## Choose and prepare a backend

### Runtime capture

For the normal exact-owned path, call the `game_launch` composite. It resolves an
explicit absolute `gprojPath` or the currently owned Workbench project's path as
a selection hint, chooses one registered project-contained world, proves the
target add-on and its transitive dependencies, derives a private per-project
profile, prepares Observer, and starts only through the exact-owned runtime
manager:

```json
{
  "action": "start",
  "gprojPath": "C:\\Projects\\MyMod\\MyMod.gproj",
  "world": "Worlds/MyScenario.ent",
  "runtimeKind": "listenServer",
  "waitForInstanceMs": 60000
}
```

Omitting `action` means `start`; `runtimeKind` defaults to `listenServer`.
`client` maps to `-world`, while `listenServer` maps to `-server`. Extra
`arguments` cannot replace composite-owned project, world, add-on, profile,
display, or owner-token fields. The result contains the exact `runtimeId`,
`sessionId`, canonical project/profile/world, emitted and implicit add-on roots,
final prepared argument vector, matching instances, and status/capture/stop
guidance. A readiness timeout is partial success: the process remains visible in
the result and must still be inspected or stopped.

This baseline intentionally retains one initial launch family per derived
project profile. An identical request in the same MCP lifecycle recovers the
same preparation/runtime without spawning twice. Changed, invalidated, stale,
expired, or terminal evidence fails closed; it does not create a successor.
Use a fresh isolated managed/profile root and MCP lifecycle for a deliberate
second baseline generation until durable successor support is available.
The manager re-attests the original project, world metadata, dependency
manifests, and executable immediately before descriptor consumption. This
narrows but cannot eliminate the ordinary external-filesystem race in which an
unrelated process replaces a file after that check; spawn still performs its
own final executable identity verification.

For an external launcher or low-level diagnosis, `observer_prepare_launch`
remains available. Supply normal graphical runtime arguments and an exclusive,
Observer-approved outer `profilePath`. It returns prepared argument tokens, an
opaque `preparedLaunchId`, and session metadata without starting the game. It
also assigns one relative, session-specific `-logsDir` whose physical log is
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

You can pass primitive preparation arguments unchanged to your own launcher. On
Windows, `observer_runtime action: "start"` consumes its `preparedLaunchId` and
returns the `runtimeId`; this primitive path remains public and is not replaced
by `game_launch`.

Retain the **`sessionId` returned by either launch path** for inventory and the
legacy explicit-capture form. The preferred opaque inventory target carries
that binding internally, and `observer_job` requires only its `jobId`. A
`runtimeId` identifies an exact-owned process for lifecycle operations; it is
not a capture-session identifier.

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
When an explicit view is requested and the helper exposes the restoration API,
Observer automatically performs and releases one internal current-view capture,
re-inventories the same editor, and proceeds only after `camera.editor` is
proven. This priming repeats after an editor restart.

Observer does not start Workbench, enter Play mode, save resources, reload
scripts, or shut down the editor as part of capture. Follow the normal
Workbench workflow in [agents/AGENTS.md](../agents/AGENTS.md) for those
operations.

If internal priming fails, Observer never submits the requested pose or
look-at view. It attempts the same restoration and release path as any other
runless capture; when cleanup cannot be proved, the error includes the retained
prime job ID so `observer_job` can be used to recover it before retrying.

## Inventory and renderer targets

For the common case, omit renderer-selection fields. Observer inventories both
backends and delegates only when exactly one compatible renderer exists. With
multiple candidates it returns `AMBIGUOUS_INSTANCE` and bounded candidate
records containing opaque `target` values.

Use one `ct1...` target returned by `observer_instances` when selection must be
explicit. The token binds backend, exact instance, runtime session when
applicable, and world revision. Treat it as opaque and short-lived. `target`
cannot be combined with legacy `sessionId`, `instanceId`, or
`expectedWorldRevision` fields. Those legacy fields remain a compatibility
path and must be supplied as one complete explicit binding.

## Capture an image

Start with `current`: it records the existing renderer view and is the least
intrusive choice. Use `pose` only when you have a known position, normalized
quaternion, and field of view. Use `lookAt` for a reproducible position, target,
and field of view; its position and target must differ.

When exactly one compatible renderer is available, the ordinary screenshot
request is simply:

```json
{}
```

With an active evidence run it receives the next durable `current-N` label.
Without an active or explicit run it is runless and automatically attempts to
release the validated artifact after delivery.

The following is a synchronous capture in the active run. Omit `target` when
there is exactly one compatible renderer; otherwise copy one target from
inventory.

```json
{
  "purpose": "Show the vehicle after the damage sequence.",
  "target": "<opaque-inventory-target-if-selection-is-ambiguous>",
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
call `observer_job action: "read"` if the image fits the inline limit. Every
job operation takes only `action` and `jobId`; backend and runtime session
authority remain internal.
If an image is too large to return inline, leave it managed for run
finalization—do not seek a private artifact path.

Use `observer_job action: "cancel"` for unwanted work and wait until the job is
terminal. `observer_job action: "release"` cannot release an artifact retained
by an open run; finalize or discard that run instead. Runless synchronous
captures, successful asynchronous reads, safe terminal cancellations, and
oversized inline deliveries automatically attempt release. If cleanup cannot
be proven, the result retains the job and reports `cleanupRequired`.

## Review and finalize

Inspect every selected image at an appropriate resolution before finalizing.
Set `imagesReviewed` to `true` only after that review and supply a stable
reviewer identity. Use `Unreviewed` or `Inconclusive` when the image has not
been reviewed or cannot support a conclusion.

```json
{
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
use `observer_run_discard` instead.

## Clean up safely

Before stopping an exact-owned runtime:

1. Cancel unwanted jobs.
2. Poll each job until its camera restoration is terminal.
3. Finalize or discard the evidence run.
4. Call `game_launch action: "stop"` for a composite-started runtime, or
   `observer_runtime action: "stop"` for a primitive-started runtime, with its
   exact `runtimeId` and a bounded `waitForRestorationMs`.

Both owned stop paths stop only a process the manager started and exactly
verified. Do not
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
| `CAPABILITY_UNAVAILABLE` for `pose` or `lookAt` | Use `current`, or choose an instance advertising `camera.runtime`. Workbench priming is automatic when its exact restoration API is available. |
| `AMBIGUOUS_INSTANCE` | Choose one candidate `target` from the error details or from `observer_instances`. |
| `WORLD_CHANGED` or stale target | Run `observer_instances` again and use the new opaque target. |
| Legacy runtime capture rejects a missing session | Prefer the opaque runtime target, or supply the complete legacy binding from inventory; do not use the runtime lifecycle ID as a substitute. |
| An image cannot be read inline | Leave it managed and finalize the run; oversized images are intentionally not exposed by private path. |
| Finalization is unavailable or ambiguous | Configure an evidence root, or provide the chosen root when several are allowlisted. |
| Semantic runtime log admission is refused | Select the completed runtime capture for export and confirm it came from the exact process started by `game_launch` or `observer_runtime`. For external launches, configure a narrow supporting-log root and use the `path` form. |
| Managed runtime stop reports a busy camera | Cancel or finish the captures, wait for terminal restoration through `observer_job`, then retry the same stop operation with an appropriate bound. |
| Runtime status is `identity_mismatch`, `unverifiable`, or `stale` | Do not terminate by PID or name. Preserve the receipt and investigate the configured executable, owner identity, and lifecycle state. |

## API quick reference

| Tool | Use it for |
|---|---|
| `observer_setup` | Inspect, stage, or uninstall managed observer companions. |
| `game_launch` | Plan, start, inspect, or stop one fail-closed exact-owned graphical runtime. |
| `observer_prepare_launch` | Produce instrumented runtime arguments and a runtime capture session. |
| `observer_runtime` | Start, inspect, or stop an exact-owned Windows runtime. |
| `observer_instances` | Find compatible runtime or Workbench renderers and obtain world bindings. |
| `observer_capture` | Submit a current, pose, or look-at capture, optionally attached to an active or explicit run. |
| `observer_job` | Inspect, read, cancel, or release a capture job. |
| `observer_run_begin` | Begin and activate a managed evidence run. |
| `observer_run_status` | Inspect an explicit or active run. |
| `observer_run_finalize` | Export reviewed labels from an explicit or active run. |
| `observer_run_discard` | Discard an explicit or active unfinalized run. |

For exhaustive field descriptions, use the schemas and descriptions supplied by
your MCP client. For technical implementation details and maintainer validation,
see [observer/README.md](../observer/README.md).
