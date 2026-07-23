import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defineFaultMatrix, type FaultMatrixCase } from "../../observer/protocol/fault-matrix.js";
import {
  buildObserverFailureMatrixArtifact,
  captureStableFailureMatrixSource,
  failureMatrixSourceRevision,
  failureMatrixSourceClosureSha256,
  matrixRetainedDiagnostic,
  operationalBaselineEnvironment,
  operationalBaselineLaunchArgumentIdentity,
  writeObserverFailureMatrixArtifact,
  validateObserverFailureMatrixSummary,
  type FailureMatrixArtifactInput,
} from "../../scripts/observer-live-acceptance-support.js";

function declaredCase(): FaultMatrixCase {
  return {
    schemaVersion: 1,
    id: "runtime.cancel_capture.lease_acquired.current",
    backend: "runtime",
    view: "current",
    injection: { phase: "lease_acquired", action: "cancel_capture" },
    phaseSupport: Object.fromEntries([
      "before_lease", "lease_acquired", "capture_in_progress", "restoration_in_progress", "terminal_release",
    ].map((phase) => [phase, {
      kind: "observable", publicStatusPredicate: `public ${phase}`, fixtureAcknowledgement: `fixture ${phase}`,
    }])) as FaultMatrixCase["phaseSupport"],
    expectedTerminal: { state: "cancelled", errorCode: null },
    cameraDisposition: "restored",
    requiredChecks: ["lifecycle_vacant", "endpoint_vacant", "child_vacant"],
    requiredEvidence: ["public_terminal", "deadline", "camera", "cleanup"],
  };
}

function workbenchCase(): FaultMatrixCase {
  const value: any = structuredClone(declaredCase());
  value.id = "workbench.cancel_capture.lease_acquired.current";
  value.backend = "workbench";
  return value;
}

function secondRuntimeCase(): FaultMatrixCase {
  const value: any = structuredClone(declaredCase());
  value.id = "runtime.cancel_capture.capture_in_progress.current";
  value.injection.phase = "capture_in_progress";
  return value;
}

function ownedWorkbenchCase(): FaultMatrixCase {
  const value: any = structuredClone(workbenchCase());
  value.id = "workbench.stop_owned_workbench.lease_acquired.current";
  value.injection.action = "stop_owned_workbench";
  value.expectedTerminal = { state: "failed", errorCode: "WORKBENCH_EXITED" };
  value.cameraDisposition = "exact_process_exit";
  value.requiredChecks = [...value.requiredChecks, "exact_owner_vacant"];
  return value;
}

function input(result: "passed" | "failed" = "passed"): FailureMatrixArtifactInput {
  const matrix = defineFaultMatrix([declaredCase()]);
  const zero = { active: 0, reconciling: 0, total: 0 };
  const measurement = (boundary: "launch" | "managed_call" | "capture" | "shutdown", operation: string, phase: string, observations?: Record<string, boolean | number>) => ({
    boundary, operation, phase,
    startedAt: "2026-07-19T06:20:00.000Z", finishedAt: "2026-07-19T06:20:00.001Z", durationMs: 1,
    outcome: "passed" as const, processCountBefore: zero, processCountAfter: zero, ...(observations ? { observations } : {}),
  });
  return {
    matrix,
    backend: "runtime",
    result,
    startedAt: "2026-07-19T06:20:00.000Z",
    finishedAt: "2026-07-19T06:20:01.000Z",
    durationMs: 1_000,
    environment: operationalBaselineEnvironment({
      gameExecutable: "ArmaReforgerSteamDiag.exe",
      inspectVersion: () => ({ executable: "ArmaReforgerSteamDiag.exe", version: "1.7.0.54", fileVersion: "1.7.0.54", discovery: "windows_file_metadata" }),
    }),
    workload: {
      procedureRevision: "runtime-observer-acceptance-v2", runtimeKind: "listenServer", overallTimeoutMs: 300_000,
      worldResource: "{96A8AF57260A7392}worlds/MP/MpTest/MpTest.ent", fixture: null,
      capture: { labels: ["initial-current"], settleFrames: 3, performancePolicy: "evidence", asynchronous: false, configurationSha256: "e".repeat(64) },
      launchArguments: operationalBaselineLaunchArgumentIdentity(["-noThrow"]),
    },
    source: {
      harness: { path: "scripts/run-runtime-observer-acceptance.ts", sha256: "a".repeat(64) },
      recorder: { path: "scripts/observer-live-acceptance-support.ts", sha256: "b".repeat(64) },
      measured: [
        { path: "observer/protocol/fault-matrix.ts", sha256: "e".repeat(64) },
        { path: "scripts/observer-fault-matrix-support.ts", sha256: "f".repeat(64) },
        { path: "src/foundation/redact.ts", sha256: "1".repeat(64) },
        { path: "src/foundation/time.ts", sha256: "2".repeat(64) },
        { path: "src/observer/application.ts", sha256: "c".repeat(64) },
        { path: "src/observer/owned-runtime-manager.ts", sha256: "d".repeat(64) },
        { path: "src/observer/public-contract.ts", sha256: "3".repeat(64) },
      ],
    },
    sourceRevision: { commit: "4".repeat(40), tree: "clean" },
    cases: [{
      caseId: "runtime.cancel_capture.lease_acquired.current",
      schedule: { backend: "runtime", view: "current", phase: "lease_acquired", action: "cancel_capture" },
      result: "passed", publicTerminal: { state: "cancelled", errorCode: null },
      deadline: { outcome: "completed", elapsedMs: 10, budgetMs: 1_000 },
      worldRevision: "unchanged", camera: "restored", artifact: "not_created",
      cleanup: { lifecycleVacant: true, endpointVacant: true, childVacant: true, exactOwnerVacant: false },
      control: { arrival: "arrived", action: "executed" },
      artifactEvidence: {
        validation: "not_created", pngSha256: null, metadataSha256: null,
        byteCount: null, manifestPublished: false,
      },
      ownerShutdown: "not_applicable",
      decoy: { category: "not_applicable", identityUnchanged: null },
      limitations: ["Cancellation intentionally produced no promoted artifact."],
      retainedDiagnostics: [matrixRetainedDiagnostic("captured diagnostic")],
    }],
    measurements: [
      measurement("launch", "OwnedRuntimeManager.start/status(running)", "running_confirmation"),
      measurement("managed_call", "OwnedRuntimeManager.status", "representative_status_api"),
      measurement("capture", "ObserverApplication.capture(initial-current)", "initial-current"),
      measurement("shutdown", "OwnedRuntimeManager.stop", "termination", { terminationComplete: true, identityVacant: true }),
      measurement("shutdown", "OwnedRuntimeManager.stop", "observer_cleanup", { observerCleanupPending: false }),
      measurement("shutdown", "ObserverApplication.close", "observer_cleanup"),
      measurement("shutdown", "waitForOperationalBaselineProcessVacancy", "supervised_exit_settle", { vacant: true, finalTotal: 0 }),
    ],
    processCounts: [
      { label: "rest.beforeLaunch", at: "2026-07-19T06:20:00.000Z", ...zero },
      { label: "rest.afterShutdown", at: "2026-07-19T06:20:01.000Z", ...zero },
    ],
    limitations: ["No graphical process is used by this hermetic test."],
    failure: result === "failed" ? { name: "FixtureFailure" } : null,
  };
}

function ownedWorkbenchInput(): FailureMatrixArtifactInput {
  const value = input("failed");
  const declared = ownedWorkbenchCase();
  return {
    ...value,
    backend: "workbench",
    matrix: defineFaultMatrix([declared]),
    workload: {
      ...value.workload,
      runtimeKind: "workbench",
      fixture: {
        kind: "disposable_workbench_world",
        id: "matrix-fixture",
        guid: null,
        sourceFileCount: 1,
        sourceSha256: "6".repeat(64),
      },
    },
    cases: [{
      ...value.cases[0]!,
      caseId: declared.id,
      schedule: {
        backend: declared.backend,
        view: declared.view,
        phase: declared.injection.phase,
        action: declared.injection.action,
      },
      publicTerminal: declared.expectedTerminal,
      camera: declared.cameraDisposition,
      cleanup: {
        lifecycleVacant: true,
        endpointVacant: true,
        childVacant: true,
        exactOwnerVacant: true,
      },
      ownerShutdown: "exact_owner_vacant",
      decoy: { category: "verified", identityUnchanged: true },
    }],
  };
}

describe("observer failure-matrix evidence", () => {
  it("captures clean, dirty, and unavailable Git source revisions", () => {
    const repositoryRoot = join(tmpdir(), "rfo-matrix-repository");
    let statusOutput = "";
    const runGit = vi.fn((argumentsArray: readonly string[], _cwd: string) => ({
      status: 0,
      stdout: argumentsArray.includes("rev-parse") ? `${"A".repeat(40)}\n` : statusOutput,
    }));

    expect(failureMatrixSourceRevision(repositoryRoot, runGit)).toEqual({
      commit: "a".repeat(40),
      tree: "clean",
    });
    statusOutput = " M scripts/harness.ts\n";
    expect(failureMatrixSourceRevision(repositoryRoot, runGit)).toEqual({
      commit: "a".repeat(40),
      tree: "dirty",
    });
    const resolvedRoot = resolve(repositoryRoot);
    const safeDirectory = `safe.directory=${resolvedRoot.replace(/\\/g, "/")}`;
    expect(runGit.mock.calls.every(([argumentsArray, cwd]) =>
      argumentsArray.includes(safeDirectory) && cwd === resolvedRoot)).toBe(true);
    expect(failureMatrixSourceRevision(repositoryRoot, () => ({
      status: 1,
      stdout: "",
    }))).toEqual({ commit: null, tree: "unavailable" });
  });

  it("detects revision drift inside a stable source-identity bracket", () => {
    const source = input().source;
    for (const changedRevision of [
      { commit: "b".repeat(40), tree: "clean" as const },
      { commit: "a".repeat(40), tree: "dirty" as const },
    ]) {
      const readRevision = vi.fn()
        .mockReturnValueOnce({ commit: "a".repeat(40), tree: "clean" as const })
        .mockReturnValueOnce(changedRevision);
      const captured = captureStableFailureMatrixSource({
        readSource: () => source,
        readRevision,
      });
      expect(captured.stable).toBe(false);
      expect(captured.sourceRevision).toEqual(changedRevision);
    }
  });

  it("accepts the bounded aggregate timeout required by 69 serial Workbench cases", () => {
    const candidate = input();
    const artifact = buildObserverFailureMatrixArtifact({
      ...candidate,
      workload: { ...candidate.workload, overallTimeoutMs: 41_400_000 },
    });
    expect(artifact.workload.overallTimeoutMs).toBe(41_400_000);
    expect(() => buildObserverFailureMatrixArtifact({
      ...candidate,
      workload: { ...candidate.workload, overallTimeoutMs: 41_400_001 },
    })).toThrow(/workload identity/i);
  });

  it("builds and publishes a fully closed passing manifest after its summary", () => {
    const value = input();
    const artifact = buildObserverFailureMatrixArtifact(value);
    const root = mkdtempSync(join(tmpdir(), "rfo-matrix-evidence-"));
    try {
      const publication = writeObserverFailureMatrixArtifact(root, artifact, value.matrix);
      const manifest = JSON.parse(readFileSync(publication.jsonPath, "utf8"));
      const markdown = readFileSync(publication.markdownPath, "utf8");
      expect(markdown).toContain("Result: passed");
      expect(markdown).toContain("Product version: 1.7.0.54");
      expect(markdown).toContain("Workbench version: unavailable");
      expect(markdown).toContain("Procedure revision: runtime-observer-acceptance-v2");
      expect(markdown).toContain(`Source revision: ${"4".repeat(40)}`);
      expect(markdown).toContain("Source tree: clean");
      expect(markdown).toContain("Coverage: full (1 of 1 declared cases)");
      expect(markdown).toContain("Images manually reviewed: no");
      expect(markdown).toContain("| Case | Declared fault (phase/action) | Public result | Camera / exit | Artifact | Vacancy | Limitations |");
      expect(markdown).toContain("lease_acquired / cancel_capture");
      expect(statSync(publication.markdownPath).mtimeMs).toBeLessThanOrEqual(statSync(publication.jsonPath).mtimeMs);
      expect(manifest.schemaVersion).toBe(3);
      expect(manifest.result).toBe("passed");
      expect(manifest.review).toEqual({ imagesReviewed: false, outcome: "unreviewed" });
      expect(manifest.coverage).toEqual({
        kind: "full", selectedCaseIds: ["runtime.cancel_capture.lease_acquired.current"],
      });
      expect(manifest.sourceRevision).toEqual({ commit: "4".repeat(40), tree: "clean" });
      expect(manifest.cases[0]).toMatchObject({
        control: { arrival: "arrived", action: "executed" },
        artifactEvidence: { validation: "not_created", manifestPublished: false },
        ownerShutdown: "not_applicable",
        decoy: { category: "not_applicable", identityUnchanged: null },
        limitations: ["Cancellation intentionally produced no promoted artifact."],
      });
      expect(manifest.summary.basename).toBe(publication.markdownPath.split(/[\\/]/).pop());
      expect(manifest.summary.sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports canonical full and explicit partial coverage without weakening catalog identity", () => {
    const value = input();
    const matrix = defineFaultMatrix([declaredCase(), secondRuntimeCase()]);
    const entries = matrix.cases.map((declared) => ({
      ...value.cases[0]!,
      caseId: declared.id,
      schedule: {
        backend: declared.backend,
        view: declared.view,
        phase: declared.injection.phase,
        action: declared.injection.action,
      },
      publicTerminal: declared.expectedTerminal,
      camera: declared.cameraDisposition,
    }));
    const full = buildObserverFailureMatrixArtifact({ ...value, matrix, cases: entries });
    expect(full.coverage).toEqual({ kind: "full", selectedCaseIds: matrix.caseIds });
    expect(full.matrix.declaredCaseIds).toEqual(matrix.caseIds);

    const partial = buildObserverFailureMatrixArtifact({
      ...value,
      matrix,
      sourceRevision: { commit: null, tree: "unavailable" },
      coverage: {
        kind: "partial",
        selectedCaseIds: ["runtime.cancel_capture.lease_acquired.current"],
      },
      cases: [value.cases[0]!],
    });
    expect(partial.coverage.kind).toBe("partial");
    expect(partial.cases.map((entry) => entry.caseId)).toEqual(partial.coverage.selectedCaseIds);
    expect(partial.matrix.declaredCaseIds).toEqual(matrix.caseIds);

    const root = mkdtempSync(join(tmpdir(), "rfo-matrix-partial-"));
    try {
      const publication = writeObserverFailureMatrixArtifact(root, partial, matrix);
      expect(readFileSync(publication.markdownPath, "utf8")).toContain("Coverage: partial (1 of 2 declared cases)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    expect(() => buildObserverFailureMatrixArtifact({
      ...value,
      matrix,
      coverage: { kind: "full", selectedCaseIds: [value.cases[0]!.caseId] },
      cases: [value.cases[0]!],
    })).toThrow(/Full failure-matrix coverage/);
    expect(() => buildObserverFailureMatrixArtifact({
      ...value,
      matrix,
      coverage: { kind: "partial", selectedCaseIds: [...matrix.caseIds].reverse() },
      cases: [...entries].reverse(),
    })).toThrow(/canonical backend order/);
  });

  it("requires an exact clean source revision for full passing coverage", () => {
    const value = input();
    expect(() => buildObserverFailureMatrixArtifact({
      ...value,
      sourceRevision: { commit: "4".repeat(40), tree: "dirty" },
    })).toThrow(/clean 40-hex source revision/);
    expect(() => buildObserverFailureMatrixArtifact({
      ...value,
      sourceRevision: { commit: null, tree: "unavailable" },
    })).toThrow(/clean 40-hex source revision/);
    expect(() => buildObserverFailureMatrixArtifact({
      ...value,
      sourceRevision: { commit: "not-a-commit", tree: "clean" },
    })).toThrow(/source revision is invalid/);
    expect(() => buildObserverFailureMatrixArtifact({
      ...input("failed"),
      sourceRevision: { commit: "5".repeat(40), tree: "dirty" },
      cases: [{ ...input("failed").cases[0]!, result: "failed", camera: "unproven" }],
    })).not.toThrow();
  });

  it("materializes conservative v3 closeout defaults for legacy failed-row input", () => {
    const value = input("failed");
    const {
      control: _control,
      artifactEvidence: _artifactEvidence,
      ownerShutdown: _ownerShutdown,
      decoy: _decoy,
      limitations: _limitations,
      ...legacyEntry
    } = value.cases[0]!;
    const artifact = buildObserverFailureMatrixArtifact({
      ...value,
      sourceRevision: undefined,
      cases: [{ ...legacyEntry, result: "failed", camera: "unproven" }],
    });
    expect(artifact.sourceRevision).toEqual({ commit: null, tree: "unavailable" });
    expect(artifact.cases[0]).toMatchObject({
      control: { arrival: "unproven", action: "unproven" },
      artifactEvidence: {
        validation: "not_created", pngSha256: null, metadataSha256: null,
        byteCount: null, manifestPublished: false,
      },
      ownerShutdown: "not_applicable",
      decoy: { category: "not_applicable", identityUnchanged: null },
      limitations: [],
    });
  });

  it("keeps runtime and Workbench entry sets independent and publishes valid failed evidence", () => {
    const value = input();
    const matrix = defineFaultMatrix([declaredCase(), workbenchCase()]);
    const artifact = buildObserverFailureMatrixArtifact({ ...value, matrix });
    expect(artifact.matrix.declaredCaseIds).toEqual(["runtime.cancel_capture.lease_acquired.current"]);
    const failed = buildObserverFailureMatrixArtifact({ ...input("failed"),
      cases: [{ ...input("failed").cases[0]!, result: "failed", camera: "unproven" }],
    });
    const root = mkdtempSync(join(tmpdir(), "rfo-matrix-failed-"));
    try {
      const publication = writeObserverFailureMatrixArtifact(root, failed, input("failed").matrix);
      expect(JSON.parse(readFileSync(publication.jsonPath, "utf8")).result).toBe("failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires canonical public terminal vocabulary even for failed rows", () => {
    const failed = input("failed");
    expect(() => buildObserverFailureMatrixArtifact({
      ...failed,
      cases: [{ ...failed.cases[0]!, result: "failed", publicTerminal: { state: "native_exception", errorCode: "raw_error" } }],
    })).toThrow(/public terminal is invalid/);
    expect(() => buildObserverFailureMatrixArtifact({
      ...failed,
      cases: [{ ...failed.cases[0]!, result: "failed", publicTerminal: { state: "completed", errorCode: "INTERNAL_ERROR" } }],
    })).toThrow(/public terminal is invalid/);
    expect(() => buildObserverFailureMatrixArtifact({
      ...failed,
      cases: [{ ...failed.cases[0]!, result: "failed", publicTerminal: { state: "cancelled", errorCode: "CANCELLED" } }],
    })).toThrow(/public terminal is invalid/);
    expect(() => buildObserverFailureMatrixArtifact({
      ...failed,
      cases: [{ ...failed.cases[0]!, result: "failed", publicTerminal: { state: "failed", errorCode: null } }],
    })).toThrow(/public terminal is invalid/);
  });

  it("requires a non-empty retained-diagnostic collection when declared", () => {
    const value = input();
    const declared = declaredCase() as any;
    declared.requiredEvidence = [...declared.requiredEvidence, "retained_diagnostics"];
    const matrix = defineFaultMatrix([declared]);
    expect(() => buildObserverFailureMatrixArtifact({
      ...value,
      matrix,
      cases: [{ ...value.cases[0]!, retainedDiagnostics: [] }],
    })).toThrow(/required retained_diagnostics evidence/);
  });

  it("binds matrix identity to the shared control support source", () => {
    const value = input();
    const originalDigest = failureMatrixSourceClosureSha256(value.source);
    const changedSupport = value.source.measured.map((member) => member.path === "scripts/observer-fault-matrix-support.ts"
      ? { ...member, sha256: "0".repeat(64) }
      : member);
    expect(failureMatrixSourceClosureSha256({ ...value.source, measured: changedSupport })).not.toBe(originalDigest);
    expect(() => buildObserverFailureMatrixArtifact({
      ...value,
      source: {
        ...value.source,
        measured: value.source.measured.filter((member) => member.path !== "scripts/observer-fault-matrix-support.ts"),
      },
    })).toThrow(/observer-fault-matrix-support\.ts/);
  });

  it("rejects missing, duplicate, contradictory, and absent required proof rows", () => {
    const value = input();
    const coverage = { kind: "full" as const, selectedCaseIds: [value.cases[0]!.caseId] };
    expect(() => buildObserverFailureMatrixArtifact({ ...value, coverage, cases: [] })).toThrow(/entries must exactly match coverage/);
    expect(() => buildObserverFailureMatrixArtifact({
      ...value, coverage, cases: [value.cases[0]!, value.cases[0]!],
    })).toThrow(/entries must exactly match coverage/);
    expect(() => buildObserverFailureMatrixArtifact({
      ...value,
      cases: [{ ...value.cases[0]!, publicTerminal: { state: "completed", errorCode: null } }],
    })).toThrow(/contradicts/);
    expect(() => buildObserverFailureMatrixArtifact({
      ...value,
      cases: [{ ...value.cases[0]!, cleanup: { ...value.cases[0]!.cleanup, childVacant: false } }],
    })).toThrow(/required child_vacant proof/);
  });

  it("rejects contradictory control, artifact, manifest, and exact-exit evidence", () => {
    const value = input();
    expect(() => buildObserverFailureMatrixArtifact({
      ...value,
      cases: [{ ...value.cases[0]!, control: { arrival: "not_arrived", action: "not_executed" } }],
    })).toThrow(/requires arrived and executed control evidence/);
    expect(() => buildObserverFailureMatrixArtifact({
      ...value,
      cases: [{
        ...value.cases[0]!,
        artifactEvidence: { ...value.cases[0]!.artifactEvidence!, validation: "rejected" },
      }],
    })).toThrow(/artifact disposition contradicts/);
    expect(() => buildObserverFailureMatrixArtifact({
      ...value,
      cases: [{
        ...value.cases[0]!,
        artifact: "validated",
        artifactEvidence: {
          validation: "validated", pngSha256: null, metadataSha256: null,
          byteCount: null, manifestPublished: false,
        },
      }],
    })).toThrow(/requires both hashes, positive bytes, and a published manifest/);
    expect(() => buildObserverFailureMatrixArtifact({
      ...value,
      cases: [{
        ...value.cases[0]!,
        artifact: "rejected",
        artifactEvidence: {
          validation: "rejected", pngSha256: "7".repeat(64), metadataSha256: null,
          byteCount: 8, manifestPublished: true,
        },
      }],
    })).toThrow(/cannot publish a manifest/);

    const failed = input("failed");
    expect(() => buildObserverFailureMatrixArtifact({
      ...failed,
      cases: [{
        ...failed.cases[0]!, result: "failed", camera: "exact_process_exit",
        ownerShutdown: "not_applicable",
      }],
    })).toThrow(/requires exact-owner vacancy and shutdown proof/);

    expect(() => buildObserverFailureMatrixArtifact({
      ...value,
      cases: [{
        ...value.cases[0]!,
        artifact: "validated",
        artifactEvidence: {
          validation: "validated", pngSha256: "8".repeat(64), metadataSha256: "9".repeat(64),
          byteCount: 512, manifestPublished: true,
        },
      }],
    })).not.toThrow();
  });

  it("binds owned shutdown to exact-owner vacancy and an unchanged verified decoy", () => {
    const value = ownedWorkbenchInput();
    expect(() => buildObserverFailureMatrixArtifact(value)).not.toThrow();
    expect(() => buildObserverFailureMatrixArtifact({
      ...value,
      cases: [{
        ...value.cases[0]!,
        decoy: { category: "verified", identityUnchanged: false },
      }],
    })).toThrow(/unchanged verified decoy/);
    expect(() => buildObserverFailureMatrixArtifact({
      ...value,
      cases: [{ ...value.cases[0]!, ownerShutdown: "unproven" }],
    })).toThrow(/Exact-process-exit camera evidence/);

    const nonOwned = input("failed");
    expect(() => buildObserverFailureMatrixArtifact({
      ...nonOwned,
      cases: [{
        ...nonOwned.cases[0]!, result: "failed", camera: "unproven",
        decoy: { category: "verified", identityUnchanged: true },
      }],
    })).toThrow(/non-owned-shutdown.*verified decoy/);
  });

  it("redacts the complete portable-evidence adversarial corpus from both outputs", () => {
    const capability = "123e4567-e89b-42d3-a456-426614174000";
    const raw = [
      "C:\\Users\\shelby\\private", "\\\\server\\share\\private", "/var/private/shelby", "PID=4242",
      "Workbench PID 5252 remains", "Workbench PID(s) 5353, 5454 remain", "process ID 5555 is still live",
      "-reforgerForgeOwnerToken=owner-token", `capability=${capability}`, "Authorization: Bearer bearer-secret",
      "hostname=private-host", "user=shelby", "lifecycleId=raw-lifecycle-id", "handlerLease=raw-handler-lease",
      "Matrix pilot job job-private-123 did not reach terminal", "run run-secret-456", "session session-secret-789",
    ].join("; ");
    const value = input();
    const artifact = buildObserverFailureMatrixArtifact({
      ...value,
      knownSecretValues: [capability, "owner-token", "bearer-secret"],
      cases: [{
        ...value.cases[0]!,
        limitations: [raw],
        retainedDiagnostics: [matrixRetainedDiagnostic(raw, [capability, "owner-token", "bearer-secret"])],
      }],
    });
    const root = mkdtempSync(join(tmpdir(), "rfo-matrix-redaction-"));
    try {
      const publication = writeObserverFailureMatrixArtifact(root, artifact, value.matrix, [capability, "owner-token", "bearer-secret"]);
      const output = `${readFileSync(publication.markdownPath, "utf8")}\n${readFileSync(publication.jsonPath, "utf8")}`;
      for (const sentinel of ["shelby", "server\\share", "/var/private", "4242", "5252", "5353", "5454", "5555", "owner-token", capability, "bearer-secret", "private-host", "raw-lifecycle-id", "raw-handler-lease", "job-private-123", "run-secret-456", "session-secret-789"]) {
        expect(output).not.toContain(sentinel);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("byte-bounds multibyte diagnostics and rejects unsafe text outside diagnostic fields", () => {
    const diagnostic = matrixRetainedDiagnostic("😀".repeat(4_096));
    expect(diagnostic.byteCount).toBeLessThanOrEqual(4_096);
    const value = input();
    expect(() => buildObserverFailureMatrixArtifact({
      ...value,
      cases: [{ ...value.cases[0]!, retainedDiagnostics: [diagnostic] }],
    })).not.toThrow();
    expect(() => buildObserverFailureMatrixArtifact({
      ...value,
      environment: {
        ...value.environment,
        machineClass: {
          ...value.environment.machineClass,
          cpuModel: "read C:\\Users\\private-user\\secret",
        },
      },
    })).toThrow(/unsafe or unbounded text/);
  });

  it("detects a summary-hash mismatch and leaves no final publication for unsafe input", () => {
    const value = input();
    const artifact = buildObserverFailureMatrixArtifact(value);
    const root = mkdtempSync(join(tmpdir(), "rfo-matrix-closeout-"));
    try {
      const publication = writeObserverFailureMatrixArtifact(root, artifact, value.matrix);
      const manifest = JSON.parse(readFileSync(publication.jsonPath, "utf8"));
      expect(() => validateObserverFailureMatrixSummary(manifest.summary, "tampered")).toThrow(/summary hash/);
      const unsafe: any = {
        ...artifact,
        cases: [{ ...artifact.cases[0], retainedDiagnostics: [{ sha256: "a".repeat(64), byteCount: 12, tail: "pid=123456" }] }],
      };
      const unsafeRoot = mkdtempSync(join(tmpdir(), "rfo-matrix-unsafe-"));
      try {
        expect(() => writeObserverFailureMatrixArtifact(unsafeRoot, unsafe, value.matrix)).toThrow();
        expect(readdirSync(unsafeRoot)).toEqual([]);
      } finally {
        rmSync(unsafeRoot, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rolls back both final siblings when closeout fails after the JSON rename", () => {
    const value = input();
    const artifact = buildObserverFailureMatrixArtifact(value);
    const root = mkdtempSync(join(tmpdir(), "rfo-matrix-post-json-failure-"));
    const freeze = vi.spyOn(Object, "freeze").mockImplementationOnce(() => {
      throw new Error("injected post-publication closeout failure");
    });
    try {
      expect(() => writeObserverFailureMatrixArtifact(root, artifact, value.matrix))
        .toThrow(/injected post-publication closeout failure/);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      freeze.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
