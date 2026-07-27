import { describe, expect, it, vi } from "vitest";
import { ObserverCoordinatorError } from "../../src/observer/errors.js";
import { prepareObserverLaunch } from "../../src/observer/launch.js";
import {
  OwnedRuntimeError,
  type OwnedRuntimeManager,
} from "../../src/observer/owned-runtime-manager.js";
import { createToolHarness, toolApplication } from "./application-diagnostics-fixture.js";

describe("observer MCP tools", () => {
  it("returns only the public launch descriptor and does not expose launch credentials", async () => {
    const coordinator = toolApplication({
      prepareLaunch: vi.fn(async () => ({
        arguments: ["-profile", "C:/profiles/run-1"],
        session: {
          sessionId: "session-1", launchNonce: "secret-launch-nonce",
          expiresAt: "2026-07-15T12:30:00.000Z",
          bundleDigest: "a".repeat(64), profilePath: "C:/profiles/run-1",
          contractPath: "C:/profiles/run-1/profile/ReforgerForgeObserver/session.json",
        },
        stagedAddon: { reused: true },
      })),
      revokeSession: vi.fn(),
    });

    const recorder = {
      recordPreparedLaunch: vi.fn(async () => "pl-00000000-0000-4000-8000-000000000001"),
    };
    const launchInput: Parameters<typeof prepareObserverLaunch>[1] = {
      runtimeKind: "client", arguments: [], profilePath: "C:/profiles/run-1", sessionTtlMs: 60_000,
      transportPreference: ["rest"] as const,
      forceUpdate: false,
      noFocus: false,
    };
    const result = await prepareObserverLaunch(coordinator, launchInput, recorder);

    expect(result).toMatchObject({
      arguments: ["-profile", "C:/profiles/run-1"],
      preparedLaunchId: "pl-00000000-0000-4000-8000-000000000001",
      sessionId: "session-1",
      expiresAt: "2026-07-15T12:30:00.000Z",
      bundleDigest: "a".repeat(64),
      profilePath: "C:/profiles/run-1",
      warnings: [],
    });
    expect(result).not.toHaveProperty("launchNonce");
    expect(result).not.toHaveProperty("contractPath");
    expect(recorder.recordPreparedLaunch).toHaveBeenCalledOnce();

    const externalOnly = await prepareObserverLaunch(coordinator, launchInput);
    expect(externalOnly.arguments).toEqual(["-profile", "C:/profiles/run-1"]);
    expect(externalOnly).not.toHaveProperty("preparedLaunchId");
  });

  it("registers the seven exact public tools", () => {
    const { tools } = createToolHarness();
    expect([...tools.keys()].sort()).toEqual([
      "observer_capture",
      "observer_instances",
      "observer_job",
      "observer_prepare_launch",
      "observer_run",
      "observer_runtime",
      "observer_setup",
    ]);
    for (const tool of tools.values()) expect(tool.definition.description?.length).toBeGreaterThan(40);
  });

  it("routes explicit observer_runtime actions without exposing owner-token receipt fields", async () => {
    const manager = {
      start: vi.fn(async () => ({ runtimeId: "rt-one", state: "running", exactOwned: true })),
      status: vi.fn(async () => ({ runtimeId: "rt-one", state: "running", exactOwned: true })),
      stop: vi.fn(async () => ({ runtimeId: "rt-one", state: "exited", identityVacant: true })),
    } as unknown as OwnedRuntimeManager;
    const { handler, signal, extra } = createToolHarness({}, manager);
    const runtime = handler("observer_runtime");
    const started = await runtime({
      action: "start",
      preparedLaunchId: "pl-00000000-0000-4000-8000-000000000001",
      idempotencyKey: "start-one",
    }, extra);
    expect(started.isError).not.toBe(true);
    expect(manager.start).toHaveBeenCalledWith({
      preparedLaunchId: "pl-00000000-0000-4000-8000-000000000001",
      idempotencyKey: "start-one",
    });
    await runtime({ action: "status", runtimeId: "rt-00000000-0000-4000-8000-000000000001" }, extra);
    expect(manager.status).toHaveBeenCalledOnce();
    await runtime({
      action: "stop",
      runtimeId: "rt-00000000-0000-4000-8000-000000000001",
      waitForRestorationMs: 20_000,
      idempotencyKey: "stop-one",
    }, extra);
    expect(manager.stop).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "stop-one",
      waitForRestorationMs: 20_000,
      signal,
    }));
    const invalid = await runtime({ action: "start" }, extra);
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toContain("INVALID_REQUEST");
  });

  it("does not re-expose fixed-policy diagnostics through structured tool details", async () => {
    const secret = "must-not-cross-the-public-boundary";
    const manager = {
      start: vi.fn(async () => {
        throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE",
          `private storage diagnostic: ${secret}`, { originalDiagnostic: secret });
      }),
    } as unknown as OwnedRuntimeManager;
    const { call } = createToolHarness({
      instances: vi.fn(async () => {
        throw new ObserverCoordinatorError("UNAUTHORIZED",
          `private authorization diagnostic: ${secret}`, { originalDiagnostic: secret });
      }),
    }, manager);
    const runtimeResult = await call("observer_runtime", {
      action: "start",
      preparedLaunchId: "pl-00000000-0000-4000-8000-000000000001",
      idempotencyKey: "redacted-start",
    });
    const instancesResult = await call("observer_instances", {});

    expect(runtimeResult.content[0].text).toContain("Observer lifecycle storage could not be verified.");
    expect(instancesResult.content[0].text).toContain("Observer request was not authorized.");
    expect(runtimeResult.content[0].text).not.toContain(secret);
    expect(instancesResult.content[0].text).not.toContain(secret);
    expect(runtimeResult.content[0].text).not.toContain("originalDiagnostic");
    expect(instancesResult.content[0].text).not.toContain("originalDiagnostic");
  });

  it("renders permitted runtime diagnostics through the central safe public projector", async () => {
    const manager = {
      status: vi.fn(async () => {
        throw new OwnedRuntimeError("INVALID_REQUEST",
          "Authorization: Bearer bearer-sentinel at C:\\Users\\name\\runtime-private",
          { token: "token-sentinel", path: "C:\\Users\\name\\runtime-private", safe: "safe-control" });
      }),
    } as unknown as OwnedRuntimeManager;
    const { call } = createToolHarness({}, manager);
    const result = await call("observer_runtime", {
      action: "status",
      runtimeId: "rt-00000000-0000-4000-8000-000000000001",
    });
    const text = result.content[0].text!;

    expect(text).toContain("Observer runtime error (INVALID_REQUEST):");
    expect(text).toContain("```json");
    expect(text).toContain("safe-control");
    expect(text.length).toBeLessThanOrEqual(512);
    expect(text).not.toContain("bearer-sentinel");
    expect(text).not.toContain("token-sentinel");
    expect(text).not.toContain("C:\\Users\\name\\runtime-private");
  });

});
