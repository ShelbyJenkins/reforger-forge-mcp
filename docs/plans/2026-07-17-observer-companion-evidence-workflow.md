# Workbench Companion and Managed Evidence Implementation Guide

Status: implemented in the MCP codebase on 2026-07-17. Hermetic validation and
fresh five-capture real-engine Workbench automation have passed. The exported
bundle remains formally `Unreviewed`, so recorded evidence review is still
required before the companion-based editor path is advertised as live-proven.

## Outcome

The implementation establishes two related ownership boundaries:

1. Workbench bridge scripts belong to an immutable MCP-managed companion add-on
   outside every target project.
2. Raw captures, profiles, run records, logs, and export work remain in external
   managed storage. Only a reviewed, standardized evidence bundle is exported
   into an allowlisted `screenshots` root.

The resulting layout is:

```text
ReforgerForge MCP package
├── observer/addon/                  runtime observer source
├── observer/workbench-addon/        Workbench helper source
├── src/workbench/helper-addon.ts    verification and immutable staging
├── src/workbench/process-guard.ts   version-3 exact-owner lifecycle
├── src/workbench/runner.ts          shared editor/build runner
└── observer/agent/                  artifacts, jobs, runs, export, retention

External observer managed root
├── addons/                          digest-addressed staged companions
├── profiles/                        runtime and Workbench profiles
├── artifacts/                       validated managed PNGs and metadata
├── runs/                            bounded run records
└── export-work/                     incomplete export transactions

Target project
└── screenshots/<run-id>/            finalized reviewed evidence only
```

The Workbench helper remains a separate add-on from the runtime observer. They
share a managed platform, but independent identities prevent one role's setup or
retention operation from invalidating the other role's active lease.

## Implementation status

| Area | Status | Implementation |
|---|---|---|
| Workbench helper package | Implemented | `observer/workbench-addon` contains `addon.gproj`, a role-specific source manifest, build constants, and all Workbench NET API handlers. |
| Package contract | Implemented | Package verification requires the complete helper payload and its source manifest. |
| Immutable external staging | Implemented | `WorkbenchHelperStager` verifies every source hash, computes the bundle identity, rejects unsafe overlap, and stages under the external observer managed root. |
| Workbench launch | Implemented | The client and standalone runner append the helper search root, helper GUID, and external profile while preserving the exact target `.gproj`. |
| Exact readiness | Implemented | `EMCP_WB_Ping` returns the helper add-on ID, GUID, version, protocol, and compiled build identity; every value must match. |
| Lifecycle ownership | Implemented | Version-3 state binds the canonical target, exact MCP/Workbench process identities, endpoint, operation, and immutable companion identity. |
| Shared project runner | Implemented | `reforger-forge-workbench` supports foreground editor ownership and a bounded PC build intent with a JSON receipt. |
| Project wrapper consolidation | Implemented | Project editor/build wrappers delegate to the shared runner; the project-specific process guard is removed. |
| Managed evidence runs | Implemented | `observer_run` provides `begin`, `status`, `finalize`, and `discard`. |
| Capture association | Implemented | Evidence capture requires a managed `runId` and unique normalized `captureLabel`; callers bind the inventory's expected world identity and epoch. |
| Async and large-image retrieval | Implemented | `observer_job action="read"` returns completed inline PNGs; run finalization exports retained images regardless of the MCP inline limit. |
| Standard evidence export | Implemented | Finalization writes `RESULT.md`, `manifest.json`, capture PNG/JSON pairs, and only approved supporting material. |
| Managed retention | Implemented | Artifact, run, runtime-profile, export-work, log, Workbench-helper digest, and orphaned editor-capture sweeps use bounded age/size policies and respect active references/lifecycles. |
| Real-engine Workbench qualification | Automation passed; review pending | Five-capture v3 automation passed against a disposable stock-Everon-derived world; the finalized bundle remains formally `Unreviewed`. |

## Part 1: Workbench companion

### Canonical source and identity

All Workbench bridge classes are packaged beneath:

```text
observer/workbench-addon/
├── addon.gproj
├── .reforger-forge-workbench-helper-source.json
└── Scripts/WorkbenchGame/EnfusionMCP/
    ├── RFWB_HelperBuild.c
    └── EMCP_WB_*.c
```

`RFWB_HelperBuild.c` exposes the identity compiled into Workbench. The manifest
generator derives that identity from every helper payload file except the
generated identity source itself, then computes the complete bundle digest with
the generated source included. Any handler or project-file edit therefore
changes the Ping identity without a recursive hash dependency.

When any helper source changes:

1. run `npm run observer:manifest` to regenerate the compiled identity and
   Workbench-helper source manifest;
2. run package verification; and
3. update identity contract tests only when the protocol contract changes.

Never copy these sources into a target add-on. Project code under
`Scripts/WorkbenchGame` is owned by that project and must not be used as the MCP
bridge location.

### Staging contract

`WorkbenchHelperStager.ensureStaged(targetProjectPath)` performs the trust
transition before Workbench is spawned:

1. Resolve and verify the packaged source directory.
2. Validate the role, add-on ID, GUID, version, protocol, build identity, file
   set, file hashes, and bundle digest.
3. Resolve the target project and reject any overlap with the managed root,
   staged add-on, search root, or profile.
4. Copy the payload into a digest-addressed temporary directory.
5. Re-read and re-hash the staged payload.
6. Rename it into the immutable managed location.
7. Return only the verified launch descriptor.

The descriptor contains:

```ts
interface WorkbenchCompanionLaunch {
  addonId: string;
  addonGuid: string;
  addonVersion: string;
  protocolVersion: string;
  buildIdentity: string;
  bundleDigest: string;
  addonDirectory: string;
  addonSearchRoot: string;
  workbenchProfilePath: string;
  reused: boolean;
}
```

The search root is passed through `-addonsDir`, the GUID through `-addons`, and
the external profile through `-profile`. The canonical target remains the only
`-gproj` value.

### Exact readiness and reuse

TCP connectivity alone is not readiness. The Workbench `EMCP_WB_Ping` response
must contain all of these exact fields:

```text
helperAddonId
helperAddonGuid
helperAddonVersion
helperProtocolVersion
workbenchProtocol
helperBuildIdentity
```

The TypeScript client compares them with the descriptor for the current MCP
build. A wrong or incomplete identity fails before the editor is treated as
usable. The same proof is repeated before lifecycle reuse and observer
inventory so that a foreign listener cannot impersonate an owned editor.

### Version-3 lifecycle

The lifecycle record binds:

```ts
interface WorkbenchCompanionLifecycleState {
  addonId: string;
  addonGuid: string;
  addonDirectory: string;
  addonSearchRoot: string;
  bundleDigest: string;
  buildIdentity: string;
  profilePath: string;
}
```

It is stored with the canonical project identity, loopback endpoint, exact MCP
owner, exact Workbench process identity, generation, phase, and active
operation. Starting/running/restarting/stopping states require a non-null
companion. A malformed or incomplete lifecycle is never silently adopted.

The Windows backend still provides named-mutex and exact-process primitives,
but all callers use the TypeScript lifecycle API. This keeps MCP tools,
project-owned editor launchers, and build wrappers on one ownership model.

### Standalone runner

The package exposes:

```text
reforger-forge-workbench editor --gproj <path> --foreground
reforger-forge-workbench build --gproj <path> --platform PC --output <path> --timeout-ms <n>
```

Editor mode must remain in the foreground for the lifetime of its owned
Workbench. Detached one-shot ownership is refused. Build mode validates the
target and output, then uses a companion preflight and distinct target-only
Resource Manager build under one maximum deadline and machine lock. It
terminates only proven children when required and emits a version-3 JSON receipt
containing:

- intent and exact target;
- separate preflight/build PIDs and lifecycle generations;
- exact companion ID, GUID, protocol, build identity, and bundle digest;
- preflight endpoint ownership plus post-preflight vacancy proof;
- separate attributed preflight/build log directories;
- exact target add-on ID/GUID/project SHA-256 and fresh nonempty hashed
  `resourceDatabase.rdb` proof from a unique empty output root, or an explicit
  output-attestation failure; and
- exit reason, code, signal, and timeout state.

Project wrappers should only validate project-specific inputs and invoke this
runner. They must not implement a second lock, owner marker, process scan, or
termination policy.

The runner publishes version-3 `starting`, `running`, and `stopping` lifecycle
states while it owns each Workbench child, verifies the exact companion Ping in
preflight, and returns to `vacant` only after exact child absence is proven. This
two-phase lifecycle and receipt hardening is supported and fails closed when the
target child does not produce the required output proof.

Successful guarded data build remains unsupported on installed Workbench
1.7.0.54. Revalidation covered the no-`-run`, explicit `AddonName`, and clean
`-run` Resource Manager forms; none entered `buildData` or produced output.
Consequently, no tested form is documented as reconciling global module
dispatch with the Resource Manager build action. Child launch and zero exit are
not build evidence. A successful guarded build requires a separately verified
engine-native dispatch path before this plan can claim support.

### Workbench observer adapter

The Workbench observer endpoints are supplied by the same companion and
consumed through the same long-lived `WorkbenchClient` as every `wb_*` tool.
Observer operations do not launch Workbench.

The adapter binds a job to:

- lifecycle generation and canonical target;
- exact Workbench process and helper identity;
- native `BaseWorld` camera slot;
- editor world/subscene identity; and
- generated capture path beneath the dedicated external profile.

Workbench writes a native PNG. The host confines the path, requires a regular
stable file, validates PNG structure and dimensions, hashes the exact bytes, and
promotes the artifact into the backend-neutral managed repository. Success,
failure, cancellation, release, restart, and shutdown all remain gated on exact
slot/matrix/FOV restoration.

After each Workbench start, take a successful `current` capture before using
`pose` or `lookAt`. That restoration proof is the capability gate for
`camera.editor` in that exact process.

## Part 2: managed screenshot evidence

### Configure destinations

Evidence and supporting-log roots are explicit allowlists:

```json
{
  "observer": {
    "evidenceRoots": ["C:\\path\\to\\project\\screenshots"],
    "supportingLogRoots": ["C:\\path\\to\\approved\\logs"]
  }
}
```

The ordinary retention defaults remain seven days and 512 MiB. Managed and
profile roots must not overlap the configured project. Evidence roots are the
only worktree destinations the finalizer may use.

### Begin a run

Call `observer_run` before the first capture:

```json
{
  "action": "begin",
  "title": "RR-OBS-MACGUFFIN containment",
  "caseIds": ["RR-OBS-MACGUFFIN"],
  "sourceRevision": "<commit-or-declared-working-tree-id>",
  "procedureRevision": "<procedure-revision>",
  "idempotencyKey": "rr-obs-macguffin-1"
}
```

The host creates a run ID such as `20260717T184233Z-a1b2c3d4` and writes a
crash-safe record under managed storage. The caller never chooses a run
directory.

### Inventory and bind the world

Prepare/start a runtime or explicitly call `wb_launch`, then call
`observer_instances`. Select one renderer and retain its:

```text
instanceId
worldId
worldEpoch
```

Every evidence request must send those values back as `instanceId`,
`expectedWorldId`, and `expectedWorldEpoch`. A runtime world ID is a nonempty
string; a backend without one uses the documented nullable value. The epoch is
always an explicit non-negative integer. A mismatch fails before camera
acquisition and is checked again at completion.

### Capture with human labels

Use `current` for UI/player-camera/editor-viewport claims, `lookAt` for most
reproducible world-space views, and `pose` only when a known quaternion must be
replayed.

```json
{
  "runId": "<managed-run-id>",
  "captureLabel": "rr-obs-macguffin--bounds-recovered",
  "purpose": "Show the recovered in-bounds state",
  "sessionId": "<runtime-session-id>",
  "instanceId": "<selected-instance-id>",
  "expectedWorldId": "<inventory-world-id>",
  "expectedWorldEpoch": 3,
  "view": { "kind": "current" },
  "asynchronous": false,
  "settleFrames": 0,
  "performancePolicy": "evidence",
  "timeoutMs": 30000
}
```

`runId` and `captureLabel` are required. Labels are normalized and unique within
the run; use acceptance-case language instead of job UUIDs. For Workbench,
select its exact inventory `instanceId` and omit `sessionId`.

Prefer synchronous capture while a reviewer is present. It returns one
validated PNG and concise metadata when the image fits the MCP inline limit.
`performancePolicy="evidence"` is the normal mode. `instrumented` is allowed but
marks the result contaminated and carries that warning into the export.

### Async and oversized captures

For asynchronous work:

1. Submit with `asynchronous=true`.
2. Poll `observer_job action="status"`.
3. Call `observer_job action="read"` when complete.
4. If the PNG exceeds the inline limit, do not request or disclose a private
   managed path. Leave it retained and include its label in run finalization.

An open run owns its referenced artifacts. Independent release is refused so a
caller cannot invalidate evidence selected for export. Finalize or discard the
run instead.

### Review before finalizing

A completed capture proves that the observer received a structurally valid,
world-bound image and restored the camera transaction. It does not prove that
the visible gameplay requirement passed. A reviewer must inspect each selected
image and correlate non-visible claims with bounded relevant logs.

`Passed` is valid only with `imagesReviewed=true`. Use `Failed`, `Inconclusive`,
or `Unreviewed` when the image or supporting evidence does not justify a pass.

### Finalize

```json
{
  "action": "finalize",
  "runId": "<managed-run-id>",
  "evidenceRoot": "C:\\path\\to\\project\\screenshots",
  "includeCaptureLabels": [
    "rr-obs-macguffin--bounds-recovered"
  ],
  "review": {
    "imagesReviewed": true,
    "reviewer": "<stable-reviewer-id>",
    "outcome": "Passed",
    "summary": "Reviewed the bound world view and correlated the event log.",
    "limitations": []
  },
  "runtimeConfig": {
    "configurationId": "<declared-id>",
    "values": { "warmupDurationSeconds": 60 }
  },
  "supportingFiles": [
    {
      "kind": "relevantLog",
      "label": "runtime",
      "path": "C:\\path\\to\\approved\\logs\\runtime.log"
    }
  ],
  "releaseManagedArtifacts": true
}
```

Finalization creates exactly:

```text
<evidence-root>/<run-id>/
├── RESULT.md
├── manifest.json
├── captures/
│   ├── <capture-label>.png
│   └── <capture-label>.json
├── relevant-logs/              only when supplied
└── runtime-config.json         only when supplied
```

The finalizer confines the destination to a configured root, rejects path and
link escapes, never overwrites an unrelated directory, pins source artifacts
during export, re-hashes destination files, and writes `manifest.json` last as
the completion marker. A matching retry returns the existing receipt. Managed
artifacts are released only after a verified export when requested.

Runtime configuration accepts only bounded structured scalar values and rejects
secret-like keys. Supporting logs must be regular bounded text files beneath a
configured supporting-log root. Directories, profile trees, binary logs, and
arbitrary config-file copies are not accepted.

Use `observer_run action="discard"` when a run should produce no evidence. It
releases its retained artifacts and removes managed run work without writing to
the evidence root.

## Screenshot usage rules

- Treat a project `screenshots` directory as a reviewed evidence destination,
  never a scratch root.
- Keep repositories, archives, profiles, generated add-on copies, test harness
  output, and probe logs beneath external managed or OS temporary storage.
- Begin a run before capturing and name captures after the claim they show.
- Bind every capture to the exact inventory world and epoch.
- Start with one synchronous current view and inspect it before requesting more
  angles.
- Capture only the additional before/after/detail views needed by the case.
- Do not infer a gameplay pass from capture completion.
- Finalize selected evidence through `observer_run`; do not manually assemble
  run directories.
- Let finalization release artifacts, or discard the run when evidence is not
  retained.

## Validation

### Hermetic gates

Before merging a change to this subsystem, run the relevant default and package
tests. The suite must prove at least:

- exact helper source manifest and package contents;
- immutable staging, target-overlap refusal, and conflicting staged data
  refusal;
- one deduplicated helper search root, one helper GUID, one external profile,
  and one exact target in launch arguments;
- exact Ping identity acceptance and mismatch refusal;
- version-3 lifecycle serialization, companion binding, exact process
  ownership, restart, shutdown, and uncertain-outcome fail-stop behavior;
- standalone editor/build parsing, foreground ownership, deadlines, log
  attribution, and JSON receipts;
- run begin idempotency, unique labels, expected-world mismatch refusal, async
  read, oversized finalization, discard, and retention;
- export confinement, no overwrite, manifest-last completion, idempotent
  receipts, review rules, supporting-file bounds, destination hashes, and
  release-after-commit; and
- packaged tool registration including `observer_run` and `observer_job read`.

### Required real-engine qualification

The code-level cutover is complete. Workbench add-on discovery and compiled
handler registration are qualified with the real-engine harness below. Run it
only when the installed GUI may be opened and no unrelated Arma Reforger or
Workbench process is active:

```powershell
$env:RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE = "1"
npm run observer:acceptance:workbench -- --confirm-live-run
```

The qualification passes only if it proves all of the following:

1. The disposable target tree is hashed before launch.
2. Workbench loads the staged `ReforgerForgeWorkbenchHelper` from its external
   search root and uses the dedicated external profile.
3. `EMCP_WB_Ping` returns the exact current identity.
4. A current capture succeeds and proves restoration.
5. Both the explicit-pose and explicit-look-at captures are materially different
   from their preceding current views, and each following current view returns
   to the original camera.
6. Async captures can be polled, read, and finalized by label. Hermetic tests
   separately cover over-inline-limit finalization without embedding the image.
7. The standardized bundle verifies every exported hash; formal review is a
   separate recorded step.
8. Shutdown terminates only the exact owner and releases the endpoint.
9. The target tree hash/list is unchanged with no MCP helper residue.
10. The engine/tool versions, run ID, reviewer, warnings, and limitations are
    recorded in the evidence.

The five-capture v3 automation completed successfully on July 17, 2026 local
(July 18 UTC) with Workbench engine 1.7.0.54. Harness run `run-wzuGy6`
finalized managed run
`20260718T015947Z-6ec8429d` from disposable world
`{71D11CE993734B08}Worlds/ObserverAcceptance.ent`, inheriting stock Everon
`{853E92315D1D9EFE}worlds/Eden/Eden.ent`. It loaded staged helper digest
`db44e43be9ec4249c23e55c0d1f19a1fb6cf72d6800c4540e938773d729d1eed`,
validated both exact explicit matrices/FOVs and restorations, finalized without
warnings, preserved a clean target, and shut down its exact owner with zero
Workbench processes remaining. All five images were visually inspected during
implementation, but the bundle's immutable metadata remains `Unreviewed` with
`imagesReviewed=false`. Describe the live automation as passed and the formal
evidence review as pending; do not call the companion live-qualified until that
review is recorded.

## Definition of done

- A clean target remains free of MCP Workbench helper files after launch,
  control, capture, restart, and shutdown.
- Workbench handlers load only from the digest-verified external companion.
- Readiness and reuse require exact compiled helper identity.
- MCP tools and project wrappers share one version-3 exact-owner lifecycle.
- A managed run has a host-generated ID, human capture labels, and expected
  world bindings.
- Sync, async, and oversized captures remain usable evidence inputs.
- Finalization exports only reviewed, allowlisted content with a manifest-last
  receipt and verified hashes.
- Raw captures, profiles, logs, run records, and interrupted exports remain
  external and bounded by retention.
- Documentation never equates a completed screenshot transaction with proof
  that the visible gameplay claim passed.
