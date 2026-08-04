import { describe, expect, it, vi } from "vitest";
import { ObserverApplicationError } from "../../src/observer/errors.js";
import { prepareObserverLaunch } from "../../src/observer/launch.js";
import {
  OwnedRuntimeError,
  type OwnedRuntimeManager,
} from "../../src/observer/owned-runtime-manager.js";
import { createToolHarness, toolApplication, toolRegistry } from "./application-diagnostics-fixture.js";
import { deriveObserverRuntimeIdempotencyKey } from "../../src/tools/observer-runtime.js";

describe("observer MCP tools", () => {
  it("passes configured Workbench addon roots into launch preparation before caller arguments", async () => {
    const prepareLaunch = vi.fn(async (input: Record<string, unknown>) => ({
      arguments: input.arguments,
      session: {
        sessionId: "session-configured-addons",
        launchNonce: "secret-launch-nonce",
        expiresAt: "2026-07-15T12:30:00.000Z",
        bundleDigest: "a".repeat(64),
        profilePath: "C:/profiles/run-configured-addons",
        contractPath: "C:/profiles/run-configured-addons/profile/ReforgerForgeObserver/session.json",
      },
      stagedAddon: { reused: true },
    }));
    const coordinator = toolApplication({ prepareLaunch, revokeSession: vi.fn() });
    const manager = {
      recordPreparedLaunch: vi.fn(async () => "pl-00000000-0000-4000-8000-000000000002"),
    } as unknown as OwnedRuntimeManager;
    const registry = toolRegistry(
      coordinator,
      manager,
      { workbenchAddonDirs: ["C:/game/addons", "C:/workshop/addons"] },
    );

    const result = await registry.get("observer_prepare_launch")!.handler({
      runtimeKind: "listenServer",
      arguments: ["-server", "-addonsDir", "C:/caller/addons"],
      profilePath: "C:/profiles/run-configured-addons",
      sessionTtlMs: 60_000,
      transportPreference: ["rest"],
      forceUpdate: false,
      noFocus: false,
      forceNonNativeWindowSize: {
        width: 1280,
        height: 720,
        justification: "Native fullscreen is unavailable on the remote display.",
      },
    }, { signal: new AbortController().signal });

    expect(result.isError).not.toBe(true);
    expect(prepareLaunch).toHaveBeenCalledWith(expect.objectContaining({
      arguments: [
        "-addonsDir", "C:/game/addons,C:/workshop/addons",
        "-server", "-addonsDir", "C:/caller/addons",
      ],
      forceNonNativeWindowSize: {
        width: 1280,
        height: 720,
        justification: "Native fullscreen is unavailable on the remote display.",
      },
    }));
  });

  it.each(["-window", "-screenWidth", "-screenHeight=720"])(
    "refuses raw display override %s before private launch preparation",
    async (argument) => {
      const prepareLaunch = vi.fn();
      const registry = toolRegistry(toolApplication({ prepareLaunch }));

      const result = await registry.get("observer_prepare_launch")!.handler({
        runtimeKind: "client",
        arguments: [argument],
        profilePath: "C:/profiles/native-fullscreen",
        sessionTtlMs: 60_000,
        transportPreference: ["rest"],
        forceUpdate: true,
        noFocus: true,
      }, { signal: new AbortController().signal });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("ARGUMENT_CONFLICT");
      expect(result.content[0].text).toContain("forceNonNativeWindowSize");
      expect(prepareLaunch).not.toHaveBeenCalled();
    },
  );

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

  it("registers the ten exact public tools", () => {
    const { tools } = createToolHarness();
    expect([...tools.keys()].sort()).toEqual([
      "observer_capture",
      "observer_instances",
      "observer_job",
      "observer_prepare_launch",
      "observer_run_begin",
      "observer_run_discard",
      "observer_run_finalize",
      "observer_run_status",
      "observer_runtime",
      "observer_setup",
    ]);
    for (const tool of tools.values()) expect(tool.definition.description?.length).toBeGreaterThan(40);
    const prepare = tools.get("observer_prepare_launch")!;
    expect(prepare.definition.description).toContain("native borderless-fullscreen window by default");
    expect(prepare.definition.description).toContain("forceNonNativeWindowSize");
    const override = prepare.definition.inputSchema!.forceNonNativeWindowSize;
    expect(override.safeParse({
      width: 1280,
      height: 720,
      justification: "Native fullscreen is unavailable on the remote display.",
    }).success).toBe(true);
    expect(override.safeParse({
      width: 1280,
      height: 720,
      justification: "for screenshots",
    }).success).toBe(false);
  });

  it("routes explicit observer_runtime actions without exposing owner-token receipt fields", async () => {
    const manager = {
      start: vi.fn(async () => ({ runtimeId: "rt-one", state: "running", exactOwned: true })),
      status: vi.fn(async () => ({ runtimeId: "rt-one", state: "running", exactOwned: true })),
      stop: vi.fn(async () => ({ runtimeId: "rt-one", state: "exited", identityVacant: true })),
    } as unknown as OwnedRuntimeManager;
    const { handler, signal, extra } = createToolHarness({}, manager);
    const runtime = handler("observer_runtime");
    const preparedLaunchId = "pl-00000000-0000-4000-8000-000000000001";
    const started = await runtime({
      action: "start",
      preparedLaunchId,
    }, extra);
    expect(started.isError).not.toBe(true);
    expect(manager.start).toHaveBeenCalledWith({
      preparedLaunchId,
      idempotencyKey: deriveObserverRuntimeIdempotencyKey({ action: "start", preparedLaunchId }),
    });
    await runtime({ action: "status", runtimeId: "rt-00000000-0000-4000-8000-000000000001" }, extra);
    expect(manager.status).toHaveBeenCalledOnce();
    await runtime({
      action: "stop",
      runtimeId: "rt-00000000-0000-4000-8000-000000000001",
      waitForRestorationMs: 20_000,
    }, extra);
    expect(manager.stop).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: deriveObserverRuntimeIdempotencyKey({
        action: "stop",
        runtimeId: "rt-00000000-0000-4000-8000-000000000001",
        waitForRestorationMs: 20_000,
      }),
      waitForRestorationMs: 20_000,
      signal,
    }));
    const invalid = await runtime({ action: "start" }, extra);
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toContain("INVALID_REQUEST");
    expect(createToolHarness({}, manager).tools.get("observer_runtime")!.definition.inputSchema)
      .not.toHaveProperty("idempotencyKey");
  });

  it("reuses the same hidden lifecycle key when a start or stop response is lost", async () => {
    const observedStartKeys: string[] = [];
    const observedStopKeys: string[] = [];
    let startCalls = 0;
    let stopCalls = 0;
    const manager = {
      start: vi.fn(async (input: { idempotencyKey: string }) => {
        observedStartKeys.push(input.idempotencyKey);
        startCalls += 1;
        if (startCalls === 1) throw new OwnedRuntimeError("TRANSPORT_UNAVAILABLE", "start acknowledgement was lost");
        return { runtimeId: "rt-one", state: "running", exactOwned: true };
      }),
      stop: vi.fn(async (input: { idempotencyKey: string }) => {
        observedStopKeys.push(input.idempotencyKey);
        stopCalls += 1;
        if (stopCalls === 1) throw new OwnedRuntimeError("TRANSPORT_UNAVAILABLE", "stop acknowledgement was lost");
        return { runtimeId: input.idempotencyKey, state: "exited", identityVacant: true };
      }),
    } as unknown as OwnedRuntimeManager;
    const { call } = createToolHarness({}, manager);
    const start = { action: "start" as const, preparedLaunchId: "pl-00000000-0000-4000-8000-000000000001" };
    const stop = { action: "stop" as const, runtimeId: "rt-00000000-0000-4000-8000-000000000001", waitForRestorationMs: 0 };

    expect((await call("observer_runtime", start)).isError).toBe(true);
    expect((await call("observer_runtime", start)).isError).not.toBe(true);
    expect(observedStartKeys).toEqual([
      deriveObserverRuntimeIdempotencyKey(start),
      deriveObserverRuntimeIdempotencyKey(start),
    ]);

    expect((await call("observer_runtime", stop)).isError).toBe(true);
    expect((await call("observer_runtime", stop)).isError).not.toBe(true);
    expect(observedStopKeys).toEqual([
      deriveObserverRuntimeIdempotencyKey(stop),
      deriveObserverRuntimeIdempotencyKey(stop),
    ]);
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
        throw new ObserverApplicationError("UNAUTHORIZED",
          `private authorization diagnostic: ${secret}`, { originalDiagnostic: secret });
      }),
    }, manager);
    const runtimeResult = await call("observer_runtime", {
      action: "start",
      preparedLaunchId: "pl-00000000-0000-4000-8000-000000000001",
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
