import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  computeGameLaunchPrepareKey,
  gameLaunchRawInputSchema,
  parseGameLaunchInput,
  planCanonicalGameLaunch,
  registerGameLaunch,
  type GameLaunchPrepareIdentity,
} from "../../src/tools/game-launch.js";
import { deriveObserverRuntimeIdempotencyKey } from "../../src/tools/owned-runtime-operations.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";
import {
  cleanupOwnedRuntimeManagerFixtures,
  createFakeBackend,
  createSerialBackend,
  listRecordIds,
  makeHarness,
  readRecord,
  writeRecord,
} from "./owned-runtime-manager-fixture.js";
import { LifecycleGuardError } from "../../src/workbench/process-guard.js";

const TARGET_GUID = "AAAAAAAAAAAAAAAA";
const DEPENDENCY_GUID = "BBBBBBBBBBBBBBBB";
const WORLD_GUID = "A1B2C3D4E5F60718";

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
) {
  let handler!: (input: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<{
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }>;
  const server = {
    registerTool(name: string, _definition: unknown, registered: typeof handler): void {
      if (name === "game_launch") handler = registered;
    },
  } as unknown as McpServer;
  registerGameLaunch(server, application, {
    manager,
    configuredAddonRoots,
    defaultSessionTtlMs: 60_000,
  });
  return (input: Record<string, unknown>, signal = new AbortController().signal) =>
    handler(input, { signal });
}

function payload(result: { content: Array<{ text?: string }> }): Record<string, unknown> {
  const text = result.content[0]?.text ?? "";
  const match = /```json\n([\s\S]+)\n```$/.exec(text);
  if (!match) throw new Error(`Expected JSON tool payload: ${text}`);
  return JSON.parse(match[1]) as Record<string, unknown>;
}

afterEach(async () => {
  await cleanupOwnedRuntimeManagerFixtures();
});

describe("owned game launch composite", () => {
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

      expect(first.isError).not.toBe(true);
      expect(second.isError).not.toBe(true);
      const firstPayload = payload(first);
      const secondPayload = payload(second);
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
  });

  it("joins concurrent equal mutations while each caller performs its own readiness wait", async () => {
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
      const first = call(input);
      await vi.waitFor(() => expect(prepareLaunch).toHaveBeenCalledOnce());
      const second = call(input);
      release();
      const [one, two] = await Promise.all([first, second]);

      expect(one.isError).not.toBe(true);
      expect(two.isError).not.toBe(true);
      expect(prepareLaunch).toHaveBeenCalledOnce();
      expect(harness.spawnCalls).toHaveLength(1);
      expect(application.instances).toHaveBeenCalledTimes(2);
    }, { prefix: "rfo-game-launch-concurrent-" });
  });

  it("reports readiness timeout and cancellation as partial success with exact stop authority", async () => {
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
      expect(value).toHaveProperty("readinessWarning");
      expect(value.runtime).toMatchObject({ state: "running", exactOwned: true });
      expect(value.next).toMatchObject({
        stop: { tool: "game_launch", input: { runtimeId: expect.stringMatching(/^rt-/) } },
        capture: { ready: false, firstCall: { tool: "observer_instances" } },
      });
      expect(harness.spawnCalls).toHaveLength(1);
    }, { prefix: "rfo-game-launch-readiness-" });
  });

  it("preserves a live runtime when the caller cancels only its readiness wait", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      const instances = vi.fn(async (input: { signal?: AbortSignal }) => {
        expect(input.signal?.aborted).toBe(true);
        throw new ObserverApplicationError("CANCELLED", "fixture readiness wait cancelled");
      });
      const application = testApplication(harness.root, { instances } as Partial<ObserverApplication>);
      const controller = new AbortController();
      controller.abort();
      const result = await register(application, harness.manager)({
        gprojPath: fixture.projectPath,
        world: fixture.worldPath,
        waitForInstanceMs: 60_000,
      }, controller.signal);

      expect(result.isError).not.toBe(true);
      const value = payload(result);
      expect(value.runtime).toMatchObject({ state: "running", exactOwned: true });
      expect(value).toHaveProperty("readinessWarning");
      expect(value.next).toMatchObject({
        stop: { tool: "game_launch", input: { runtimeId: expect.stringMatching(/^rt-/) } },
      });
      expect(harness.spawnCalls).toHaveLength(1);
    }, { prefix: "rfo-game-launch-readiness-cancel-" });
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
        removedPreparedLaunchIds: [preparedLaunchId],
      });
      expect(listRecordIds(harness.manager, "prepared-invalidations")).toEqual([]);
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

  it("refuses a same-family retry after the runtime reaches a terminal state", async () => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createProjectFixture(root);
      const harness = makeHarness();
      const application = testApplication(harness.root);
      const call = register(application, harness.manager);
      const input = { gprojPath: fixture.projectPath, world: fixture.worldPath, waitForInstanceMs: 0 };
      const first = payload(await call(input));
      const runtimeId = String((first.runtime as Record<string, unknown>).runtimeId);
      const stopped = await call({ action: "stop", runtimeId, waitForRestorationMs: 0 });
      expect(stopped.isError).not.toBe(true);

      const retry = await call(input);
      expect(retry.isError).toBe(true);
      expect(retry.content[0]?.text).toContain("PREPARED_LAUNCH_CONSUMED");
      expect(application.prepareLaunch).toHaveBeenCalledOnce();
      expect(harness.spawnCalls).toHaveLength(1);
    }, { prefix: "rfo-game-launch-terminal-" });
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
    const status = vi.fn(async () => ({ runtimeId, state: "running", exactOwned: true }));
    const stop = vi.fn(async () => ({ runtimeId, state: "exited", exactOwned: true }));
    const manager = { status, stop } as unknown as OwnedRuntimeManager;
    const application = testApplication("C:\\private");
    const call = register(application, manager);
    const controller = new AbortController();

    expect((await call({ action: "status", runtimeId })).isError).not.toBe(true);
    expect((await call({ action: "stop", runtimeId }, controller.signal)).isError).not.toBe(true);
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
