import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ObserverApplication } from "../../src/observer/application.js";
import { ObserverApplicationError } from "../../src/observer/errors.js";
import {
  computeOwnedGameLaunchEvidenceDigest,
  type OwnedRuntimeManager,
} from "../../src/observer/owned-runtime-manager.js";
import {
  canonicalGameLaunchPrepareIdentity,
  type CanonicalGameLaunchPreparation,
  computeGameLaunchPlanningKey,
  computeGameLaunchPrepareKey,
  GAME_LAUNCH_READINESS_WARNING,
  gameLaunchOutputSchema,
  gameLaunchRawInputSchema,
  gameLaunchRawInputShape,
  gameLaunchSuccessSchema,
  parseGameLaunchInput,
  planCanonicalGameLaunch,
  registerGameLaunch,
  type GameLaunchPrepareIdentity,
  type GameLaunchStartInput,
  type RegisterGameLaunchOptions,
} from "../../src/tools/game-launch.js";
import { PUBLIC_OBSERVER_ERROR_TEXT_MAXIMUM } from "../../src/observer/public-contract.js";
import {
  canonicalOwnedGameLaunchAttemptIdentity,
  deriveObserverRuntimeIdempotencyKey,
  deriveOwnedGameLaunchAttemptKey,
} from "../../src/tools/owned-runtime-operations.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";
import {
  cleanupOwnedRuntimeManagerFixtures,
  createFakeBackend,
  createLeaseLosingBackend,
  createSerialBackend,
  listRecordIds,
  makeHarness,
  readRecord,
  removeRecord,
  writeRecord,
} from "./owned-runtime-manager-fixture.js";
import { LifecycleGuardError } from "../../src/workbench/process-guard.js";
import { gameLaunchRevalidationDeadlineError } from
  "../../src/launch/game-launch-revalidation-isolation.js";

const TARGET_GUID = "AAAAAAAAAAAAAAAA";
const DEPENDENCY_GUID = "BBBBBBBBBBBBBBBB";
const WORLD_GUID = "A1B2C3D4E5F60718";
const WINDOWS_NATIVE_TEST_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 5_000;

function waitForInjectedRevalidation(
  release: Promise<void>,
  deadlineAtMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => finish(new Error("fixture revalidation lease was aborted"));
    const timer = setTimeout(
      () => finish(gameLaunchRevalidationDeadlineError()),
      Math.max(0, deadlineAtMs - Date.now()),
    );
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void release.then(() => finish(), (error: unknown) =>
      finish(error instanceof Error ? error : new Error("fixture revalidation failed")));
  });
}

interface ProjectFixture {
  readonly projectPath: string;
  readonly worldPath: string;
  readonly metaPath: string;
  readonly dependencyPath?: string;
  readonly addonRoot?: string;
}

function createProjectFixture(root: string, dependency = false): ProjectFixture {
  const workspace = join(root, "workspace");
  const modDirectory = join(workspace, "Target");
  mkdirSync(join(modDirectory, "Worlds"), { recursive: true });
  const projectPath = join(modDirectory, "Target.gproj");
  writeFileSync(projectPath, [
    "GameProject {",
    ' ID "Target"',
    ` GUID "${TARGET_GUID}"`,
    " Dependencies {",
    ...(dependency ? [`  "${DEPENDENCY_GUID}"`] : []),
    " }",
    "}",
    "",
  ].join("\n"));
  const worldPath = join(modDirectory, "Worlds", "LaunchFixture.ent");
  const metaPath = `${worldPath}.meta`;
  writeFileSync(worldPath, "SubScene {\n Name \"LaunchFixture\"\n}\n");
  writeFileSync(metaPath, `MetaFileClass {\n Name "{${WORLD_GUID}}Worlds/LaunchFixture.ent"\n}\n`);
  if (!dependency) return { projectPath, worldPath, metaPath };
  const addonRoot = join(root, "dependency-addons");
  const dependencyDirectory = join(addonRoot, "Dependency");
  mkdirSync(dependencyDirectory, { recursive: true });
  const dependencyPath = join(dependencyDirectory, "Dependency.gproj");
  writeFileSync(dependencyPath, [
    "GameProject {",
    ' ID "Dependency"',
    ` GUID "${DEPENDENCY_GUID}"`,
    " Dependencies {",
    " }",
    "}",
    "",
  ].join("\n"));
  return { projectPath, worldPath, metaPath, dependencyPath, addonRoot };
}

function preparedResponse(input: Record<string, unknown>, sessionId = "session-game-launch") {
  const argumentsArray = Array.isArray(input.arguments)
    ? input.arguments.filter((value): value is string => typeof value === "string")
    : [];
  const profilePath = String(input.profilePath);
  return {
    arguments: [...argumentsArray, "-profile", profilePath],
    session: {
      sessionId,
      launchNonce: "private-launch-nonce",
      expiresAt: "2026-07-18T12:10:00.000Z",
      bundleDigest: "a".repeat(64),
      profilePath,
      contractPath: join(profilePath, "profile", "ReforgerForgeObserver", "session.json"),
    },
    stagedAddon: { reused: true },
    warnings: [],
  };
}

function managerPreparedResponse(
  plan: CanonicalGameLaunchPreparation,
  sessionId: string,
) {
  return {
    arguments: [...plan.arguments],
    sessionId,
    expiresAt: "2026-07-18T12:10:00.000Z",
    bundleDigest: "a".repeat(64),
    profilePath: plan.profilePath,
    warnings: [],
  };
}

const inspectIdle = (manager: OwnedRuntimeManager) =>
  manager.inspectIdleShutdownReadiness({
    deadlineTick: performance.now() + 2_000,
    signal: new AbortController().signal,
    probeGeneration: 1,
  });

function testApplication(
  managedRoot: string,
  overrides: Partial<ObserverApplication> = {},
): ObserverApplication {
  return {
    managedRoot,
    profileRoot: join(managedRoot, "profiles"),
    prepareLaunch: vi.fn(async (input: Record<string, unknown>) => preparedResponse(input)),
    revokeSession: vi.fn(async () => ({ revoked: true })),
    instances: vi.fn(async () => ({
      instances: [{
        sessionId: "session-game-launch",
        instanceId: "runtime-renderer-1",
        target: "ct1.opaque-runtime-target",
        capabilities: ["render.capture"],
      }],
      compatibleCount: 1,
      waitedMs: 10,
      timedOut: false,
    })),
    ...overrides,
  } as unknown as ObserverApplication;
}

function register(
  application: ObserverApplication,
  manager: OwnedRuntimeManager,
  configuredAddonRoots: readonly string[] = [],
  overrides: Partial<RegisterGameLaunchOptions> = {},
) {
  let definition!: {
    title?: string;
    description?: string;
    inputSchema?: typeof gameLaunchRawInputShape;
    outputSchema?: typeof gameLaunchOutputSchema;
  };
  let handler!: (input: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<{
    content: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }>;
  const server = {
    registerTool(name: string, registeredDefinition: typeof definition, registered: typeof handler): void {
      if (name === "game_launch") {
        definition = registeredDefinition;
        handler = registered;
      }
    },
  } as unknown as McpServer;
  registerGameLaunch(server, application, {
    manager,
    configuredAddonRoots,
    defaultSessionTtlMs: 60_000,
    ...overrides,
  });
  const call = (input: Record<string, unknown>, signal = new AbortController().signal) =>
    handler(input, { signal });
  return Object.assign(call, { definition });
}

function payload(result: {
  content: Array<{ text?: string }>;
  structuredContent?: Record<string, unknown>;
}): Record<string, unknown> {
  if (result.structuredContent === undefined) {
    throw new Error("Expected structured game_launch success payload");
  }
  const parsed = gameLaunchSuccessSchema.safeParse(result.structuredContent);
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data as Record<string, unknown>;
}

afterEach(async () => {
  await cleanupOwnedRuntimeManagerFixtures();
});

describe("owned game launch composite", { timeout: WINDOWS_NATIVE_TEST_TIMEOUT_MS }, () => {
  it("selects the action before applying strict branch defaults", () => {
    expect(gameLaunchRawInputSchema.parse({})).toEqual({});
    expect(parseGameLaunchInput({}, 75_000)).toEqual({
      action: "start",
      runtimeKind: "listenServer",
      arguments: [],
      waitForInstanceMs: 60_000,
      sessionTtlMs: 75_000,
      forceUpdate: true,
      noFocus: true,
    });
    expect(parseGameLaunchInput({
      action: "stop",
      runtimeId: "rt-00000000-0000-4000-8000-000000000001",
    }, 60_000)).toMatchObject({ action: "stop", waitForRestorationMs: 20_000 });
    expect(() => parseGameLaunchInput({
      action: "status",
      runtimeId: "rt-00000000-0000-4000-8000-000000000001",
      world: "Worlds/Unexpected.ent",
    }, 60_000)).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() => parseGameLaunchInput({ action: "stop", runtimeId: "rt-not-exact" }, 60_000))
      .toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() => parseGameLaunchInput({ gprojPath: "   " }, 60_000))
      .toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() => parseGameLaunchInput({ world: "x".repeat(32_769) }, 60_000))
      .toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() => parseGameLaunchInput({ arguments: [""] }, 60_000))
      .toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(parseGameLaunchInput({
      action: "status",
      runtimeId: "rt-00000000-0000-4000-8000-000000000001",
    }, 0)).toMatchObject({ action: "status" });
    expect(() => parseGameLaunchInput({
      action: "status",
      runtimeId: "rt-00000000-0000-4000-8000-000000000001",
      afterRuntimeId: "rt-00000000-0000-4000-8000-000000000002",
    }, 60_000)).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  it("publishes titled, described input metadata and an action-discriminated output contract", () => {
    const harness = makeHarness();
    const call = register(testApplication(harness.root), harness.manager);

    expect(call.definition).toMatchObject({
      title: "Launch or manage an exact-owned game runtime",
      inputSchema: gameLaunchRawInputShape,
      outputSchema: gameLaunchOutputSchema,
    });
    for (const [property, schema] of Object.entries(gameLaunchRawInputShape)) {
      expect(schema.description, `${property} description`).toEqual(expect.any(String));
      expect(schema.description?.trim().length, `${property} description length`).toBeGreaterThan(0);
    }
    expect(gameLaunchRawInputShape.runtimeKind.description).toContain(
      "Legacy client means a standalone graphical -world launch",
    );
    expect(call.definition.description).toContain(
      "client means standalone -world and never the engine's -client replication mode",
    );
  });

  it("derives frozen attempt-scoped prepare, record, and start keys", () => {
    const identity = {
      delivery: "owned" as const,
      compositeAttemptId: "ga-00000000-0000-4000-8000-000000000001",
      canonicalFingerprint: "a".repeat(64),
    };
    const canonical = canonicalOwnedGameLaunchAttemptIdentity("start", identity);
    expect(canonical).toBe(
      '["reforger-forge-owned-game-launch-attempt",1,"start","owned","ga-00000000-0000-4000-8000-000000000001","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]',
    );
    expect(deriveOwnedGameLaunchAttemptKey("start", identity)).toBe(
      `mcp-game-launch-attempt-start-v1-${createHash("sha256").update(canonical).digest("hex")}`,
    );
    expect(new Set(["prepare", "record", "start"].map((action) =>
      deriveOwnedGameLaunchAttemptKey(action as "prepare" | "record" | "start", identity))).size).toBe(3);
  });

  it("uses a fixed prepare-key identity and excludes readiness waiting", () => {
    const identity: GameLaunchPrepareIdentity = {
      version: 1,
      delivery: "owned",
      projectComparisonKey: "c:\\projects\\target\\target.gproj",
      worldResourceReference: `{${WORLD_GUID}}Worlds/LaunchFixture.ent`,
      worldEvidenceSchemaVersion: 1,
      worldEvidenceDigest: "1".repeat(64),
      addonEvidenceSchemaVersion: 1,
      addonEvidenceDigest: "2".repeat(64),
      runtimeKind: "listenServer",
      executablePath: "C:\\Game\\ArmaReforgerSteamDiag.exe",
      executableEvidenceSchemaVersion: 1,
      executableEvidenceDigest: "3".repeat(64),
      arguments: ["-server", `{${WORLD_GUID}}Worlds/LaunchFixture.ent`],
      profilePath: "C:\\private\\profiles\\derived-v1\\abc",
      sessionTtlMs: 60_000,
      forceUpdate: true,
      noFocus: true,
      forceNonNativeWindowSize: null,
    };
    const canonical = canonicalGameLaunchPrepareIdentity(identity);
    expect(canonical).not.toContain("waitForInstanceMs");
    expect(computeGameLaunchPrepareKey(identity)).toBe(
      `mcp-game-launch-prepare-v1-${createHash("sha256").update(canonical).digest("hex")}`,
    );
    expect(computeGameLaunchPrepareKey(identity)).toBe(
      "mcp-game-launch-prepare-v1-b8f86729e274ee53135c7ccb0cfc8562261bc42464d7fff335b282f93a6b3020",
    );
    const immediate = parseGameLaunchInput({
      gprojPath: "C:\\projects\\Target\\Target.gproj",
      waitForInstanceMs: 0,
    }, 60_000) as GameLaunchStartInput;
    const waited = parseGameLaunchInput({
      gprojPath: "C:\\projects\\Target\\Target.gproj",
      waitForInstanceMs: 60_000,
    }, 60_000) as GameLaunchStartInput;
    expect(computeGameLaunchPlanningKey(immediate)).toBe(computeGameLaunchPlanningKey(waited));
    expect(computeGameLaunchPlanningKey({ ...waited, arguments: ["-different"] }))
      .not.toBe(computeGameLaunchPlanningKey(waited));
  });

  it("requires an absolute explicit project path and safely adapts an unusable active hint", async () => {
    const harness = makeHarness();
    const application = testApplication(harness.root);
    const start = parseGameLaunchInput({ gprojPath: "relative/Target.gproj" }, 60_000);
    await expect(planCanonicalGameLaunch(application, start as never, {
      manager: harness.manager,
      defaultSessionTtlMs: 60_000,
    })).rejects.toMatchObject({ code: "PROJECT_INVALID" });

    const hinted = parseGameLaunchInput({}, 60_000);
    await expect(planCanonicalGameLaunch(application, hinted as never, {
      manager: harness.manager,
      workbenchClient: { activeProjectGprojPath: vi.fn(async () => { throw new Error("unsafe private hint"); }) },
      defaultSessionTtlMs: 60_000,
    })).rejects.toMatchObject({
      code: "PROJECT_REQUIRED",
      message: expect.not.stringContaining("unsafe private hint"),
    });
  });

  it("plans the active Workbench project hint and emits the accepted client/listen vectors", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      const application = testApplication(harness.root);
      for (const runtimeKind of ["client", "listenServer"] as const) {
        const input = parseGameLaunchInput({ runtimeKind, waitForInstanceMs: runtimeKind === "client" ? 0 : 10 }, 60_000);
        const plan = await planCanonicalGameLaunch(application, input as never, {
          manager: harness.manager,
          workbenchClient: { activeProjectGprojPath: vi.fn(async () => fixture.projectPath) },
          defaultSessionTtlMs: 60_000,
        });
        expect(plan.projectSelection).toBe("active_workbench_hint");
        expect(plan.arguments).toContain(runtimeKind === "client" ? "-world" : "-server");
        expect(plan.arguments).toContain(plan.world.resourceReference);
        expect(plan.arguments).toContain("-addonsDir");
        expect(plan.arguments).toContain("-addons");
      }
    }, { prefix: "rfo-game-launch-hint-" });
  });

  it("prepares, starts, returns an opaque capture target, and recovers an equal retry with one spawn", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      const application = testApplication(harness.root);
      const primitiveRecorder = vi.spyOn(harness.manager, "recordPreparedLaunch");
      const call = register(application, harness.manager);
      const input = {
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 100,
      };
      const first = await call(input);
      const second = await call(input);

      expect(first.isError, first.content[0]?.text).not.toBe(true);
      expect(second.isError, second.content[0]?.text).not.toBe(true);
      const firstPayload = payload(first);
      const secondPayload = payload(second);
      expect(JSON.parse(first.content[0]?.text ?? "null")).toEqual(first.structuredContent);
      expect(gameLaunchOutputSchema.safeParse(first.structuredContent).success).toBe(true);
      expect(firstPayload.runtime).toMatchObject({ state: "running", exactOwned: true });
      expect(secondPayload.runtime).toMatchObject({ runtimeId: (firstPayload.runtime as Record<string, unknown>).runtimeId });
      expect(firstPayload.next).toMatchObject({
        capture: { ready: true, tool: "observer_capture", input: { target: "ct1.opaque-runtime-target" } },
      });
      expect(first.content[0]?.text).not.toContain("reforgerForgeOwnerToken");
      expect(harness.spawnCalls).toHaveLength(1);
      expect(application.prepareLaunch).toHaveBeenCalledOnce();
      expect(primitiveRecorder).not.toHaveBeenCalled();
      expect(application.instances).toHaveBeenCalledTimes(2);
      expect(application.prepareLaunch).toHaveBeenCalledWith(expect.objectContaining({
        runtimeKind: "listenServer",
        transportPreference: ["rest", "mailbox"],
      }));
    }, { prefix: "rfo-game-launch-start-" });
  }, process.platform === "win32" ? 15_000 : 5_000);

  it("coalesces more than the admission limit of equal starts before planning", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const prepareLaunch = vi.fn(async (input: Record<string, unknown>) => {
        await held;
        return preparedResponse(input);
      });
      const application = testApplication(harness.root, { prepareLaunch } as Partial<ObserverApplication>);
      const call = register(application, harness.manager);
      const input = { gprojPath: fixture.projectPath, world: fixture.worldPath, waitForInstanceMs: 0 };
      const starts = Array.from({ length: 40 }, () => call(input));
      await vi.waitFor(
        () => expect(prepareLaunch).toHaveBeenCalledOnce(),
        { timeout: 10_000 },
      );
      expect(harness.resolvedRuntimeKinds).toEqual(["listenServer"]);
      release();
      const results = await Promise.all(starts);

      expect(results.every((result) => result.isError !== true)).toBe(true);
      expect(prepareLaunch).toHaveBeenCalledOnce();
      expect(harness.spawnCalls).toHaveLength(1);
      expect(application.instances).toHaveBeenCalledTimes(40);
    }, { prefix: "rfo-game-launch-concurrent-" });
  });

  it("admits at most 32 unique starts before planning while timers remain responsive", async () => {
    await withTemporaryDirectory(async () => {
      const harness = makeHarness();
      let activeHintReads = 0;
      const activeProjectGprojPathHint = vi.fn((options: {
        signal: AbortSignal;
        deadlineAtMs: number;
      }) => new Promise<string>((_resolve, reject) => {
        activeHintReads += 1;
        const onAbort = (): void => {
          // Model a cancellable physical reader that joins its close before
          // rejecting the trusted hint operation.
          queueMicrotask(() => {
            activeHintReads -= 1;
            reject(Object.assign(new Error("fixture hint reader cancelled"), { code: "ABORTED" }));
          });
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        if (options.signal.aborted) onAbort();
      }));
      const application = testApplication(harness.root);
      const call = register(application, harness.manager, [], {
        workbenchClient: { activeProjectGprojPathHint },
      });
      const controllers = Array.from({ length: 32 }, () => new AbortController());
      const starts = controllers.map((controller, index) => call({
        arguments: [`-admission-fixture=${index}`],
        waitForInstanceMs: 0,
      }, controller.signal));
      await vi.waitFor(() => expect(activeProjectGprojPathHint).toHaveBeenCalledTimes(32));

      let timerFired = false;
      const timer = new Promise<void>((resolve) => setTimeout(() => {
        timerFired = true;
        resolve();
      }, 0));
      const overflow = await call({
        arguments: ["-admission-fixture=overflow"],
        waitForInstanceMs: 0,
      });
      await timer;

      expect(timerFired).toBe(true);
      expect(overflow.isError).toBe(true);
      expect(overflow.content[0]?.text).toContain("STORE_CAPACITY_EXCEEDED");
      expect(activeProjectGprojPathHint).toHaveBeenCalledTimes(32);
      expect(harness.resolvedRuntimeKinds).toEqual([]);

      for (const controller of controllers) controller.abort();
      const cancelled = await Promise.all(starts);
      expect(cancelled.every((result) => result.isError === true)).toBe(true);
      expect(cancelled.every((result) => result.content[0]?.text?.includes("CANCELLED"))).toBe(true);
      expect(activeHintReads).toBe(0);
      expect(application.prepareLaunch).not.toHaveBeenCalled();
      expect(harness.spawnCalls).toHaveLength(0);
    }, { prefix: "rfo-game-launch-admission-" });
  });

  it("joins a never-settling active-project hint when the final subscriber cancels", async () => {
    await withTemporaryDirectory(async () => {
      const harness = makeHarness();
      let hintEntered!: () => void;
      let readerClosed!: () => void;
      const entered = new Promise<void>((resolve) => { hintEntered = resolve; });
      const close = new Promise<void>((resolve) => { readerClosed = resolve; });
      let physicalReaderActive = false;
      const activeProjectGprojPathHint = vi.fn((options: {
        signal: AbortSignal;
        deadlineAtMs: number;
      }) => new Promise<string>((_resolve, reject) => {
        physicalReaderActive = true;
        hintEntered();
        options.signal.addEventListener("abort", () => {
          void close.then(() => {
            physicalReaderActive = false;
            reject(Object.assign(new Error("fixture late reader close"), { code: "ABORTED" }));
          });
        }, { once: true });
      }));
      const application = testApplication(harness.root);
      const call = register(application, harness.manager, [], {
        workbenchClient: { activeProjectGprojPathHint },
      });
      const cancellation = new AbortController();
      let settled = false;
      const start = call({ waitForInstanceMs: 0 }, cancellation.signal)
        .then((result) => {
          settled = true;
          return result;
        });
      await entered;

      cancellation.abort();
      let timerObserved = false;
      await new Promise<void>((resolve) => setTimeout(() => {
        timerObserved = true;
        resolve();
      }, 0));
      expect(timerObserved).toBe(true);
      expect(settled).toBe(false);
      expect(physicalReaderActive).toBe(true);

      let retrySettled = false;
      const equalRetry = call({ waitForInstanceMs: 0 }).then((result) => {
        retrySettled = true;
        return result;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(retrySettled).toBe(false);
      expect(activeProjectGprojPathHint).toHaveBeenCalledOnce();

      readerClosed();
      const result = await start;
      const retryResult = await equalRetry;
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("CANCELLED");
      expect(retryResult.isError).toBe(true);
      expect(retryResult.content[0]?.text).toContain("CANCELLED");
      expect(physicalReaderActive).toBe(false);
      expect(harness.resolvedRuntimeKinds).toEqual([]);
      expect(harness.spawnCalls).toEqual([]);
    }, { prefix: "rfo-game-launch-hint-cancel-" });
  });

  it("bounds the trusted active-project hint by the shared absolute deadline", async () => {
    await withTemporaryDirectory(async () => {
      const harness = makeHarness();
      const observedDeadlines: number[] = [];
      const activeProjectGprojPathHint = vi.fn((options: {
        signal: AbortSignal;
        deadlineAtMs: number;
      }) => new Promise<string>((_resolve, reject) => {
        observedDeadlines.push(options.deadlineAtMs);
        const timer = setTimeout(() => {
          reject(Object.assign(new Error("fixture hint deadline"), {
            code: "DEADLINE_EXCEEDED",
          }));
        }, Math.max(0, options.deadlineAtMs - Date.now()));
        timer.unref?.();
      }));
      const application = testApplication(harness.root);
      const call = register(application, harness.manager, [], {
        workbenchClient: { activeProjectGprojPathHint },
        planningDeadlineMs: 50,
      });
      const startedAt = Date.now();
      const start = call({ waitForInstanceMs: 0 });

      let timerObserved = false;
      await new Promise<void>((resolve) => setTimeout(() => {
        timerObserved = true;
        resolve();
      }, 0));
      const result = await start;

      expect(timerObserved).toBe(true);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("PLANNING_TIMEOUT");
      expect(observedDeadlines).toHaveLength(1);
      expect(observedDeadlines[0]).toBeGreaterThanOrEqual(startedAt + 40);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(harness.resolvedRuntimeKinds).toEqual([]);
      expect(harness.spawnCalls).toEqual([]);
    }, { prefix: "rfo-game-launch-hint-deadline-" });
  });

  it("rechecks cancellation after the isolated planner joins physical worker exit", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      const application = testApplication(harness.root);
      const parsed = parseGameLaunchInput({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 0,
      }, 60_000) as GameLaunchStartInput;
      const plan = await planCanonicalGameLaunch(application, parsed, {
        manager: harness.manager,
        defaultSessionTtlMs: 60_000,
      });
      let markEntered!: () => void;
      let releaseExitJoin!: () => void;
      const entered = new Promise<void>((resolve) => { markEntered = resolve; });
      const exitJoined = new Promise<void>((resolve) => { releaseExitJoin = resolve; });
      const isolatedPlanner: NonNullable<RegisterGameLaunchOptions["isolatedPlanner"]> =
        async (_request, signal) => {
          markEntered();
          await exitJoined;
          expect(signal.aborted).toBe(true);
          return plan;
        };
      const call = register(application, harness.manager, [], { isolatedPlanner });
      const cancellation = new AbortController();
      let settled = false;
      const pending = call({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 0,
      }, cancellation.signal).then((result) => {
        settled = true;
        return result;
      });
      await entered;

      cancellation.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(application.prepareLaunch).not.toHaveBeenCalled();

      releaseExitJoin();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("CANCELLED");
      expect(application.prepareLaunch).not.toHaveBeenCalled();
      expect(harness.spawnCalls).toEqual([]);
    }, { prefix: "rfo-game-launch-plan-exit-cancel-" });
  });

  it("rechecks the absolute deadline after the isolated planner joins physical worker exit", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      const application = testApplication(harness.root);
      const parsed = parseGameLaunchInput({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 0,
      }, 60_000) as GameLaunchStartInput;
      const plan = await planCanonicalGameLaunch(application, parsed, {
        manager: harness.manager,
        defaultSessionTtlMs: 60_000,
      });
      let markEntered!: () => void;
      let releaseExitJoin!: () => void;
      const entered = new Promise<void>((resolve) => { markEntered = resolve; });
      const exitJoined = new Promise<void>((resolve) => { releaseExitJoin = resolve; });
      const isolatedPlanner: NonNullable<RegisterGameLaunchOptions["isolatedPlanner"]> =
        async () => {
          markEntered();
          await exitJoined;
          return plan;
        };

      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-08-06T12:00:00.000Z"));
        const call = register(application, harness.manager, [], {
          isolatedPlanner,
          planningDeadlineMs: 50,
        });
        const pending = call({
          gprojPath: fixture.projectPath,
          world: fixture.worldPath,
          waitForInstanceMs: 0,
        });
        await entered;

        vi.setSystemTime(new Date("2026-08-06T12:00:00.051Z"));
        releaseExitJoin();
        const result = await pending;

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("PLANNING_TIMEOUT");
        expect(application.prepareLaunch).not.toHaveBeenCalled();
        expect(harness.spawnCalls).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    }, { prefix: "rfo-game-launch-plan-exit-deadline-" });
  });

  it("cancels one planning subscriber without cancelling an equal retained start", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      let releaseHint!: (path: string) => void;
      const heldHint = new Promise<string>((resolve) => { releaseHint = resolve; });
      const activeProjectGprojPathHint = vi.fn(async () => heldHint);
      const application = testApplication(harness.root);
      const planningSource = vi.spyOn(harness.manager, "resolveRuntimeExecutablePlanningSource");
      const call = register(application, harness.manager, [], {
        workbenchClient: { activeProjectGprojPathHint },
      });
      const firstController = new AbortController();
      const input = { world: fixture.worldPath, waitForInstanceMs: 0 };
      const first = call(input, firstController.signal);
      const second = call(input);
      await vi.waitFor(() => expect(activeProjectGprojPathHint).toHaveBeenCalledOnce());

      firstController.abort();
      const firstResult = await first;
      releaseHint(fixture.projectPath);
      const secondResult = await second;

      expect(firstResult.isError).toBe(true);
      expect(firstResult.content[0]?.text).toContain("CANCELLED");
      expect(secondResult.isError).not.toBe(true);
      expect(planningSource).toHaveBeenCalledTimes(2);
      expect(application.prepareLaunch).toHaveBeenCalledOnce();
      expect(harness.spawnCalls).toHaveLength(1);
    }, { prefix: "rfo-game-launch-subscriber-cancel-" });
  });

  it("rejects cancellation before planning without touching executable evidence", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      const application = testApplication(harness.root);
      const controller = new AbortController();
      controller.abort();

      const result = await register(application, harness.manager)({
        gprojPath: fixture.projectPath,
        waitForInstanceMs: 0,
      }, controller.signal);

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("CANCELLED");
      expect(harness.resolvedRuntimeKinds).toEqual([]);
      expect(application.prepareLaunch).not.toHaveBeenCalled();
      expect(harness.spawnCalls).toHaveLength(0);
    }, { prefix: "rfo-game-launch-pre-cancel-" });
  });

  it("keeps the MCP event loop responsive while isolated planning is active", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      const application = testApplication(harness.root);
      const pending = register(application, harness.manager)({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 0,
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(application.prepareLaunch).not.toHaveBeenCalled();

      const result = await pending;
      expect(result.isError).not.toBe(true);
      expect(harness.spawnCalls).toHaveLength(1);
    }, { prefix: "rfo-game-launch-latency-" });
  });

  it("fails closed when isolated point-of-use revalidation reaches its start deadline", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      let entered!: () => void;
      const revalidationEntered = new Promise<void>((resolve) => { entered = resolve; });
      const harness = makeHarness({
        pointOfUseRevalidator: async () => {
          entered();
          throw gameLaunchRevalidationDeadlineError();
        },
      });
      const revokeSession = vi.fn(async () => ({ revoked: true }));
      const application = testApplication(harness.root, { revokeSession } as Partial<ObserverApplication>);
      const pending = register(application, harness.manager)({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 0,
      });

      await revalidationEntered;
      let timerObserved = false;
      await new Promise<void>((resolve) => setTimeout(() => {
        timerObserved = true;
        resolve();
      }, 0));
      expect(timerObserved).toBe(true);

      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("PLANNING_TIMEOUT");
      expect(revokeSession).toHaveBeenCalledOnce();
      expect(harness.spawnCalls).toHaveLength(0);
      expect(listRecordIds(harness.manager, "prepared-invalidations")).toHaveLength(1);
    }, { prefix: "rfo-game-launch-point-use-deadline-" });
  });

  it("passes the original planning deadline and executable cap to both revalidation phases", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const observed: Array<{
        phase: string;
        deadlineAtMs: number;
        executableMaximumBytes: number;
      }> = [];
      const harness = makeHarness({
        pointOfUseRevalidator: async (request) => {
          if (request.phase === "baseline_executable") {
            throw new Error("Game-launch fixture unexpectedly requested baseline evidence");
          }
          observed.push({
            phase: request.phase,
            deadlineAtMs: request.deadlineAtMs,
            executableMaximumBytes: request.executableMaximumBytes,
          });
          return request.expectedExecutable;
        },
      });
      const application = testApplication(harness.root);
      const planningDeadlineMs = 5_000;
      const executableMaximumBytes = 123_456;
      const baseMs = Date.now();
      let nowCall = 0;
      const now = vi.spyOn(Date, "now").mockImplementation(() => baseMs + nowCall++);
      try {
        const result = await register(application, harness.manager, [], {
          planningDeadlineMs,
          executableMaximumBytes,
        })({
          gprojPath: fixture.projectPath,
          world: fixture.worldPath,
          waitForInstanceMs: 0,
        });
        expect(result.isError, result.content[0]?.text).not.toBe(true);
      } finally {
        now.mockRestore();
      }

      expect(observed.map(({ phase }) => phase)).toEqual([
        "pre_spawn",
        "post_spawn_executable",
      ]);
      expect(observed.every(({ deadlineAtMs }) =>
        deadlineAtMs === baseMs + planningDeadlineMs)).toBe(true);
      expect(observed.every(({ executableMaximumBytes: cap }) =>
        cap === executableMaximumBytes)).toBe(true);
    }, { prefix: "rfo-game-launch-shared-revalidation-budget-" });
  });

  it.each(["resolve", "reject"] as const)(
    "drains lease-aborted pre-spawn revalidation before reporting lease loss when it would %s",
    async (boundaryOutcome) => {
      await withTemporaryDirectory(async (root) => {
        const fixture = createProjectFixture(root);
        const backend = createLeaseLosingBackend();
        const withMachineMutex = backend.withMachineMutex.bind(backend);
        let leaseWasLost = false;
        let mutexAcquisitionsAfterLeaseLoss = 0;
        backend.withMachineMutex = async (args) => {
          if (leaseWasLost) mutexAcquisitionsAfterLeaseLoss += 1;
          return withMachineMutex(args);
        };
        let entered!: () => void;
        let releaseCleanup!: () => void;
        const revalidationEntered = new Promise<void>((resolve) => { entered = resolve; });
        const cleanupComplete = new Promise<void>((resolve) => { releaseCleanup = resolve; });
        let abortObserved = false;
        const harness = makeHarness({
          backend,
          pointOfUseRevalidator: async (request, signal) => {
            if (request.phase !== "pre_spawn") {
              throw new Error(`Unexpected fixture revalidation phase: ${request.phase}`);
            }
            entered();
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(
                () => reject(gameLaunchRevalidationDeadlineError()),
                Math.max(0, request.deadlineAtMs - Date.now()),
              );
              timer.unref?.();
              const onAbort = (): void => {
                abortObserved = true;
                clearTimeout(timer);
                signal.removeEventListener("abort", onAbort);
                void cleanupComplete.then(() => {
                  if (boundaryOutcome === "resolve") resolve();
                  else reject(gameLaunchRevalidationDeadlineError());
                });
              };
              signal.addEventListener("abort", onAbort, { once: true });
              if (signal.aborted) onAbort();
            });
            return request.expectedExecutable;
          },
        });
        const application = testApplication(harness.root);
        const pending = register(application, harness.manager, [], {
          planningDeadlineMs: 5_000,
        })({
          gprojPath: fixture.projectPath,
          world: fixture.worldPath,
          waitForInstanceMs: 0,
        });

        await revalidationEntered;
        let settled = false;
        void pending.then(
          () => { settled = true; },
          () => { settled = true; },
        );
        leaseWasLost = true;
        backend.loseLease();
        expect(abortObserved).toBe(true);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(settled).toBe(false);
        expect(harness.spawnCalls).toEqual([]);
        expect(listRecordIds(harness.manager, "prepared-invalidations")).toEqual([]);
        expect(listRecordIds(harness.manager, "consumed")).toEqual([]);

        releaseCleanup();
        const result = await pending;
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("RECOVERY_REQUIRED");
        expect(harness.spawnCalls).toEqual([]);
        expect(listRecordIds(harness.manager, "prepared-invalidations")).toEqual([]);
        expect(listRecordIds(harness.manager, "consumed")).toEqual([]);
        expect(listRecordIds(harness.manager, "pending-starts")).toEqual([]);
        expect(listRecordIds(harness.manager, "runtimes")).toEqual([]);
        expect(mutexAcquisitionsAfterLeaseLoss).toBe(0);
      }, { prefix: `rfo-game-launch-lease-drain-${boundaryOutcome}-` });
    },
  );

  it("does not let request cancellation hide a child spawned before post-spawn revalidation", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      let entered!: () => void;
      let release!: () => void;
      const postSpawnEntered = new Promise<void>((resolve) => { entered = resolve; });
      const postSpawnRelease = new Promise<void>((resolve) => { release = resolve; });
      const harness = makeHarness({
        pointOfUseRevalidator: async (request, signal) => {
          if (request.phase === "baseline_executable") {
            throw new Error("Game-launch fixture unexpectedly requested baseline evidence");
          }
          if (request.phase === "post_spawn_executable") {
            entered();
            await waitForInjectedRevalidation(
              postSpawnRelease,
              request.deadlineAtMs,
              signal,
            );
          }
          return request.expectedExecutable;
        },
      });
      const application = testApplication(harness.root);
      const controller = new AbortController();
      const pending = register(application, harness.manager)({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 0,
      }, controller.signal);

      await postSpawnEntered;
      expect(harness.spawnCalls).toHaveLength(1);
      controller.abort();
      release();

      const result = await pending;
      expect(result.isError).not.toBe(true);
      expect(payload(result).runtime).toMatchObject({ state: "running", exactOwned: true });
      expect(harness.spawnCalls).toHaveLength(1);
    }, { prefix: "rfo-game-launch-post-spawn-cancel-" });
  });

  it("terminates isolated planning at its absolute deadline", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      const application = testApplication(harness.root);
      const result = await register(application, harness.manager, [], {
        planningDeadlineMs: 1,
      })({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 0,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("PLANNING_TIMEOUT");
      expect(application.prepareLaunch).not.toHaveBeenCalled();
      expect(harness.spawnCalls).toHaveLength(0);
    }, { prefix: "rfo-game-launch-deadline-" });
  });

  it("refuses an executable above the planning byte budget before preparation", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      const application = testApplication(harness.root);
      const result = await register(application, harness.manager, [], {
        executableMaximumBytes: 1,
      })({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 0,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("EXECUTABLE_OVERSIZE");
      expect(application.prepareLaunch).not.toHaveBeenCalled();
      expect(harness.spawnCalls).toHaveLength(0);
    }, { prefix: "rfo-game-launch-executable-budget-" });
  });

  it("reports readiness timeout as partial success with exact stop authority", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      const application = testApplication(harness.root, {
        instances: vi.fn(async () => ({
          instances: [], compatibleCount: 0, waitedMs: 60_000, timedOut: true,
        })),
      } as Partial<ObserverApplication>);
      const result = await register(application, harness.manager)({
        gprojPath: fixture.projectPath,
        waitForInstanceMs: 60_000,
      });

      expect(result.isError).not.toBe(true);
      const value = payload(result);
      expect(value.readinessWarning).toBe(GAME_LAUNCH_READINESS_WARNING.timedOut);
      expect(value).not.toHaveProperty("readinessError");
      expect(value.runtime).toMatchObject({ state: "running", exactOwned: true });
      expect(value.next).toMatchObject({
        stop: { tool: "game_launch", input: { runtimeId: expect.stringMatching(/^rt-/) } },
        capture: { ready: false, firstCall: { tool: "observer_instances" } },
      });
      expect(harness.spawnCalls).toHaveLength(1);
    }, { prefix: "rfo-game-launch-readiness-" });
  });

  it("preserves a live runtime when cancellation arrives only during its readiness wait", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      const controller = new AbortController();
      const instances = vi.fn(async (input: { signal?: AbortSignal }) => {
        controller.abort();
        expect(input.signal?.aborted).toBe(true);
        throw new ObserverApplicationError("CANCELLED", "fixture readiness wait cancelled");
      });
      const application = testApplication(harness.root, { instances } as Partial<ObserverApplication>);
      const result = await register(application, harness.manager)({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 60_000,
      }, controller.signal);

      expect(result.isError).not.toBe(true);
      const value = payload(result);
      expect(value.runtime).toMatchObject({ state: "running", exactOwned: true });
      expect(value.readinessWarning).toBe(GAME_LAUNCH_READINESS_WARNING.failed);
      expect(value.readinessError).toEqual(expect.stringContaining("CANCELLED"));
      expect(String(value.readinessError).length).toBeLessThanOrEqual(
        PUBLIC_OBSERVER_ERROR_TEXT_MAXIMUM,
      );
      expect(value.next).toMatchObject({
        stop: { tool: "game_launch", input: { runtimeId: expect.stringMatching(/^rt-/) } },
      });
      expect(harness.spawnCalls).toHaveLength(1);
    }, { prefix: "rfo-game-launch-readiness-cancel-" });
  });

  it("keeps the readiness projector remedy aligned with structured inventory guidance", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      const application = testApplication(harness.root, {
        instances: vi.fn(async () => {
          throw new ObserverApplicationError(
            "NO_RENDER_ENDPOINT",
            "fixture renderer endpoint is not ready",
          );
        }),
      } as Partial<ObserverApplication>);
      const result = await register(application, harness.manager)({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 60_000,
      });

      expect(result.isError).not.toBe(true);
      const value = payload(result);
      const next = value.next as {
        capture: { firstCall: { tool: string; input: { sessionId: string } } };
      };
      expect(value.readinessWarning).toBe(GAME_LAUNCH_READINESS_WARNING.failed);
      expect(value.readinessError).toEqual(expect.stringContaining("NO_RENDER_ENDPOINT"));
      expect(value.readinessError).toEqual(expect.stringContaining("observer_instances"));
      expect(value.readinessError).toEqual(expect.stringContaining(
        JSON.stringify({ sessionId: next.capture.firstCall.input.sessionId })
      ));
      expect(next.capture.firstCall).toMatchObject({
        tool: "observer_instances",
        input: { sessionId: "session-game-launch" },
      });
      expect(String(value.readinessError).length).toBeLessThanOrEqual(
        PUBLIC_OBSERVER_ERROR_TEXT_MAXIMUM,
      );
      expect(harness.spawnCalls).toHaveLength(1);
    }, { prefix: "rfo-game-launch-readiness-remedy-" });
  });

  it.each([
    ["project", (fixture: ProjectFixture, _unusedHarness: ReturnType<typeof makeHarness>) =>
      writeFileSync(fixture.projectPath, `${readFileSync(fixture.projectPath, "utf8")}Changed "yes"\n`)],
    ["world", (fixture: ProjectFixture, _unusedHarness: ReturnType<typeof makeHarness>) =>
      writeFileSync(fixture.worldPath, "SubScene { Name \"changed\" }\n")],
    ["metadata", (fixture: ProjectFixture, _unusedHarness: ReturnType<typeof makeHarness>) =>
      writeFileSync(fixture.metaPath, `MetaFileClass {\n Name \"{${WORLD_GUID}}Worlds/LaunchFixture.ent\"\n Changed \"yes\"\n}\n`)],
    ["dependency", (fixture: ProjectFixture, _unusedHarness: ReturnType<typeof makeHarness>) =>
      writeFileSync(fixture.dependencyPath!, `GameProject { ID "Dependency" GUID "${DEPENDENCY_GUID}" Dependencies { } Changed "yes" }\n`)],
    ["executable", (_fixture: ProjectFixture, harness: ReturnType<typeof makeHarness>) =>
      writeFileSync(harness.executable, "same-path executable replacement")],
    ["missing executable", (_fixture: ProjectFixture, harness: ReturnType<typeof makeHarness>) =>
      rmSync(harness.executable)],
  ] as const)("invalidates and revokes an unconsumed preparation after a %s change", async (_kind, mutate) => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root, _kind === "dependency");
      const harness = makeHarness();
      const revokeSession = vi.fn(async () => ({ revoked: true }));
      const prepareLaunch = vi.fn(async (input: Record<string, unknown>) => {
        mutate(fixture, harness);
        return preparedResponse(input);
      });
      const application = testApplication(harness.root, {
        prepareLaunch,
        revokeSession,
      } as Partial<ObserverApplication>);
      const result = await register(
        application,
        harness.manager,
        fixture.addonRoot ? [fixture.addonRoot] : [],
      )({ gprojPath: fixture.projectPath, world: fixture.worldPath, waitForInstanceMs: 0 });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(
        /(?:PROJECT_CHANGED|WORLD_CHANGED|ADDON_CHANGED|EXECUTABLE_CHANGED|EXECUTABLE_EVIDENCE_INVALID)/,
      );
      expect(revokeSession).toHaveBeenCalledOnce();
      expect(harness.spawnCalls).toHaveLength(0);
      expect(listRecordIds(harness.manager, "prepared-invalidations")).toHaveLength(1);
    }, { prefix: `rfo-game-launch-invalidate-${_kind}-` });
  });

  it("keeps an invalidated and revoked baseline preparation pinned", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const originalWorld = readFileSync(fixture.worldPath, "utf8");
      const harness = makeHarness({ receiptRetentionMs: 0 });
      const application = testApplication(harness.root);
      const input = parseGameLaunchInput({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 0,
      }, 60_000);
      const plan = await planCanonicalGameLaunch(application, input as never, {
        manager: harness.manager,
        defaultSessionTtlMs: 60_000,
      });
      const prepared = await harness.manager.prepareInitialOwnedGameLaunch({
        launchInput: plan.launchInput,
        evidence: plan.evidence,
        prepare: async () => {
          writeFileSync(fixture.worldPath, "SubScene { Name \"changed\" }\n");
          return managerPreparedResponse(plan, "session-invalidated-pinned");
        },
        revokeSession: vi.fn(),
      });
      const preparedLaunchId = prepared.preparedLaunchId!;
      await expect(harness.manager.start({
        preparedLaunchId,
        idempotencyKey: deriveObserverRuntimeIdempotencyKey({ action: "start", preparedLaunchId }),
      })).rejects.toMatchObject({ code: "PREPARED_LAUNCH_INVALIDATED" });
      writeFileSync(fixture.worldPath, originalWorld);

      const retryPrepare = vi.fn(async () => managerPreparedResponse(plan, "session-must-not-replace"));
      await expect(harness.manager.prepareInitialOwnedGameLaunch({
        launchInput: plan.launchInput,
        evidence: plan.evidence,
        prepare: retryPrepare,
        revokeSession: vi.fn(),
      })).rejects.toMatchObject({ code: "PREPARED_LAUNCH_INVALIDATED" });
      expect(retryPrepare).not.toHaveBeenCalled();
      expect(harness.spawnCalls).toHaveLength(0);
      expect(listRecordIds(harness.manager, "prepared-invalidations")).toEqual([preparedLaunchId]);
      harness.setClock(Date.parse("2026-07-18T13:00:00.000Z"));
      await expect(harness.manager.sweep()).resolves.toMatchObject({
        removedPreparedLaunchIds: [],
      });
      expect(listRecordIds(harness.manager, "prepared-invalidations")).toEqual([preparedLaunchId]);
      expect(listRecordIds(harness.manager, "game-launch-chains")).toHaveLength(1);
    }, { prefix: "rfo-game-launch-invalidated-pinned-" });
  });

  it("revalidates recovered starts from the stored original snapshots", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      const application = testApplication(harness.root);
      const input = parseGameLaunchInput({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 0,
      }, 60_000);
      const originalPlan = await planCanonicalGameLaunch(application, input as never, {
        manager: harness.manager,
        defaultSessionTtlMs: 60_000,
      });
      const originalPrepared = await harness.manager.prepareInitialOwnedGameLaunch({
        launchInput: originalPlan.launchInput,
        evidence: originalPlan.evidence,
        prepare: async () => managerPreparedResponse(originalPlan, "session-stored-snapshots"),
        revokeSession: vi.fn(),
      });
      writeFileSync(fixture.worldPath, "SubScene { Name \"retry-selected\" }\n");
      const currentPlan = await planCanonicalGameLaunch(application, input as never, {
        manager: harness.manager,
        defaultSessionTtlMs: 60_000,
      });
      const retryEvidenceFields = {
        ...currentPlan.evidence,
        prepareKey: originalPlan.prepareKey,
      };
      const retryEvidence = {
        ...retryEvidenceFields,
        gameLaunchEvidenceDigest: computeOwnedGameLaunchEvidenceDigest(retryEvidenceFields),
      };
      const retryPrepare = vi.fn(async () => managerPreparedResponse(currentPlan, "session-retry-snapshot"));
      const recovered = await harness.manager.prepareInitialOwnedGameLaunch({
        launchInput: {
          ...currentPlan.launchInput,
          idempotencyKey: originalPlan.prepareKey,
        },
        evidence: retryEvidence,
        prepare: retryPrepare,
        revokeSession: vi.fn(),
      });
      expect(recovered.preparedLaunchId).toBe(originalPrepared.preparedLaunchId);
      expect(retryPrepare).not.toHaveBeenCalled();

      const preparedLaunchId = recovered.preparedLaunchId!;
      await expect(harness.manager.start({
        preparedLaunchId,
        idempotencyKey: deriveObserverRuntimeIdempotencyKey({ action: "start", preparedLaunchId }),
      })).rejects.toMatchObject({ code: "PREPARED_LAUNCH_INVALIDATED" });
      expect(harness.spawnCalls).toHaveLength(0);
    }, { prefix: "rfo-game-launch-stored-snapshots-" });
  });

  it("returns recovery guidance when invalidation is durable but revocation is uncertain", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      const revokeSession = vi.fn(async () => { throw new Error("fixture revoke unavailable"); });
      const application = testApplication(harness.root, {
        prepareLaunch: vi.fn(async (input: Record<string, unknown>) => {
          writeFileSync(fixture.worldPath, "SubScene { Name \"changed\" }\n");
          return preparedResponse(input, "session-uncertain-revoke");
        }),
        revokeSession,
      } as Partial<ObserverApplication>);
      const result = await register(application, harness.manager)({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 0,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("RECOVERY_REQUIRED");
      expect(result.content[0]?.text).not.toContain("fixture revoke unavailable");
      expect(revokeSession).toHaveBeenCalledOnce();
      expect(listRecordIds(harness.manager, "prepared-invalidations")).toHaveLength(1);
      expect(harness.spawnCalls).toHaveLength(0);
    }, { prefix: "rfo-game-launch-revoke-uncertain-" });
  });

  it("recovers exact retries and admits one fenced successor only after exact stop", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      let preparedGeneration = 0;
      const prepareLaunch = vi.fn(async (preparedInput: Record<string, unknown>) =>
        preparedResponse(preparedInput, `session-game-launch-${++preparedGeneration}`));
      const application = testApplication(harness.root, { prepareLaunch } as Partial<ObserverApplication>);
      const call = register(application, harness.manager);
      const input = { gprojPath: fixture.projectPath, world: fixture.worldPath, waitForInstanceMs: 0 };
      const first = payload(await call(input));
      const runtimeId = String((first.runtime as Record<string, unknown>).runtimeId);

      const premature = await call({ ...input, afterRuntimeId: runtimeId });
      expect(premature.isError).toBe(true);
      expect(premature.content[0]?.text).toContain("GAME_LAUNCH_PREDECESSOR_NOT_STOPPED");

      const stopped = await call({ action: "stop", runtimeId, waitForRestorationMs: 0 });
      expect(stopped.isError).not.toBe(true);
      expect(payload(stopped)).toMatchObject({
        runtime: {
          chain: {
            state: "terminal",
            successor: { eligible: true, afterRuntimeId: runtimeId },
          },
        },
        next: { successor: { input: { action: "start", afterRuntimeId: runtimeId } } },
      });

      const retry = await call(input);
      expect(retry.isError).not.toBe(true);
      expect(payload(retry)).toMatchObject({ runtime: { runtimeId }, compositeAttemptId: first.compositeAttemptId });

      const successor = payload(await call({ ...input, afterRuntimeId: runtimeId }));
      const successorRuntimeId = String((successor.runtime as Record<string, unknown>).runtimeId);
      expect(successorRuntimeId).not.toBe(runtimeId);
      expect(successor.compositeAttemptId).not.toBe(first.compositeAttemptId);
      expect(successor).toMatchObject({
        chain: {
          generation: 2,
          predecessorRuntimeId: runtimeId,
          retry: { afterRuntimeId: runtimeId },
        },
      });

      const successorRetry = payload(await call({ ...input, afterRuntimeId: runtimeId }));
      expect(successorRetry).toMatchObject({
        compositeAttemptId: successor.compositeAttemptId,
        runtime: { runtimeId: successorRuntimeId },
      });
      const changedRetry = await call({
        ...input,
        afterRuntimeId: runtimeId,
        arguments: ["-different-successor"],
      });
      expect(changedRetry.isError).toBe(true);
      expect(changedRetry.content[0]?.text).toContain("ARGUMENT_CONFLICT");
      expect(prepareLaunch).toHaveBeenCalledTimes(2);
      expect(harness.spawnCalls).toHaveLength(2);
    }, { prefix: "rfo-game-launch-terminal-" });
  });

  it("replaces a proven-aborted successor without losing its terminal predecessor proof", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness({ receiptRetentionMs: 0 });
      let preparedGeneration = 0;
      const attemptKeys: string[] = [];
      const prepareLaunch = vi.fn(async (preparedInput: Record<string, unknown>) => {
        attemptKeys.push(String(preparedInput.idempotencyKey));
        return preparedResponse(preparedInput, `session-successor-abort-${++preparedGeneration}`);
      });
      const revokeSession = vi.fn(async () => ({ revoked: true }));
      const application = testApplication(harness.root, {
        prepareLaunch,
        revokeSession,
      } as Partial<ObserverApplication>);
      const call = register(application, harness.manager);
      const input = { gprojPath: fixture.projectPath, world: fixture.worldPath, waitForInstanceMs: 0 };
      const first = payload(await call(input));
      const runtimeId = String((first.runtime as Record<string, unknown>).runtimeId);
      await expect(call({ action: "stop", runtimeId, waitForRestorationMs: 0 }))
        .resolves.not.toMatchObject({ isError: true });

      const writable = harness.manager as unknown as {
        atomicWrite(
          rootPath: string,
          target: string,
          value: unknown,
          exclusive: boolean,
          durable?: boolean,
        ): void;
      };
      const atomicWrite = writable.atomicWrite.bind(harness.manager);
      let failSuccessorDescriptor = true;
      writable.atomicWrite = (rootPath, target, value, exclusive, durable) => {
        if (failSuccessorDescriptor && /[\\/]prepared[\\/]/.test(target)) {
          failSuccessorDescriptor = false;
          throw new Error("fixture successor descriptor publication failed");
        }
        atomicWrite(rootPath, target, value, exclusive, durable);
      };

      const failedSuccessor = await call({ ...input, afterRuntimeId: runtimeId });
      expect(failedSuccessor.isError).toBe(true);
      expect(failedSuccessor.content[0]?.text).toContain("PREPARE_FAILED");
      const [chainId] = listRecordIds(harness.manager, "game-launch-chains");
      expect(readRecord(harness.manager, "game-launch-chains", chainId!).current)
        .toMatchObject({ state: "aborted", generation: 2, predecessorRuntimeId: runtimeId });
      await expect(inspectIdle(harness.manager)).resolves.toMatchObject({
        complete: true,
        blockers: [],
      });

      const predecessorStop = readRecord(harness.manager, "stops", runtimeId);
      expect(removeRecord(harness.manager, "stops", runtimeId)).toBe(true);
      await expect(inspectIdle(harness.manager)).resolves.toMatchObject({
        complete: false,
        blockers: ["INCOMPLETE_PROOF"],
      });
      writeRecord(harness.manager, "stops", runtimeId, JSON.stringify(predecessorStop));
      await expect(inspectIdle(harness.manager)).resolves.toMatchObject({
        complete: true,
        blockers: [],
      });
      const swept = await harness.manager.sweep();
      expect(swept.removedRuntimeIds).not.toContain(runtimeId);

      writable.atomicWrite = atomicWrite;
      const successor = payload(await call({ ...input, afterRuntimeId: runtimeId }));
      expect(successor).toMatchObject({
        chain: { generation: 2, predecessorRuntimeId: runtimeId },
      });
      expect(attemptKeys).toHaveLength(3);
      expect(attemptKeys[2]).not.toBe(attemptKeys[1]);
      expect(revokeSession).toHaveBeenCalledWith("session-successor-abort-2");
      expect(harness.spawnCalls).toHaveLength(2);
    }, { prefix: "rfo-game-launch-successor-abort-" });
  }, 20_000);

  it.each([
    {
      name: "a missing exact stop receipt",
      mutate: (manager: OwnedRuntimeManager, runtimeId: string) => {
        expect(removeRecord(manager, "stops", runtimeId)).toBe(true);
      },
    },
    {
      name: "a missing revoked-session completion",
      mutate: (manager: OwnedRuntimeManager, runtimeId: string) => {
        expect(removeRecord(manager, "stop-completions", runtimeId)).toBe(true);
      },
    },
    {
      name: "a missing linked restoration proof",
      mutate: (manager: OwnedRuntimeManager, runtimeId: string) => {
        expect(removeRecord(manager, "restoration-proofs", runtimeId)).toBe(true);
      },
    },
    {
      name: "a completion that contradicts durable session revocation",
      mutate: (manager: OwnedRuntimeManager, runtimeId: string) => {
        const completion = readRecord(manager, "stop-completions", runtimeId);
        writeRecord(manager, "stop-completions", runtimeId, JSON.stringify({
          ...completion,
          sessionRevoked: false,
        }));
      },
    },
    {
      name: "a restoration proof cross-bound to another session",
      mutate: (manager: OwnedRuntimeManager, runtimeId: string) => {
        const restoration = readRecord(manager, "restoration-proofs", runtimeId);
        writeRecord(manager, "restoration-proofs", runtimeId, JSON.stringify({
          ...restoration,
          sessionId: "session-cross-bound-restoration",
        }));
      },
    },
  ])("refuses successor admission with $name", async ({ mutate }) => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      let preparedGeneration = 0;
      const prepareLaunch = vi.fn(async (preparedInput: Record<string, unknown>) =>
        preparedResponse(preparedInput, `session-terminal-proof-${++preparedGeneration}`));
      const application = testApplication(harness.root, { prepareLaunch } as Partial<ObserverApplication>);
      const call = register(application, harness.manager);
      const input = { gprojPath: fixture.projectPath, world: fixture.worldPath, waitForInstanceMs: 0 };
      const first = payload(await call(input));
      const runtimeId = String((first.runtime as Record<string, unknown>).runtimeId);
      const stopped = await call({ action: "stop", runtimeId, waitForRestorationMs: 0 });
      expect(stopped.isError).not.toBe(true);
      expect(payload(stopped)).toMatchObject({
        runtime: { chain: { state: "terminal", successor: { eligible: true } } },
      });
      mutate(harness.manager, runtimeId);

      const successor = await call({ ...input, afterRuntimeId: runtimeId });

      expect(successor.isError).toBe(true);
      expect(successor.content[0]?.text).toContain("STORAGE_UNVERIFIABLE");
      expect(prepareLaunch).toHaveBeenCalledOnce();
      expect(harness.spawnCalls).toHaveLength(1);
    }, { prefix: "rfo-game-launch-terminal-proof-" });
  });

  it("reserves game preparation and invalidation capacity before private-child IPC", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness({ maxStoreRecords: 11 });
      const application = testApplication(harness.root);
      const result = await register(application, harness.manager)({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 0,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("STORE_CAPACITY_EXCEEDED");
      expect(application.prepareLaunch).not.toHaveBeenCalled();
      expect(harness.spawnCalls).toHaveLength(0);
      expect(listRecordIds(harness.manager, "prepared")).toEqual([]);
      expect(listRecordIds(harness.manager, "prepared-invalidations")).toEqual([]);
    }, { prefix: "rfo-game-launch-capacity-" });
  });

  it("fails closed when a valid-shaped invalidation no longer matches its descriptor", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness({ receiptRetentionMs: 0 });
      const application = testApplication(harness.root);
      const input = parseGameLaunchInput({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 0,
      }, 60_000);
      const plan = await planCanonicalGameLaunch(application, input as never, {
        manager: harness.manager,
        defaultSessionTtlMs: 60_000,
      });
      const prepared = await harness.manager.prepareInitialOwnedGameLaunch({
        launchInput: plan.launchInput,
        evidence: plan.evidence,
        prepare: async () => {
          writeFileSync(fixture.metaPath, `${readFileSync(fixture.metaPath, "utf8")}Changed \"yes\"\n`);
          return managerPreparedResponse(plan, "session-invalidation-corruption");
        },
        revokeSession: vi.fn(),
      });
      const preparedLaunchId = prepared.preparedLaunchId!;
      await expect(harness.manager.start({
        preparedLaunchId,
        idempotencyKey: deriveObserverRuntimeIdempotencyKey({ action: "start", preparedLaunchId }),
      })).rejects.toMatchObject({ code: "PREPARED_LAUNCH_INVALIDATED" });
      const invalidation = readRecord(harness.manager, "prepared-invalidations", preparedLaunchId);
      invalidation.sessionId = "session-other-valid-shape";
      writeRecord(
        harness.manager,
        "prepared-invalidations",
        preparedLaunchId,
        JSON.stringify(invalidation),
      );

      await expect(harness.manager.prepareInitialOwnedGameLaunch({
        launchInput: plan.launchInput,
        evidence: plan.evidence,
        prepare: vi.fn(),
        revokeSession: vi.fn(),
      })).rejects.toMatchObject({ code: "STORAGE_UNVERIFIABLE" });
      harness.setClock(Date.parse("2026-07-18T13:00:00.000Z"));
      await expect(harness.manager.sweep()).resolves.toMatchObject({
        removedPreparedLaunchIds: [],
      });
      expect(listRecordIds(harness.manager, "prepared-invalidations")).toEqual([preparedLaunchId]);
      expect(harness.spawnCalls).toHaveLength(0);
    }, { prefix: "rfo-game-launch-invalidation-corrupt-" });
  });

  it("refuses an equal retained preparation from a replacement MCP lifecycle", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const first = makeHarness();
      const firstApplication = testApplication(first.root);
      const input = parseGameLaunchInput({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 0,
      }, 60_000);
      const firstPlan = await planCanonicalGameLaunch(firstApplication, input as never, {
        manager: first.manager,
        defaultSessionTtlMs: 60_000,
      });
      await first.manager.prepareInitialOwnedGameLaunch({
        launchInput: firstPlan.launchInput,
        evidence: firstPlan.evidence,
        prepare: async () => managerPreparedResponse(firstPlan, "session-before-restart"),
        revokeSession: vi.fn(),
      });
      await first.manager.closeStorageForTest();

      const replacement = makeHarness({ root: first.root, backend: first.backend });
      const replacementPlan = await planCanonicalGameLaunch(
        testApplication(replacement.root),
        input as never,
        { manager: replacement.manager, defaultSessionTtlMs: 60_000 },
      );
      expect(replacementPlan.prepareKey).toBe(firstPlan.prepareKey);
      const replacementPrepare = vi.fn(async () =>
        managerPreparedResponse(replacementPlan, "session-after-restart"));
      await expect(replacement.manager.prepareInitialOwnedGameLaunch({
        launchInput: replacementPlan.launchInput,
        evidence: replacementPlan.evidence,
        prepare: replacementPrepare,
        revokeSession: vi.fn(),
      })).rejects.toMatchObject({ code: "PREPARED_LAUNCH_STALE" });
      expect(replacementPrepare).not.toHaveBeenCalled();
      expect(replacement.spawnCalls).toHaveLength(0);
    }, { prefix: "rfo-game-launch-restart-" });
  });

  it("serializes simultaneous empty-profile preparations across MCP managers", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const backend = createSerialBackend();
      const owner = makeHarness({ backend });
      const contender = makeHarness({ root: owner.root, backend });
      const input = parseGameLaunchInput({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 0,
      }, 60_000);
      const ownerPlan = await planCanonicalGameLaunch(testApplication(owner.root), input as never, {
        manager: owner.manager,
        defaultSessionTtlMs: 60_000,
      });
      const contenderPlan = await planCanonicalGameLaunch(testApplication(contender.root), input as never, {
        manager: contender.manager,
        defaultSessionTtlMs: 60_000,
      });
      expect(contenderPlan.prepareKey).toBe(ownerPlan.prepareKey);
      let releaseOwner!: () => void;
      let markOwnerEntered!: () => void;
      const ownerEntered = new Promise<void>((resolve) => { markOwnerEntered = resolve; });
      const ownerHeld = new Promise<void>((resolve) => { releaseOwner = resolve; });
      const ownerPrepare = vi.fn(async () => {
        markOwnerEntered();
        await ownerHeld;
        return managerPreparedResponse(ownerPlan, "session-cross-mcp-owner");
      });
      const contenderPrepare = vi.fn(async () =>
        managerPreparedResponse(contenderPlan, "session-cross-mcp-contender"));
      const ownerResult = owner.manager.prepareInitialOwnedGameLaunch({
        launchInput: ownerPlan.launchInput,
        evidence: ownerPlan.evidence,
        prepare: ownerPrepare,
        revokeSession: vi.fn(),
      });
      await ownerEntered;
      const contenderResult = contender.manager.prepareInitialOwnedGameLaunch({
        launchInput: contenderPlan.launchInput,
        evidence: contenderPlan.evidence,
        prepare: contenderPrepare,
        revokeSession: vi.fn(),
      });
      releaseOwner();

      await expect(ownerResult).resolves.toMatchObject({ sessionId: "session-cross-mcp-owner" });
      await expect(contenderResult).rejects.toMatchObject({ code: "PREPARED_LAUNCH_STALE" });
      expect(ownerPrepare).toHaveBeenCalledOnce();
      expect(contenderPrepare).not.toHaveBeenCalled();
      expect(listRecordIds(owner.manager, "prepared")).toHaveLength(1);
    }, { prefix: "rfo-game-launch-cross-mcp-" });
  });

  it("resumes the exact reserved attempt after preparation fails before returning", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      const application = testApplication(harness.root);
      const input = parseGameLaunchInput({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 0,
      }, 60_000);
      const plan = await planCanonicalGameLaunch(application, input as never, {
        manager: harness.manager,
        defaultSessionTtlMs: 60_000,
      });
      let failedAttemptKey: string | undefined;

      await expect(harness.manager.prepareInitialOwnedGameLaunch({
        launchInput: plan.launchInput,
        evidence: plan.evidence,
        prepare: async (attemptInput) => {
          failedAttemptKey = attemptInput.idempotencyKey;
          throw new Error("fixture prepare response was lost");
        },
        revokeSession: vi.fn(),
      })).rejects.toMatchObject({ code: "PREPARE_FAILED" });

      const [chainId] = listRecordIds(harness.manager, "game-launch-chains");
      expect(chainId).toBeDefined();
      const reserved = readRecord(harness.manager, "game-launch-chains", chainId!);
      expect(reserved.current).toMatchObject({ state: "reserved" });
      const legacyCurrent = { ...(reserved.current as Record<string, unknown>) };
      delete legacyCurrent.preparationAbort;
      writeRecord(harness.manager, "game-launch-chains", chainId!, JSON.stringify({
        ...reserved,
        current: legacyCurrent,
      }));
      await expect(inspectIdle(harness.manager)).resolves.toMatchObject({
        complete: true,
        blockers: ["OWNED_RUNTIME_START"],
      });

      let resumedAttemptKey: string | undefined;
      const resumed = await harness.manager.prepareInitialOwnedGameLaunch({
        launchInput: plan.launchInput,
        evidence: plan.evidence,
        prepare: async (attemptInput) => {
          resumedAttemptKey = attemptInput.idempotencyKey;
          return managerPreparedResponse(plan, "session-resumed-reservation");
        },
        revokeSession: vi.fn(),
      });

      expect(failedAttemptKey).toBeDefined();
      expect(resumedAttemptKey).toBe(failedAttemptKey);
      expect(resumed.compositeAttemptId).toBe(
        (reserved.current as Record<string, unknown>).compositeAttemptId,
      );
      expect(readRecord(harness.manager, "game-launch-chains", chainId!).current)
        .toMatchObject({ state: "prepared", sessionId: "session-resumed-reservation" });
      await expect(inspectIdle(harness.manager)).resolves.toMatchObject({
        complete: true,
        blockers: ["OWNED_RUNTIME_PREPARATION"],
      });
      expect(harness.spawnCalls).toHaveLength(0);
    }, { prefix: "rfo-game-launch-resume-reserved-" });
  });

  it("terminalizes a proven-revoked unrecorded preparation and retries with a fresh attempt", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      const application = testApplication(harness.root);
      const input = parseGameLaunchInput({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 0,
      }, 60_000);
      const plan = await planCanonicalGameLaunch(application, input as never, {
        manager: harness.manager,
        defaultSessionTtlMs: 60_000,
      });
      const writable = harness.manager as unknown as {
        atomicWrite(
          rootPath: string,
          target: string,
          value: unknown,
          exclusive: boolean,
          durable?: boolean,
        ): void;
      };
      const atomicWrite = writable.atomicWrite.bind(harness.manager);
      writable.atomicWrite = (rootPath, target, value, exclusive, durable) => {
        if (/[\\/]prepared[\\/]/.test(target)) {
          throw new Error("fixture descriptor publication failed");
        }
        atomicWrite(rootPath, target, value, exclusive, durable);
      };
      const revokeSession = vi.fn(async () => ({ revoked: true }));
      let failedAttemptKey: string | undefined;

      await expect(harness.manager.prepareInitialOwnedGameLaunch({
        launchInput: plan.launchInput,
        evidence: plan.evidence,
        prepare: async (attemptInput) => {
          failedAttemptKey = attemptInput.idempotencyKey;
          return managerPreparedResponse(plan, "session-unrecorded-revoked");
        },
        revokeSession,
      })).rejects.toMatchObject({ code: "PREPARE_FAILED" });

      const [chainId] = listRecordIds(harness.manager, "game-launch-chains");
      const aborted = readRecord(harness.manager, "game-launch-chains", chainId!);
      expect(aborted.current).toMatchObject({
        state: "aborted",
        sessionId: "session-unrecorded-revoked",
        preparationAbort: {
          sessionId: "session-unrecorded-revoked",
          sessionRevoked: true,
        },
      });
      expect(revokeSession).toHaveBeenCalledWith("session-unrecorded-revoked");
      expect(listRecordIds(harness.manager, "prepared")).toEqual([]);
      expect(listRecordIds(harness.manager, "prepared-index")).toEqual([]);
      await expect(inspectIdle(harness.manager)).resolves.toMatchObject({
        complete: true,
        blockers: [],
      });

      writable.atomicWrite = atomicWrite;
      let replacementAttemptKey: string | undefined;
      const replacement = await harness.manager.prepareInitialOwnedGameLaunch({
        launchInput: plan.launchInput,
        evidence: plan.evidence,
        prepare: async (attemptInput) => {
          replacementAttemptKey = attemptInput.idempotencyKey;
          return managerPreparedResponse(plan, "session-replacement-after-abort");
        },
        revokeSession,
      });

      expect(failedAttemptKey).toBeDefined();
      expect(replacementAttemptKey).toBeDefined();
      expect(replacementAttemptKey).not.toBe(failedAttemptKey);
      expect(replacement.compositeAttemptId).not.toBe(
        (aborted.current as Record<string, unknown>).compositeAttemptId,
      );
      expect(revokeSession).toHaveBeenCalledTimes(1);
      expect(harness.spawnCalls).toHaveLength(0);
    }, { prefix: "rfo-game-launch-abort-unrecorded-" });
  });

  it("keeps an unrecorded preparation pinned when the observer does not prove revocation", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      const application = testApplication(harness.root);
      const input = parseGameLaunchInput({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 0,
      }, 60_000);
      const plan = await planCanonicalGameLaunch(application, input as never, {
        manager: harness.manager,
        defaultSessionTtlMs: 60_000,
      });
      const writable = harness.manager as unknown as {
        atomicWrite(
          rootPath: string,
          target: string,
          value: unknown,
          exclusive: boolean,
          durable?: boolean,
        ): void;
      };
      const atomicWrite = writable.atomicWrite.bind(harness.manager);
      writable.atomicWrite = (rootPath, target, value, exclusive, durable) => {
        if (/[\\/]prepared[\\/]/.test(target)) {
          throw new Error("fixture descriptor publication failed");
        }
        atomicWrite(rootPath, target, value, exclusive, durable);
      };
      const revokeSession = vi.fn(async () => ({ revoked: false }));

      await expect(harness.manager.prepareInitialOwnedGameLaunch({
        launchInput: plan.launchInput,
        evidence: plan.evidence,
        prepare: async () => managerPreparedResponse(plan, "session-revocation-unproved"),
        revokeSession,
      })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

      writable.atomicWrite = atomicWrite;
      const retryPrepare = vi.fn(async () =>
        managerPreparedResponse(plan, "session-must-not-replace-unproved"));
      await expect(harness.manager.prepareInitialOwnedGameLaunch({
        launchInput: plan.launchInput,
        evidence: plan.evidence,
        prepare: retryPrepare,
        revokeSession,
      })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

      const [chainId] = listRecordIds(harness.manager, "game-launch-chains");
      expect(readRecord(harness.manager, "game-launch-chains", chainId!).current)
        .toMatchObject({ state: "revocation_pending", sessionId: "session-revocation-unproved" });
      expect(retryPrepare).not.toHaveBeenCalled();
      expect(revokeSession).toHaveBeenCalledTimes(2);
      await expect(inspectIdle(harness.manager)).resolves.toMatchObject({
        complete: true,
        blockers: ["OWNED_RUNTIME_RECOVERY"],
      });
      expect(harness.spawnCalls).toHaveLength(0);
    }, { prefix: "rfo-game-launch-revocation-unproved-" });
  });

  it("keeps revocation pending across an abort-publication crash and recovers on exact retry", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      const application = testApplication(harness.root);
      const input = parseGameLaunchInput({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 0,
      }, 60_000);
      const plan = await planCanonicalGameLaunch(application, input as never, {
        manager: harness.manager,
        defaultSessionTtlMs: 60_000,
      });
      const writable = harness.manager as unknown as {
        atomicWrite(
          rootPath: string,
          target: string,
          value: unknown,
          exclusive: boolean,
          durable?: boolean,
        ): void;
      };
      const atomicWrite = writable.atomicWrite.bind(harness.manager);
      writable.atomicWrite = (rootPath, target, value, exclusive, durable) => {
        if (/[\\/]prepared[\\/]/.test(target)) {
          throw new Error("fixture descriptor publication failed");
        }
        const current = (value as { current?: { state?: string } }).current;
        if (current?.state === "aborted") {
          throw new Error("fixture crash before abort proof publication");
        }
        atomicWrite(rootPath, target, value, exclusive, durable);
      };
      const revokeSession = vi.fn(async () => ({ revoked: true }));
      let failedAttemptKey: string | undefined;

      await expect(harness.manager.prepareInitialOwnedGameLaunch({
        launchInput: plan.launchInput,
        evidence: plan.evidence,
        prepare: async (attemptInput) => {
          failedAttemptKey = attemptInput.idempotencyKey;
          return managerPreparedResponse(plan, "session-revoked-before-crash");
        },
        revokeSession,
      })).rejects.toMatchObject({ code: "PREPARE_FAILED" });

      const [chainId] = listRecordIds(harness.manager, "game-launch-chains");
      expect(readRecord(harness.manager, "game-launch-chains", chainId!).current)
        .toMatchObject({ state: "revocation_pending", sessionId: "session-revoked-before-crash" });
      await expect(inspectIdle(harness.manager)).resolves.toMatchObject({
        complete: true,
        blockers: ["OWNED_RUNTIME_RECOVERY"],
      });

      writable.atomicWrite = atomicWrite;
      let replacementAttemptKey: string | undefined;
      const replacement = await harness.manager.prepareInitialOwnedGameLaunch({
        launchInput: plan.launchInput,
        evidence: plan.evidence,
        prepare: async (attemptInput) => {
          replacementAttemptKey = attemptInput.idempotencyKey;
          return managerPreparedResponse(plan, "session-after-revocation-crash");
        },
        revokeSession,
      });

      expect(revokeSession).toHaveBeenCalledTimes(2);
      expect(revokeSession).toHaveBeenNthCalledWith(1, "session-revoked-before-crash");
      expect(revokeSession).toHaveBeenNthCalledWith(2, "session-revoked-before-crash");
      expect(failedAttemptKey).toBeDefined();
      expect(replacementAttemptKey).toBeDefined();
      expect(replacementAttemptKey).not.toBe(failedAttemptKey);
      expect(replacement.sessionId).toBe("session-after-revocation-crash");
      expect(harness.spawnCalls).toHaveLength(0);
    }, { prefix: "rfo-game-launch-revocation-crash-" });
  });

  it("does not revoke an unrecorded session after the preparation mutex lease is lost", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const backend = createFakeBackend();
      let loseLease: ((error: LifecycleGuardError) => void) | undefined;
      backend.withMachineMutex = async (options) => {
        loseLease = options.onLeaseLost;
        return options.action();
      };
      const harness = makeHarness({ backend });
      const application = testApplication(harness.root);
      const input = parseGameLaunchInput({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 0,
      }, 60_000);
      const plan = await planCanonicalGameLaunch(application, input as never, {
        manager: harness.manager,
        defaultSessionTtlMs: 60_000,
      });
      const revokeSession = vi.fn(async () => ({ revoked: true }));

      await expect(harness.manager.prepareInitialOwnedGameLaunch({
        launchInput: plan.launchInput,
        evidence: plan.evidence,
        prepare: async () => {
          loseLease?.(new LifecycleGuardError(
            "fixture preparation lease was lost",
            "RECOVERY_REQUIRED",
          ));
          return managerPreparedResponse(plan, "session-lost-prepare-lease");
        },
        revokeSession,
      })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      expect(revokeSession).not.toHaveBeenCalled();
      expect(listRecordIds(harness.manager, "prepared")).toEqual([]);
      expect(listRecordIds(harness.manager, "prepared-index")).toEqual([]);
      expect(harness.spawnCalls).toHaveLength(0);
    }, { prefix: "rfo-game-launch-lease-loss-" });
  });

  it("does not revoke when failed publication leaves a descriptor without its index", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      const application = testApplication(harness.root);
      const input = parseGameLaunchInput({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 0,
      }, 60_000);
      const plan = await planCanonicalGameLaunch(application, input as never, {
        manager: harness.manager,
        defaultSessionTtlMs: 60_000,
      });
      const writable = harness.manager as unknown as {
        atomicWrite(
          rootPath: string,
          target: string,
          value: unknown,
          exclusive: boolean,
          durable?: boolean,
        ): void;
        unlinkOwnedFile(target: string): void;
      };
      const atomicWrite = writable.atomicWrite.bind(harness.manager);
      writable.atomicWrite = (rootPath, target, value, exclusive, durable) => {
        if (target.includes("prepared-index")) throw new Error("fixture index publication failed");
        atomicWrite(rootPath, target, value, exclusive, durable);
      };
      writable.unlinkOwnedFile = () => { throw new Error("fixture descriptor rollback failed"); };
      const revokeSession = vi.fn(async () => ({ revoked: true }));

      await expect(harness.manager.prepareInitialOwnedGameLaunch({
        launchInput: plan.launchInput,
        evidence: plan.evidence,
        prepare: async () => managerPreparedResponse(plan, "session-orphaned-descriptor"),
        revokeSession,
      })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      expect(revokeSession).not.toHaveBeenCalled();
      expect(listRecordIds(harness.manager, "prepared")).toHaveLength(1);
      expect(listRecordIds(harness.manager, "prepared-index")).toEqual([]);
      expect(harness.spawnCalls).toHaveLength(0);
    }, { prefix: "rfo-game-launch-orphaned-descriptor-" });
  });

  it("never revokes after an unknown start outcome", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      const revokeSession = vi.fn(async () => ({ revoked: true }));
      const application = testApplication(harness.root, { revokeSession } as Partial<ObserverApplication>);
      vi.spyOn(harness.manager, "start").mockRejectedValueOnce(new Error("lost post-spawn response"));
      const result = await register(application, harness.manager)({
        gprojPath: fixture.projectPath,
        waitForInstanceMs: 0,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("INTERNAL_ERROR");
      expect(revokeSession).not.toHaveBeenCalled();
    }, { prefix: "rfo-game-launch-unknown-start-" });
  });

  it("routes status and stop through the shared owned-runtime executor and forwards cancellation", async () => {
    const runtimeId = "rt-00000000-0000-4000-8000-000000000001";
    const runtime = {
      runtimeId,
      sessionId: "session-game-launch",
      preparedLaunchId: "pl-00000000-0000-4000-8000-000000000001",
      pid: 4242,
      runtimeKind: "listenServer" as const,
      startedAt: "2026-07-18T12:00:00.000Z",
      exactOwned: true,
    };
    const status = vi.fn(async () => ({ ...runtime, state: "running" as const }));
    const stop = vi.fn(async () => ({ ...runtime, state: "exited" as const }));
    const manager = { status, stop } as unknown as OwnedRuntimeManager;
    const application = testApplication("C:\\private");
    const call = register(application, manager);
    const controller = new AbortController();

    const statusResult = await call({ action: "status", runtimeId });
    const stopResult = await call({ action: "stop", runtimeId }, controller.signal);
    expect(statusResult.isError).not.toBe(true);
    expect(stopResult.isError).not.toBe(true);
    expect(payload(statusResult)).toMatchObject({ action: "status", runtime: { runtimeId } });
    expect(payload(stopResult)).toMatchObject({ action: "stop", runtime: { runtimeId } });
    expect(JSON.parse(statusResult.content[0]?.text ?? "null")).toEqual(
      statusResult.structuredContent,
    );
    expect(JSON.parse(stopResult.content[0]?.text ?? "null")).toEqual(
      stopResult.structuredContent,
    );
    expect(status).toHaveBeenCalledWith(runtimeId);
    expect(stop).toHaveBeenCalledWith({
      runtimeId,
      waitForRestorationMs: 20_000,
      idempotencyKey: deriveObserverRuntimeIdempotencyKey({
        action: "stop", runtimeId, waitForRestorationMs: 20_000,
      }),
      signal: controller.signal,
    });
  });

  it("projects spoofed failures to a fixed internal error", async () => {
    const runtimeId = "rt-00000000-0000-4000-8000-000000000001";
    const manager = {
      status: vi.fn(async () => {
        throw Object.assign(Object.create(null) as Record<string, unknown>, {
          code: "PROJECT_INVALID",
          message: "attacker controlled diagnostic",
        });
      }),
    } as unknown as OwnedRuntimeManager;
    const result = await register(testApplication("C:\\private"), manager)({ action: "status", runtimeId });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Game launch error (INTERNAL_ERROR): Game launch planning failed.");
  });

  it("pins the first profile family and refuses changed evidence instead of preparing a successor", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      const application = testApplication(harness.root);
      const first = parseGameLaunchInput({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        arguments: ["-logStats", "1000"],
        waitForInstanceMs: 0,
      }, 60_000);
      const firstPlan = await planCanonicalGameLaunch(application, first as never, {
        manager: harness.manager,
        defaultSessionTtlMs: 60_000,
      });
      await harness.manager.prepareInitialOwnedGameLaunch({
        launchInput: firstPlan.launchInput,
        evidence: firstPlan.evidence,
        prepare: async () => ({
          ...preparedResponse(firstPlan.launchInput as unknown as Record<string, unknown>).session,
          arguments: [...firstPlan.arguments],
          sessionId: "session-pinned-family",
          expiresAt: "2026-07-18T12:10:00.000Z",
          bundleDigest: "a".repeat(64),
          profilePath: firstPlan.profilePath,
          warnings: [],
        }),
        revokeSession: async () => ({ revoked: true }),
      });
      const changed = parseGameLaunchInput({
        gprojPath: fixture.projectPath,
        arguments: ["-logStats", "2000"],
        waitForInstanceMs: 0,
      }, 60_000);
      const changedPlan = await planCanonicalGameLaunch(application, changed as never, {
        manager: harness.manager,
        defaultSessionTtlMs: 60_000,
      });
      await expect(harness.manager.prepareInitialOwnedGameLaunch({
        launchInput: changedPlan.launchInput,
        evidence: changedPlan.evidence,
        prepare: vi.fn(),
        revokeSession: vi.fn(),
      })).rejects.toMatchObject({ code: "ARGUMENT_CONFLICT" });
    }, { prefix: "rfo-game-launch-family-" });
  });
});
