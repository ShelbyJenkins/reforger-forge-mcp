# Fork development summary — 2026-07-26

**Status:** Implemented and integrated into `main`  
**Implementation range:** upstream fork point `5e52376` through `75add57`  
**Scale:** 29 fork-specific commits across the observer, Workbench lifecycle,
shared foundations, tests, packaging, and documentation

## Purpose

This document is a high-level record of the work completed in this fork. It is
intended to show what changed and why without duplicating the detailed design
plans, implementation notes, or individual commit history.

## What this enables

At a product level, the fork adds safe, agent-driven control of Arma Reforger
Tools and a complete local screenshot-evidence workflow for both the game and
Workbench.

| Feature | What it supports |
|---|---|
| Safe Workbench control | Agents can launch, reuse, diagnose, restart, and shut down the exact intended Workbench project without taking ownership of an unrelated editor process. |
| Managed game runtime | A graphical Arma Reforger process can be prepared, explicitly started, inspected, and restoration-gated stopped through an exact-owned lifecycle. |
| Runtime screenshots | The game can capture the current camera, an explicit camera pose, or a look-at target as a validated PNG. |
| Workbench screenshots | An already-running managed Workbench can capture the editor's current view, explicit poses, and look-at views through dedicated observer handlers. |
| Camera safety | Pose-based captures hold a lease and must prove the original camera was restored before completion, shutdown, or restart can proceed. |
| Asynchronous capture jobs | Longer captures can be submitted, polled, read, cancelled, and released without blocking one MCP request indefinitely. |
| Renderer discovery | Tools can inventory compatible runtime and Workbench renderers, their health, capabilities, lifecycle identity, and world revision before capture. |
| Evidence runs | Reviewed captures can be grouped into a managed run and finalized as a portable bundle containing PNGs, metadata, a manifest, source provenance, and a readable result summary. |
| Reproducible target builds | A reviewed `.gproj` can be built into a unique external directory with exact process attribution, fresh-output checks, and a structured receipt. |
| Recovery and diagnostics | Durable lifecycle state and bounded diagnostics support safe recovery after helper failure, process exit, MCP restart, endpoint conflict, or incomplete cleanup. |
| Local failure testing | Maintainers can inject controlled cancellation, transport, world, artifact, lease, and owner-shutdown faults into disposable fixtures and retain sanitized results. |
| Safer automation defaults | Operations are deadline-bounded, target-confined, identity-checked, redacted for publication, and designed to fail closed when ownership or restoration cannot be proven. |

The primary new observer-facing tools are:

- `observer_setup` for companion staging and health checks;
- `observer_prepare_launch` and `observer_runtime` for explicit graphical
  runtime lifecycle;
- `observer_instances` for renderer inventory;
- `observer_capture` and `observer_job` for synchronous or asynchronous
  screenshots; and
- `observer_run` for reviewed evidence collection and export.

Existing Workbench operations such as `wb_launch`, `wb_restart`, `wb_shutdown`,
and diagnostics were substantially hardened around the new exact-owner
lifecycle.

## At a glance

| Area | Outcome |
|---|---|
| Workbench lifecycle | Replaced best-effort process control with a target-aware, exact-owner Windows lifecycle coordinator. |
| Observer platform | Added managed runtime and Workbench screenshot capture with bounded jobs, camera restoration, and reviewable evidence bundles. |
| Reliability foundations | Added durable storage, exact process identity, redaction, deadlines, reservation gates, and recoverable child-process primitives. |
| Build and packaging | Added guarded target builds, package-contract validation, generated protocol checks, and source-manifest enforcement. |
| Acceptance coverage | Added hermetic contracts, live runtime/Workbench acceptance, a runtime cancellation pilot, and a serial 69-case Workbench fault harness. |
| Operator guidance | Reworked setup, configuration, lifecycle, observer, validation, and agent-facing documentation. |

## Work delivered

### 1. Workbench lifecycle and build safety

- Centralized launch, reuse, restart, shutdown, and recovery behind one
  target-aware session controller.
- Bound lifecycle authority to the exact executable, PID creation identity,
  owner token, canonical `.gproj`, endpoint owner, and lifecycle generation.
- Added cross-process serialization, reader/writer activity gating, bounded
  helper operations, fail-closed recovery, and exact-owner vacancy checks.
- Made helper staging content-addressed and manifest-verified so cleanup removes
  only unchanged managed files.
- Added a guarded Workbench runner and target-build path with unique external
  output directories, attributed logs, fresh-output proof, and structured
  receipts.
- Added a two-pass live build acceptance harness to prove repeatable target
  builds without writing build output into the source project.

### 2. Runtime and Workbench observer platform

- Added packaged runtime and Workbench observer companions plus a private local
  agent for staging, sessions, jobs, artifacts, retention, and transport.
- Added explicit tools for setup, launch preparation, exact-owned runtime
  lifecycle, renderer inventory, capture jobs, and managed evidence runs.
- Implemented current-view, explicit-pose, and look-at capture as validated
  native PNG transactions.
- Added camera leases, cancellation, idempotent terminal operations, and strict
  restoration gating so a capture is not complete until camera state is proven
  restored.
- Added REST delivery with a bounded mailbox fallback, durable job state, and
  restart-aware ownership and recovery rules.
- Added reviewed evidence bundles with source revision, capture metadata,
  image-integrity checks, redacted diagnostics, and explicit finalization or
  discard.

### 3. Shared reliability and storage foundations

- Added exact Windows process inspection and termination backends that avoid
  PID-only or process-name ownership assumptions.
- Added durable JSON and LMDB-backed record, CAS, and key/value stores with
  recovery and concurrency contracts.
- Added shared primitives for deadlines and polling, reservations, managed
  paths, digests, public JSON, secret redaction, child supervision, and
  recoverable spawning.
- Consolidated overlapping lifecycle, observer, and test helpers around these
  shared contracts and removed unsupported or redundant paths.
- Tightened public error projection and diagnostics so internal identities and
  control values do not leak into published evidence.

### 4. Fault handling and validation

- Added broad hermetic coverage for protocol generation, package contents,
  storage, process ownership, lifecycle recovery, mailbox behavior, camera
  restoration, evidence publication, and public contracts.
- Added opt-in live acceptance for the Workbench lifecycle, Workbench capture,
  graphical runtime capture, mailbox enforcement, and two-pass target builds.
- Added a provenance-bound runtime cancellation matrix pilot.
- Added a serial, resettable 69-case Workbench fault harness covering
  completion, cancellation, handler loss, lease contention, world replacement,
  artifact corruption, owned shutdown, and idempotent terminal release.
- Hardened matrix publication with exact source revision and clean-tree
  provenance, bounded terminal polling, safe diagnostics, exact evidence
  labels, world-identity checks, and lifecycle-vacancy proof.

The final validation sequence passed the hermetic/package gates, enforcement
checks, long-dwell lifecycle test, two-pass target build, Workbench capture,
runtime capture, and runtime cancellation case on commit `75add57`.

An earlier full Workbench matrix exercised all 69 cases: 67 passed and two
world-replacement pose cases exposed a capture-eligibility coupling. That
coupling was removed by using the lifecycle-bound raw Workbench identity probe,
and both affected cases then passed individually. A new consolidated 69/69
artifact for `75add57` was intentionally not run; the functional cases were
covered, but formal full-matrix provenance remains a separate optional
certification step.

### 5. Packaging, CI, and documentation

- Added protocol and observer source-manifest generation and drift checks.
- Expanded package validation so required runtime, Workbench, protocol, and
  generated assets are verified before publication.
- Updated CI, TypeScript build boundaries, unused-code checking, and repository
  test organization.
- Added release notes and substantially expanded the main README, observer
  guide, workspace agent guide, configuration examples, and maintainer
  acceptance plans.
- Removed repository-local editor/MCP configuration files that should remain
  user-specific and documented safe local configuration instead.

### 6. 2026-07-26 Workbench refinements

- Made base-game and standard Workshop add-on roots additive defaults, and added `check-addon-dirs` to report resolved, missing, and ambiguous dependency GUIDs.
- Simplified target builds to one helper-free path with fresh-output reservation, removing the companion preflight/handoff and obsolete build-acceptance gate.
- Folded fork-only build/editor receipt-version cleanup into the helper-free path, while retaining the independently versioned durable lifecycle-state schema.
- Published a standalone runner CLI reference covering invocation, exit-0 receipt guarantees, and the sole caller-side target-identity check.
- Added bounded, redacted `wb_log_query` filtering for attributed Workbench logs by add-on, severity, channel, and text.

## Result

The fork evolved ReforgerForge from a primarily command-oriented Workbench MCP
into a lifecycle-managed Windows automation and observer platform with
fail-closed ownership, durable state, restoration-safe capture, reproducible
build evidence, and extensive hermetic and live acceptance coverage.

The implementation summarized here was integrated into `main` through
implementation commit `75add57`.
