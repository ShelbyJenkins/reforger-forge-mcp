import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineFaultMatrix, type FaultMatrixCase } from "../../observer/protocol/fault-matrix.js";
import {
  buildObserverFailureMatrixArtifact,
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
    cases: [{
      caseId: "runtime.cancel_capture.lease_acquired.current",
      schedule: { backend: "runtime", view: "current", phase: "lease_acquired", action: "cancel_capture" },
      result: "passed", publicTerminal: { state: "cancelled", errorCode: null },
      deadline: { outcome: "completed", elapsedMs: 10, budgetMs: 1_000 },
      worldRevision: "unchanged", camera: "restored", artifact: "not_created",
      cleanup: { lifecycleVacant: true, endpointVacant: true, childVacant: true, exactOwnerVacant: false },
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

describe("observer failure-matrix evidence", () => {
  it("builds and publishes a fully closed passing manifest after its summary", () => {
    const value = input();
    const artifact = buildObserverFailureMatrixArtifact(value);
    const root = mkdtempSync(join(tmpdir(), "rfo-matrix-evidence-"));
    try {
      const publication = writeObserverFailureMatrixArtifact(root, artifact, value.matrix);
      const manifest = JSON.parse(readFileSync(publication.jsonPath, "utf8"));
      expect(readFileSync(publication.markdownPath, "utf8")).toContain("Result: passed");
      expect(readFileSync(publication.markdownPath, "utf8")).toContain("Product version: 1.7.0.54");
      expect(manifest.result).toBe("passed");
      expect(manifest.summary.basename).toBe(publication.markdownPath.split(/[\\/]/).pop());
      expect(manifest.summary.sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    expect(() => buildObserverFailureMatrixArtifact({ ...value, cases: [] })).toThrow(/entries must occur once/);
    expect(() => buildObserverFailureMatrixArtifact({ ...value, cases: [value.cases[0]!, value.cases[0]!] })).toThrow(/entries must occur once/);
    expect(() => buildObserverFailureMatrixArtifact({
      ...value,
      cases: [{ ...value.cases[0]!, publicTerminal: { state: "completed", errorCode: null } }],
    })).toThrow(/contradicts/);
    expect(() => buildObserverFailureMatrixArtifact({
      ...value,
      cases: [{ ...value.cases[0]!, cleanup: { ...value.cases[0]!.cleanup, childVacant: false } }],
    })).toThrow(/required child_vacant proof/);
  });

  it("redacts the complete portable-evidence adversarial corpus from both outputs", () => {
    const capability = "123e4567-e89b-42d3-a456-426614174000";
    const raw = [
      "C:\\Users\\shelby\\private", "\\\\server\\share\\private", "/var/private/shelby", "PID=4242",
      "-reforgerForgeOwnerToken=owner-token", `capability=${capability}`, "Authorization: Bearer bearer-secret",
      "hostname=private-host", "user=shelby", "lifecycleId=raw-lifecycle-id", "handlerLease=raw-handler-lease",
    ].join("; ");
    const value = input();
    const artifact = buildObserverFailureMatrixArtifact({
      ...value,
      knownSecretValues: [capability, "owner-token", "bearer-secret"],
      cases: [{ ...value.cases[0]!, retainedDiagnostics: [matrixRetainedDiagnostic(raw, [capability, "owner-token", "bearer-secret"])] }],
    });
    const root = mkdtempSync(join(tmpdir(), "rfo-matrix-redaction-"));
    try {
      const publication = writeObserverFailureMatrixArtifact(root, artifact, value.matrix, [capability, "owner-token", "bearer-secret"]);
      const output = `${readFileSync(publication.markdownPath, "utf8")}\n${readFileSync(publication.jsonPath, "utf8")}`;
      for (const sentinel of ["shelby", "server\\share", "/var/private", "4242", "owner-token", capability, "bearer-secret", "private-host", "raw-lifecycle-id", "raw-handler-lease"]) {
        expect(output).not.toContain(sentinel);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
});
