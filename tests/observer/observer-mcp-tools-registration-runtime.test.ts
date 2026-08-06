import { describe, expect, it, vi } from "vitest";
import { ObserverApplicationError } from "../../src/observer/errors.js";
import { prepareObserverLaunch } from "../../src/observer/launch.js";
import {
  OwnedRuntimeError,
  type OwnedRuntimeManager,
} from "../../src/observer/owned-runtime-manager.js";
import { createToolHarness, toolApplication, toolRegistry } from "./application-diagnostics-fixture.js";
import { deriveObserverRuntimeIdempotencyKey } from "../../src/tools/observer-runtime.js";

function payload(result: { content: Array<{ text?: string }> }): Record<string, unknown> {
  const text = result.content[0]?.text ?? "";
  const match = /```json\n([\s\S]+)\n```$/.exec(text);
  if (!match) throw new Error(`Expected JSON tool payload: ${text}`);
  return JSON.parse(match[1]) as Record<string, unknown>;
}

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
    const resolveRuntimeExecutablePath = vi.fn(() =>
      "C:/game/ArmaReforgerSteamDiag.exe");
    const manager = {
      resolveRuntimeExecutablePath,
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
    expect(resolveRuntimeExecutablePath).toHaveBeenCalledWith("listenServer");
    expect(resolveRuntimeExecutablePath.mock.invocationCallOrder[0])
      .toBeLessThan(prepareLaunch.mock.invocationCallOrder[0]);
    expect(payload(result)).toMatchObject({
      executablePath: "C:/game/ArmaReforgerSteamDiag.exe",
      arguments: [
        "-addonsDir", "C:/game/addons,C:/workshop/addons",
        "-server", "-addonsDir", "C:/caller/addons",
      ],
      preparedLaunchId: "pl-00000000-0000-4000-8000-000000000002",
      sessionId: "session-configured-addons",
    });
    for (const ownershipField of [
      "executableFile",
      "executableEvidenceDigest",
      "ownerTokenArgument",
      "pid",
      "identityVacant",
    ]) {
      expect(payload(result)).not.toHaveProperty(ownershipField);
    }
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

  it("fails executable resolution before private preparation or durable recording", async () => {
    const prepareLaunch = vi.fn();
    const revokeSession = vi.fn();
    const recordPreparedLaunch = vi.fn();
    const resolveRuntimeExecutablePath = vi.fn(() => {
      throw new OwnedRuntimeError(
        "RUNTIME_NOT_FOUND",
        "No allowlisted graphical executable exists beneath the configured game path",
        undefined,
        "runtime_executable_missing",
      );
    });
    const registry = toolRegistry(
      toolApplication({ prepareLaunch, revokeSession }),
      { resolveRuntimeExecutablePath, recordPreparedLaunch } as unknown as OwnedRuntimeManager,
    );

    const result = await registry.get("observer_prepare_launch")!.handler({
      runtimeKind: "client",
      arguments: [],
      profilePath: "C:/profiles/missing-runtime",
      sessionTtlMs: 60_000,
      transportPreference: ["rest"],
      forceUpdate: true,
      noFocus: true,
    }, { signal: new AbortController().signal });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("RUNTIME_NOT_FOUND");
    expect(result.content[0].text).toContain("correct the configured game path");
    expect(result.content[0].text!.length).toBeLessThanOrEqual(512);
    expect(resolveRuntimeExecutablePath).toHaveBeenCalledWith("client");
    expect(prepareLaunch).not.toHaveBeenCalled();
    expect(recordPreparedLaunch).not.toHaveBeenCalled();
    expect(revokeSession).not.toHaveBeenCalled();
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
      expect(result.content[0].text).toContain("Next action: remove -window");
      expect(result.content[0].text!.length).toBeLessThanOrEqual(512);
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

  it("registers the ten observer primitives plus the owned game composite", () => {
    const { tools } = createToolHarness();
    expect([...tools.keys()].sort()).toEqual([
      "game_launch",
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
    expect(prepare.definition.description).toContain("canonical executablePath");
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
    const gameLaunch = tools.get("game_launch")!;
    expect(gameLaunch.definition.description).toContain("fail-closed");
    expect(gameLaunch.definition.inputSchema!.action.safeParse(undefined).success).toBe(true);
    expect(gameLaunch.definition.inputSchema!.runtimeKind.safeParse(undefined).success).toBe(true);
    expect(gameLaunch.definition.inputSchema!.runtimeId.safeParse("rt-not-exact").success).toBe(false);
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

  it("routes bounded history inspection and explicit recovery through strict selected branches", async () => {
    const inspectRuntimeHistory = vi.fn(async () => ({
      schemaVersion: 1,
      complete: true,
      recoverableRuntimeIds: [],
    }));
    const recoverRuntimeHistory = vi.fn(async () => ({
      schemaVersion: 1,
      attemptedRuntimeIds: [],
      recoveredRuntimeIds: [],
      blocked: [],
    }));
    const manager = { inspectRuntimeHistory, recoverRuntimeHistory } as unknown as OwnedRuntimeManager;
    const { call, signal } = createToolHarness({}, manager);

    const history = await call("observer_runtime", {
      action: "history",
      maxRuntimes: 7,
      deadlineMs: 12_000,
    });
    expect(history.isError).not.toBe(true);
    expect(history.content[0].text).toContain("Bounded owned-runtime history classification.");
    expect(inspectRuntimeHistory).toHaveBeenCalledWith({
      maxRuntimes: 7,
      deadlineMs: 12_000,
      signal,
    });

    const recovery = await call("observer_runtime", {
      action: "recover",
      maxRuntimes: 3,
    });
    expect(recovery.isError).not.toBe(true);
    expect(recovery.content[0].text).toContain("Bounded owned-runtime history recovery.");
    expect(recoverRuntimeHistory).toHaveBeenCalledWith({ maxRuntimes: 3, signal });

    const runtimeId = "rt-00000000-0000-4000-8000-000000000001";
    for (const input of [
      { action: "history", runtimeId },
      { action: "recover", preparedLaunchId: "pl-00000000-0000-4000-8000-000000000001" },
      { action: "status", runtimeId, maxRuntimes: 2 },
      { action: "start", preparedLaunchId: "pl-00000000-0000-4000-8000-000000000001", waitForRestorationMs: 0 },
    ]) {
      const invalid = await call("observer_runtime", input);
      expect(invalid.isError).toBe(true);
      expect(invalid.content[0].text).toContain("INVALID_REQUEST");
    }
    expect(inspectRuntimeHistory).toHaveBeenCalledOnce();
    expect(recoverRuntimeHistory).toHaveBeenCalledOnce();
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

  it("projects a consumed preparation only to status for its exact bounded runtime", async () => {
    const runtimeId = "rt-00000000-0000-4000-8000-000000000042";
    const manager = {
      start: vi.fn(async () => {
        throw new OwnedRuntimeError(
          "PREPARED_LAUNCH_CONSUMED",
          "Prepared launch is one-shot and has already been consumed",
          { runtimeId }
        );
      }),
    } as unknown as OwnedRuntimeManager;
    const { call } = createToolHarness({}, manager);

    const result = await call("observer_runtime", {
      action: "start",
      preparedLaunchId: "pl-00000000-0000-4000-8000-000000000001",
    });
    const text = result.content[0].text!;

    expect(result.isError).toBe(true);
    expect(text).toContain("PREPARED_LAUNCH_CONSUMED");
    expect(text).toContain(runtimeId);
    expect(text).toContain(JSON.stringify({ action: "status", runtimeId }));
    expect(text).not.toContain('"action":"start"');
    expect(text).not.toContain("prepare and start again");
    expect(text.length).toBeLessThanOrEqual(512);
  });

  it("suppresses consumed-launch status advice without an exact runtime ID", async () => {
    const manager = {
      start: vi.fn(async () => {
        throw new OwnedRuntimeError(
          "PREPARED_LAUNCH_CONSUMED",
          "Prepared launch is one-shot and has already been consumed",
          { runtimeId: "rt-malformed" }
        );
      }),
    } as unknown as OwnedRuntimeManager;
    const { call } = createToolHarness({}, manager);

    const result = await call("observer_runtime", {
      action: "start",
      preparedLaunchId: "pl-00000000-0000-4000-8000-000000000001",
    });

    expect(result.content[0].text).not.toContain("Next action:");
    expect(result.content[0].text!.length).toBeLessThanOrEqual(512);
  });

  it("keeps runtime-not-found recovery specific to start, status, and stop", async () => {
    const manager = {
      start: vi.fn(async () => {
        throw new OwnedRuntimeError(
          "RUNTIME_NOT_FOUND",
          "graphical executable is unavailable",
          undefined,
          "runtime_executable_missing"
        );
      }),
      status: vi.fn(async () => {
        throw new OwnedRuntimeError("RUNTIME_NOT_FOUND", "runtime receipt is unavailable");
      }),
      stop: vi.fn(async () => {
        throw new OwnedRuntimeError("RUNTIME_NOT_FOUND", "runtime receipt is unavailable");
      }),
    } as unknown as OwnedRuntimeManager;
    const { call } = createToolHarness({}, manager);
    const runtimeId = "rt-00000000-0000-4000-8000-000000000042";

    const start = await call("observer_runtime", {
      action: "start",
      preparedLaunchId: "pl-00000000-0000-4000-8000-000000000001",
    });
    const status = await call("observer_runtime", { action: "status", runtimeId });
    const stop = await call("observer_runtime", {
      action: "stop",
      runtimeId,
      waitForRestorationMs: 0,
    });

    expect(start.content[0].text).toContain("correct the configured game path");
    expect(status.content[0].text).toContain("runtimeId returned by a successful");
    expect(stop.content[0].text).toContain("never stop a process by PID or name");
  });

  it("offers fresh inventory only when an instance failure owns a session ID", async () => {
    const instances = vi.fn(async () => {
      throw new ObserverApplicationError("NO_RENDER_ENDPOINT", "No compatible renderer is available");
    });
    const { call } = createToolHarness({ instances });

    const owned = await call("observer_instances", { sessionId: "session-owned-1" });
    const unscoped = await call("observer_instances", {});

    expect(owned.content[0].text).toContain(
      JSON.stringify({ sessionId: "session-owned-1" })
    );
    expect(unscoped.content[0].text).not.toContain("Next action:");
  });

});
