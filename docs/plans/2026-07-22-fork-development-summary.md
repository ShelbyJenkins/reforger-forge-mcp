# Fork development summary — 2026-07-22

**Status:** Implemented and integrated into `main`  
**Implementation range:** upstream fork point `5e52376` through `75add57`  
**Scale:** 29 fork-specific commits across the observer, Workbench lifecycle,
shared foundations, tests, packaging, and documentation

## Purpose

This document is a high-level record of the work completed in this fork. It is
intended to show what changed and why without duplicating the detailed design
plans, implementation notes, or individual commit history.

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

## Result

The fork evolved ReforgerForge from a primarily command-oriented Workbench MCP
into a lifecycle-managed Windows automation and observer platform with
fail-closed ownership, durable state, restoration-safe capture, reproducible
build evidence, and extensive hermetic and live acceptance coverage.

The implementation summarized here was integrated into `main` through
implementation commit `75add57`.
