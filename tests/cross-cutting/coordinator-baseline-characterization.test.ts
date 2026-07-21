import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import {
  FileEvidenceBundleService,
  type EvidenceRunExportSnapshot,
} from "../../observer/agent/evidence-bundle-service.js";
import { redactForDiagnostics } from "../../observer/agent/logger.js";
import { redactChildLine } from "../../src/observer/agent-client.js";
import type { ObserverApplication } from "../../src/observer/application.js";
import { ObserverCoordinatorError } from "../../src/observer/errors.js";
import {
  OwnedRuntimeError,
  type OwnedRuntimeManager,
} from "../../src/observer/owned-runtime-manager.js";
import { registerObserverTools } from "../../src/observer/tools.js";
import {
  waitForVacancy,
  type WorkbenchReadinessTiming,
} from "../../src/workbench/readiness.js";
import { contractPng } from "../observer/capture-policy-fixture.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface RegisteredTool {
  handler: (input: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<ToolResult>;
}

function registeredTools(
  application: ObserverApplication,
  ownedRuntimeManager: OwnedRuntimeManager
): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool(
      name: string,
      _definition: unknown,
      handler: RegisteredTool["handler"]
    ): void {
      tools.set(name, { handler });
    },
  } as unknown as McpServer;
  registerObserverTools(server, application, { ownedRuntimeManager });
  return tools;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function evidenceSnapshot(): EvidenceRunExportSnapshot {
  const artifact = {
    backend: "workbench" as const,
    jobId: "job-1",
    storeKey: "workbench/job-1",
    sha256: sha256(contractPng),
    bytes: contractPng.length,
    width: 1,
    height: 1,
  };
  return {
    run: {
      runId: "20260719T190000Z-a1b2c3d4",
      title: "Task 0 redaction baseline",
      caseIds: ["CC-0-REDACTION"],
      createdAt: "2026-07-19T19:00:00.000Z",
    },
    captures: [{
      label: "overview",
      state: "completed",
      backend: "workbench",
      jobId: "job-1",
      instanceId: "wb-1",
      worldId: "world-1",
      worldEpoch: 0,
      requestedView: { kind: "current" },
      performancePolicy: "evidence",
      artifact,
    }],
    artifacts: [{
      captureLabel: "overview",
      image: contractPng,
      metadata: {
        contentSha256: artifact.sha256,
        completedAt: "2026-07-19T19:00:01.000Z",
      },
    }],
  };
}

function deterministicTiming(now: { value: number }, waits: number[]): WorkbenchReadinessTiming {
  return {
    now: () => now.value,
    setTimeout(callback, delayMs) {
      waits.push(delayMs);
      queueMicrotask(() => {
        now.value += delayMs;
        callback();
      });
      return waits.length;
    },
    clearTimeout() {
      // The callback has already become the next microtask. This seam records
      // the requested interval; the poller still owns cancellation/error mapping.
    },
  };
}

describe("cross-cutting coordinator baseline characterization", () => {
  it("keeps known secret sentinels out of diagnostic and evidence sinks", async () => {
    const diagnostic = JSON.stringify(redactForDiagnostics({
      token: "token-sentinel",
      authorization: "authorization-sentinel",
      credential: "credential-sentinel",
      nonce: "nonce-sentinel",
      secret: "secret-sentinel",
      contract: { sessionId: "contract-sentinel" },
      nested: [{ sessionToken: "nested-token-sentinel" }],
      message: "Authorization: Bearer bearer-sentinel",
    }));
    const childLine = redactChildLine(
      "token=token-sentinel credential=credential-sentinel secret=secret-sentinel " +
      "launchNonce=nonce-sentinel contractPayload={\"value\":\"contract-sentinel\"} " +
      "Authorization: Bearer bearer-sentinel"
    );

    for (const sentinel of [
      "token-sentinel",
      "authorization-sentinel",
      "credential-sentinel",
      "nonce-sentinel",
      "secret-sentinel",
      "contract-sentinel",
      "nested-token-sentinel",
      "bearer-sentinel",
    ]) {
      expect(diagnostic, `diagnostic leaked ${sentinel}`).not.toContain(sentinel);
      expect(childLine, `child diagnostic leaked ${sentinel}`).not.toContain(sentinel);
    }

    await withTemporaryDirectory((root) => {
      const evidence = join(root, "evidence");
      const logs = join(root, "logs");
      mkdirSync(evidence);
      mkdirSync(logs);
      const log = join(logs, "runtime.log");
      writeFileSync(log, [
        "Authorization: Bearer bearer-sentinel",
        "token=token-sentinel",
        "credential=credential-sentinel",
        "password=password-sentinel",
        "secret=secret-sentinel",
      ].join("\n"), "utf8");
      const service = new FileEvidenceBundleService(join(root, "work"), [evidence], [logs]);
      const prepared = service.prepare({
        runId: "20260719T190000Z-a1b2c3d4",
        evidenceRoot: evidence,
        includeCaptureLabels: ["overview"],
        review: {
          imagesReviewed: true,
          reviewer: "baseline-reviewer",
          outcome: "Passed",
          summary: "Baseline redaction coverage.",
        },
        supportingFiles: [{ kind: "relevantLog", label: "runtime", path: log }],
        releaseManagedArtifacts: false,
      });
      const receipt = service.export(evidenceSnapshot(), prepared);
      const copiedLog = readFileSync(join(receipt.evidenceDirectory, "relevant-logs", "runtime.log"), "utf8");
      for (const sentinel of [
        "bearer-sentinel",
        "token-sentinel",
        "credential-sentinel",
        "password-sentinel",
        "secret-sentinel",
      ]) {
        expect(copiedLog, `evidence leaked ${sentinel}`).not.toContain(sentinel);
      }
    }, { prefix: "rfo-task0-redaction-" });
  });

  it("keeps both MCP boundaries' current fixed public code and message policy", async () => {
    const application = {
      defaultCaptureTimeoutMs: 30_000,
      maxInlineImageBytes: 1_024,
      async instances(): Promise<never> {
        throw new ObserverCoordinatorError("UNAUTHORIZED", "authorization-sentinel");
      },
    } as unknown as ObserverApplication;
    const ownedRuntimeManager = {
      async status(): Promise<never> {
        throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "storage-sentinel");
      },
    } as unknown as OwnedRuntimeManager;
    const tools = registeredTools(application, ownedRuntimeManager);
    const signal = new AbortController().signal;

    const observer = await tools.get("observer_instances")!.handler({}, { signal });
    const runtime = await tools.get("observer_runtime")!.handler({
      action: "status",
      runtimeId: "rt-00000000-0000-4000-8000-000000000001",
    }, { signal });

    expect(observer).toEqual({
      content: [{
        type: "text",
        text: "Observer error (UNAUTHORIZED): Observer request was not authorized.",
      }],
      isError: true,
    });
    expect(runtime).toEqual({
      content: [{
        type: "text",
        text: "Observer runtime error (STORAGE_UNVERIFIABLE): Observer lifecycle storage could not be verified.",
      }],
      isError: true,
    });
  });

  it("projects equivalent permitted diagnostics through both MCP boundaries", async () => {
    const diagnostics = {
      token: "token-sentinel",
      nonce: "nonce-sentinel",
      contractBody: { private: "contract-body-sentinel" },
      path: "C:\\Users\\name\\observer-private",
      safe: "control-sentinel",
    };
    const message =
      "Authorization: Bearer bearer-sentinel -reforgerForgeOwnerToken=owner-token-sentinel " +
      "at C:\\Users\\name\\observer-private";
    const application = {
      defaultCaptureTimeoutMs: 30_000,
      maxInlineImageBytes: 1_024,
      async instances(): Promise<never> {
        throw new ObserverCoordinatorError("INVALID_REQUEST", message, diagnostics);
      },
    } as unknown as ObserverApplication;
    const ownedRuntimeManager = {
      async status(): Promise<never> {
        throw new OwnedRuntimeError("INVALID_REQUEST", message, diagnostics);
      },
    } as unknown as OwnedRuntimeManager;
    const tools = registeredTools(application, ownedRuntimeManager);
    const signal = new AbortController().signal;

    const observer = await tools.get("observer_instances")!.handler({}, { signal });
    const runtime = await tools.get("observer_runtime")!.handler({
      action: "status",
      runtimeId: "rt-00000000-0000-4000-8000-000000000001",
    }, { signal });
    const observerText = observer.content[0].text;
    const runtimeText = runtime.content[0].text;

    expect(runtimeText.replace("Observer runtime error", "Observer error")).toBe(observerText);
    expect(observerText).toContain("```json");
    expect(observerText).toContain("control-sentinel");
    expect(observerText.length).toBeLessThanOrEqual(512);
    expect(runtimeText.length).toBeLessThanOrEqual(512);
    for (const sentinel of [
      "bearer-sentinel",
      "owner-token-sentinel",
      "token-sentinel",
      "nonce-sentinel",
      "contract-body-sentinel",
      "C:\\Users\\name\\observer-private",
    ]) {
      expect(observerText, `observer public error leaked ${sentinel}`).not.toContain(sentinel);
      expect(runtimeText, `runtime public error leaked ${sentinel}`).not.toContain(sentinel);
    }
  });

  it("preserves immediate probing, bounded intervals, timeout, cancellation, and error mapping", async () => {
    const now = { value: 100 };
    const waits: number[] = [];
    const probes: number[] = [];
    await waitForVacancy({
      endpoint: { host: "127.0.0.1", port: 5775 },
      deadlineMs: 151,
      pollIntervalMs: 25,
      timing: deterministicTiming(now, waits),
      async verify() {
        probes.push(now.value);
        return probes.length === 3
          ? { kind: "vacant" as const }
          : { kind: "occupied" as const, listenerPid: 42, message: "still running" };
      },
    });
    expect(probes).toEqual([100, 125, 150]);
    expect(waits).toEqual([25, 25]);

    const timeoutNow = { value: 200 };
    const timeoutWaits: number[] = [];
    await expect(waitForVacancy({
      endpoint: { host: "127.0.0.1", port: 5775 },
      deadlineMs: 250,
      pollIntervalMs: 80,
      timing: deterministicTiming(timeoutNow, timeoutWaits),
      async verify() {
        return { kind: "occupied" as const, listenerPid: 42, message: "still running" };
      },
    })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(timeoutWaits).toEqual([50]);

    const controller = new AbortController();
    controller.abort();
    await expect(waitForVacancy({
      endpoint: { host: "127.0.0.1", port: 5775 },
      deadlineMs: Date.now() + 300,
      pollIntervalMs: 25,
      signal: controller.signal,
      async verify() {
        throw new Error("must not probe after cancellation");
      },
    })).rejects.toMatchObject({ code: "ABORTED" });

    await expect(waitForVacancy({
      endpoint: { host: "127.0.0.1", port: 5775 },
      deadlineMs: Date.now() + 300,
      pollIntervalMs: 25,
      async verify() {
        return {
          kind: "unverifiable" as const,
          reason: "helper_failure",
          message: "identity cannot be proven",
        };
      },
    })).rejects.toMatchObject({ code: "ENDPOINT_UNVERIFIABLE" });
  });
});
