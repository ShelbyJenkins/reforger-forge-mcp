import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { WorkbenchClient, WorkbenchError } from "../src/workbench/client.js";
import { WorkbenchHelperStager } from "../src/workbench/helper-addon.js";
import { WorkbenchProcessGuard } from "../src/workbench/process-guard.js";
import { WorkbenchNetApiClient } from "../src/workbench/net-api-client.js";
import type { WorkbenchClientDependencies } from "../src/workbench/session-controller.js";
import type { WorkbenchModalEvidence } from "../src/workbench/modal-watchdog.js";
import { canonicalizeGproj } from "../src/workbench/project-identity.js";
import { canonicalizeResourceTarget } from "../src/workbench/resource-target.js";
import {
  acceptanceConfig,
  createDisposableProject,
  loadAcceptanceBaseConfig,
} from "./workbench-observer-acceptance-runtime.js";

export const LIVE_WORKBENCH_EXPLICIT_SAVE_ENVIRONMENT =
  "RFO_RUN_LIVE_WORKBENCH_EXPLICIT_SAVE_ACCEPTANCE";

const BASE_PROBE_PREFAB = "{1391CE8C0E255636}Prefabs/Systems/MilitaryBase/ConflictMilitaryBase.et";
const BASE_GAME_MODE_PREFAB = "{0F307326459A1395}Prefabs/MP/Modes/GameMode_Base.et";
const LIVE_COMPONENT_CLASS = "RFO_LivePersistenceProbeComponent";
const LIVE_COMPONENT_ENTITY = "RFO_ComponentPersistenceRoot";

interface ParsedArguments {
  readonly configPath?: string;
  readonly confirmed: boolean;
  readonly help: boolean;
  readonly modalRuns: number;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  let configPath: string | undefined;
  let confirmed = false;
  let help = false;
  let modalRuns = 1;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--confirm-live-run") {
      confirmed = true;
      continue;
    }
    if (arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--modal-runs") {
      const value = argv[index + 1];
      if (!value || !/^[1-9][0-9]*$/.test(value)) {
        throw new Error("--modal-runs requires a positive integer");
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed > 100) {
        throw new Error("--modal-runs must be an integer from 1 through 100");
      }
      modalRuns = parsed;
      index += 1;
      continue;
    }
    if (arg !== "--config") throw new Error(`Unknown explicit-save acceptance argument: ${arg}`);
    if (configPath !== undefined) throw new Error("--config may be specified only once");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--config requires a value");
    configPath = isAbsolute(value) ? value : resolve(process.cwd(), value);
    index += 1;
  }
  return { configPath, confirmed, help, modalRuns };
}

function assertAuthorized(confirmed: boolean, environment: NodeJS.ProcessEnv): void {
  if (!confirmed || environment[LIVE_WORKBENCH_EXPLICIT_SAVE_ENVIRONMENT] !== "1") {
    throw new Error(
      "Live explicit-save acceptance requires both " +
      `${LIVE_WORKBENCH_EXPLICIT_SAVE_ENVIRONMENT}=1 and --confirm-live-run`
    );
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function snapshotTarget(modDirectory: string): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true, encoding: "utf8" })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) result.set(relative(modDirectory, path).replace(/\\/g, "/"), sha256(path));
    }
  };
  visit(modDirectory);
  return result;
}

function changedPaths(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter((path) =>
    before.get(path) !== after.get(path)
  ).sort((left, right) => left.localeCompare(right));
}

function assertOnlyTargetBundleChanged(paths: readonly string[]): void {
  for (const path of paths) {
    assert.ok(
        path === "resourceDatabase.rdb" || path === "Worlds/ObserverAcceptance.ent" ||
        path === "Worlds/ObserverAcceptance.ent.meta" ||
        path.startsWith("Worlds/ObserverAcceptance_") ||
        path.startsWith("Worlds/ObserverAcceptance_Layers/"),
      `explicit save changed a path outside the target world bundle: ${path}`
    );
  }
}

interface LiveExplicitSaveCaseContext {
  readonly root: string;
  readonly project: ReturnType<typeof createDisposableProject>;
  readonly worldPath: string;
  readonly target: ReturnType<typeof canonicalizeResourceTarget>;
  readonly guard: WorkbenchProcessGuard;
  readonly client: WorkbenchClient;
}

interface LiveExplicitSaveCaseOptions {
  readonly label: string;
  readonly configPath: string;
  readonly baseConfig: ReturnType<typeof loadAcceptanceBaseConfig>;
  readonly makeDependencies?: (
    input: Omit<LiveExplicitSaveCaseContext, "client">
  ) => WorkbenchClientDependencies;
}

async function runLiveExplicitSaveCase(
  options: LiveExplicitSaveCaseOptions,
  action: (context: LiveExplicitSaveCaseContext) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `reforger-forge-live-explicit-save-${options.label}-`));
  const managedRoot = join(root, "managed");
  const stateDir = join(root, "state");
  const helperPath = fileURLToPath(new URL("./windows/workbench-lifecycle.ps1", import.meta.url));
  const guard = new WorkbenchProcessGuard({ stateDir, helperPath, lockTimeoutMs: 20_000 });
  let client: WorkbenchClient | null = null;
  let retained = false;
  try {
    const project = createDisposableProject(root);
    const worldPath = join(project.modDirectory, "Worlds", "ObserverAcceptance.ent");
    const config = acceptanceConfig(options.configPath, root, managedRoot, options.baseConfig);
    const target = canonicalizeResourceTarget(worldPath, canonicalizeGproj(project.projectPath));

    assert.deepEqual(await guard.listWorkbenchProcesses(), []);
    const preClient: Omit<LiveExplicitSaveCaseContext, "client"> = {
      root,
      project,
      worldPath,
      target,
      guard,
    };
    const dependencies = options.makeDependencies?.(preClient);

    client = new WorkbenchClient(
      config.workbenchHost,
      config.workbenchPort,
      config,
      "live-explicit-save-acceptance",
      guard,
      {
        companionProvider: new WorkbenchHelperStager({ managedRoot }),
        launchTimeoutMs: 120_000,
        launchPollIntervalMs: 1_000,
        ...dependencies,
      }
    );
    await action({ ...preClient, client });
  } catch (error) {
    retained = true;
    throw error;
  } finally {
    if (client) {
      try {
        await client.shutdownOwnedWorkbench();
      } catch (error) {
        console.warn("[live-explicit-save-acceptance] exact-owner cleanup refused", error);
      }
    }
    const remaining = await guard.listWorkbenchProcesses().catch(() => []);
    await guard.close();
    if (remaining.length > 0) {
      retained = true;
      throw new Error(`live explicit-save acceptance left Workbench running: ${remaining.map((entry) => entry.pid).join(", ")}`);
    }
    if (!retained && existsSync(root)) rmSync(root, { recursive: true, force: true });
    if (retained) console.error(`[live-explicit-save-acceptance] retained failure root: ${root}`);
  }
}

async function createProbe(context: LiveExplicitSaveCaseContext, name: string): Promise<void> {
  const created = await context.client.call<Record<string, unknown>>("EMCP_WB_CreateEntity", {
    prefab: BASE_PROBE_PREFAB,
    position: "100 0 100",
    rotation: "0 0 0",
    name,
    layerID: 0,
  });
  assert.equal(created.status, "ok", `entity creation failed: ${String(created.message)}`);
}

async function runHappySaveCase(
  configPath: string,
  baseConfig: ReturnType<typeof loadAcceptanceBaseConfig>,
  label: string
): Promise<void> {
  await runLiveExplicitSaveCase({ label, configPath, baseConfig }, async (context) => {
    const { client, guard, project, target, worldPath } = context;
    const preflight = snapshotTarget(project.modDirectory);
    const launched = await client.ensureTargetResourceRunning(project.projectPath, worldPath);
    assert.equal(launched.action, "launched");
    assert.equal(launched.resourcePath.toLowerCase(), target.displayPath.toLowerCase());
    assert.equal(await client.ping(), true);

    const probeName = `RFO_ExplicitSaveProbe_${randomUUID().replace(/-/g, "")}`;
    await createProbe(context, probeName);

    const saved = await client.saveResource(worldPath);
    assert.equal(saved.resourcePath.toLowerCase(), target.displayPath.toLowerCase());
    assert.equal(saved.outcome, "changed");
    assert.ok(saved.changedPaths.some((path) => path.startsWith("Worlds/ObserverAcceptance_")));
    const afterSave = snapshotTarget(project.modDirectory);
    assertOnlyTargetBundleChanged(changedPaths(preflight, afterSave));

    await client.shutdownOwnedWorkbench();
    assert.deepEqual(await guard.listWorkbenchProcesses(), []);
    assert.equal(await client.ping(), false);

    const reopened = await client.ensureTargetResourceRunning(project.projectPath, worldPath);
    assert.equal(reopened.action, "launched");
    const found = await client.call<Record<string, unknown>>("EMCP_WB_ListEntities", {
      offset: 0,
      limit: 10,
      nameFilter: probeName,
    });
    assert.equal(found.status, "ok", `entity query failed: ${String(found.message)}`);
    assert.ok(Array.isArray(found.entities) && found.entities.some((item) =>
      item && typeof item === "object" && (item as Record<string, unknown>).name === probeName
    ), "saved target did not restore the probe entity in a fresh Workbench process");

    const noOpBefore = snapshotTarget(project.modDirectory);
    const noOp = await client.saveResource(worldPath);
    assert.equal(noOp.outcome, "no_change");
    assert.deepEqual(snapshotTarget(project.modDirectory), noOpBefore);
    await client.shutdownOwnedWorkbench();
    assert.deepEqual(await guard.listWorkbenchProcesses(), []);
  });
}

async function runPrefabIntegrityCase(
  configPath: string,
  baseConfig: ReturnType<typeof loadAcceptanceBaseConfig>
): Promise<void> {
  let explicitSaveDispatches = 0;
  await runLiveExplicitSaveCase({
    label: "prefab-integrity",
    configPath,
    baseConfig,
    makeDependencies: () => {
      const delegate = new WorkbenchNetApiClient(baseConfig.workbenchHost, baseConfig.workbenchPort, {
        clientId: "live-prefab-integrity",
      });
      return {
        netApi: {
          async call<T = Record<string, unknown>>(
            apiFunc: string,
            params?: Record<string, unknown>,
            requestOptions?: Parameters<WorkbenchNetApiClient["call"]>[2]
          ): Promise<T> {
            if (apiFunc === "EMCP_WB_ExplicitResourceSave" && params?.action === "save") {
              explicitSaveDispatches += 1;
            }
            return delegate.call<T>(apiFunc, params, requestOptions);
          },
        },
      };
    },
  }, async (context) => {
    const { client, guard, project } = context;
    const prefabsDirectory = join(project.modDirectory, "Prefabs");
    const scriptsDirectory = join(project.modDirectory, "Scripts", "Game");
    mkdirSync(prefabsDirectory, { recursive: true });
    mkdirSync(scriptsDirectory, { recursive: true });
    writeFileSync(join(scriptsDirectory, "RFO_LivePersistenceProbeComponent.c"), [
      '[ComponentEditorProps(category: "GameScripted/ReforgerForge", description: "Live persistence probe")]',
      "class RFO_LivePersistenceProbeComponentClass : ScriptComponentClass",
      "{",
      "}",
      "",
      "class RFO_LivePersistenceProbeComponent : ScriptComponent",
      "{",
      ' [Attribute("0")] int m_iProbeValue;',
      "}",
      "",
    ].join("\n"), "utf8");

    const componentPrefab = join(prefabsDirectory, "ComponentPersistence.et");
    const lossyPrefab = join(prefabsDirectory, "EmptyOverride.et");
    writeFileSync(componentPrefab, [
      "GenericEntity {",
      ' ID "A11CE00000000201"',
      ` Name "${LIVE_COMPONENT_ENTITY}"`,
      "}",
      "",
    ].join("\n"), "utf8");
    writeFileSync(lossyPrefab, [
      `SCR_BaseGameMode : "${BASE_GAME_MODE_PREFAB}" {`,
      ' ID "A11CE00000000202"',
      ' Name "RFO_EmptyOverrideRoot"',
      " components {",
      '  SCR_DataCollectorComponent "{5ADE83EE64329989}" {',
      "   m_aModules {",
      "   }",
      "  }",
      " }",
      "}",
      "",
    ].join("\n"), "utf8");

    const generic = await client.ensureRunning(project.projectPath);
    assert.equal(generic.action, "launched");
    const state = await client.call<Record<string, unknown>>(
      "EMCP_WB_GetState",
      {},
      { timeout: 30_000, skipAutoLaunch: true }
    );
    assert.equal(state.mode, "no_world_editor");
    for (const path of [componentPrefab, lossyPrefab]) {
      const registered: Record<string, unknown> = await client.call<Record<string, unknown>>(
        "EMCP_WB_Resources",
        { action: "register", path, buildRuntime: false },
        { timeout: 120_000, skipAutoLaunch: true }
      );
      assert.equal(registered.status, "ok", `prefab registration failed: ${String(registered.message)}`);
      assert.equal(existsSync(`${path}.meta`), true);
    }
    await client.shutdownOwnedWorkbench();
    assert.deepEqual(await guard.listWorkbenchProcesses(), []);

    const prefabEntityIndex = async (): Promise<number> => {
      const listed = await client.call<Record<string, unknown>>("EMCP_WB_ListEntities", {
        offset: 0,
        limit: 10,
        nameFilter: "",
      });
      assert.equal(listed.status, "ok", `entity listing failed: ${String(listed.message)}`);
      const entities = Array.isArray(listed.entities)
        ? listed.entities.filter((item): item is Record<string, unknown> =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)))
        : [];
      assert.equal(entities[1]?.className, "GenericEntity", `prefab edit root was not editor entity #1: ${JSON.stringify(entities)}`);
      return 1;
    };
    const componentClasses = async (entityIndex: number): Promise<string[]> => {
      const listed = await client.call<Record<string, unknown>>("EMCP_WB_Components", {
        action: "list",
        entityIndex,
      });
      assert.equal(listed.status, "ok", `component listing failed: ${String(listed.message)}`);
      return Array.isArray(listed.components)
        ? listed.components.flatMap((item) =>
          item && typeof item === "object" && !Array.isArray(item) &&
          typeof (item as Record<string, unknown>).className === "string"
            ? [(item as Record<string, unknown>).className as string]
            : [])
        : [];
    };

    await client.ensureTargetResourceRunning(project.projectPath, componentPrefab);
    const rootIndex = await prefabEntityIndex();
    assert.equal((await componentClasses(rootIndex)).includes(LIVE_COMPONENT_CLASS), false);
    const added = await client.call<Record<string, unknown>>("EMCP_WB_Components", {
      action: "add",
      entityIndex: rootIndex,
      componentClass: LIVE_COMPONENT_CLASS,
    });
    assert.equal(added.status, "ok", `component addition failed: ${String(added.message)}`);
    assert.equal((await componentClasses(rootIndex)).includes(LIVE_COMPONENT_CLASS), true);
    const modified = await client.call<Record<string, unknown>>("EMCP_WB_ModifyEntity", {
      action: "setProperty",
      entityIndex: rootIndex,
      propertyPath: LIVE_COMPONENT_CLASS,
      propertyKey: "m_iProbeValue",
      value: "42",
    });
    assert.equal(modified.status, "ok", `component property mutation failed: ${String(modified.message)}`);
    const readBack = await client.call<Record<string, unknown>>("EMCP_WB_ModifyEntity", {
      action: "getProperty",
      entityIndex: rootIndex,
      propertyPath: LIVE_COMPONENT_CLASS,
      propertyKey: "m_iProbeValue",
    });
    assert.equal(readBack.status, "ok", `component property lookup failed: ${String(readBack.message)}`);
    assert.equal(String(readBack.message), "42");

    const componentSave = await client.saveResource(componentPrefab);
    assert.equal(componentSave.outcome, "changed");
    assert.equal(explicitSaveDispatches, 1);
    const serialized = readFileSync(componentPrefab, "utf8");
    assert.match(serialized, new RegExp(`\\b${LIVE_COMPONENT_CLASS}\\b`));
    assert.match(serialized, /\bm_iProbeValue\s+42\b/);
    await client.shutdownOwnedWorkbench();
    assert.deepEqual(await guard.listWorkbenchProcesses(), []);

    await client.ensureTargetResourceRunning(project.projectPath, componentPrefab);
    const reopenedIndex = await prefabEntityIndex();
    assert.equal((await componentClasses(reopenedIndex)).includes(LIVE_COMPONENT_CLASS), true);
    const reopenedValue = await client.call<Record<string, unknown>>("EMCP_WB_ModifyEntity", {
      action: "getProperty",
      entityIndex: reopenedIndex,
      propertyPath: LIVE_COMPONENT_CLASS,
      propertyKey: "m_iProbeValue",
    });
    assert.equal(reopenedValue.status, "ok");
    assert.equal(String(reopenedValue.message), "42");
    await client.shutdownOwnedWorkbench();
    assert.deepEqual(await guard.listWorkbenchProcesses(), []);
    process.stdout.write("[live-explicit-save-acceptance] prefab component persisted across native save and fresh reopen\n");

    const lossyBefore = readFileSync(lossyPrefab);
    await client.ensureTargetResourceRunning(project.projectPath, lossyPrefab);
    await assert.rejects(client.saveResource(lossyPrefab), (error: unknown) =>
      error instanceof WorkbenchError && error.code === "TARGET_SESSION_TAINTED" &&
      error.message.includes("empty override")
    );
    assert.equal(explicitSaveDispatches, 1, "lossy-save refusal dispatched the native serializer");
    assert.deepEqual(readFileSync(lossyPrefab), lossyBefore);
    await assert.rejects(client.saveResource(lossyPrefab), (error: unknown) =>
      error instanceof WorkbenchError && error.code === "TARGET_SESSION_TAINTED"
    );
    assert.equal(explicitSaveDispatches, 1);
    await client.shutdownOwnedWorkbench();
    assert.deepEqual(await guard.listWorkbenchProcesses(), []);
    process.stdout.write("[live-explicit-save-acceptance] inherited empty override refused before native save with bytes preserved\n");
  });
}

async function runForcedNativeModalCase(
  configPath: string,
  baseConfig: ReturnType<typeof loadAcceptanceBaseConfig>,
  run: number
): Promise<void> {
  let armTestNativeModal = false;
  let testNativeModalInjected = false;
  let saveDispatches = 0;
  let modalEvidence: WorkbenchModalEvidence | null = null;
  await runLiveExplicitSaveCase({
    label: `modal-${run}`,
    configPath,
    baseConfig,
    makeDependencies: () => {
      const delegate = new WorkbenchNetApiClient(baseConfig.workbenchHost, baseConfig.workbenchPort, {
        clientId: `live-explicit-save-modal-${run}`,
      });
      return {
        netApi: {
          async call<T = Record<string, unknown>>(
            apiFunc: string,
            params?: Record<string, unknown>,
            requestOptions?: Parameters<WorkbenchNetApiClient["call"]>[2]
          ): Promise<T> {
          if (armTestNativeModal && !testNativeModalInjected &&
              apiFunc === "EMCP_WB_ExplicitResourceSave") {
            // The production tool never supplies testNativeModal. This raw
            // disposable-test transport asks the native handler to show an
            // official Workbench ScriptDialog in the same request that later
            // calls WorldEditor.Save(), so the watchdog is exercised against
            // an actual Workbench confirmation window.
            testNativeModalInjected = true;
            saveDispatches += 1;
            return delegate.call<T>(apiFunc, {
              ...(params ?? {}),
              testNativeModal: true,
            }, requestOptions);
          }
          return delegate.call<T>(apiFunc, params, requestOptions);
        },
        },
        onExplicitSaveModal: (evidence) => {
          modalEvidence = evidence;
        },
      };
    },
  }, async (context) => {
    const { client, guard, project, worldPath } = context;
    await client.ensureTargetResourceRunning(project.projectPath, worldPath);
    assert.equal(await client.ping(), true);
    await createProbe(context, `RFO_ModalBaselineProbe_${run}_${randomUUID().replace(/-/g, "")}`);
    assert.equal((await client.saveResource(worldPath)).outcome, "changed");

    armTestNativeModal = true;
    await assert.rejects(client.saveResource(worldPath), (error: unknown) => {
      return error instanceof WorkbenchError && error.code === "SAVE_OUTCOME_UNCERTAIN" &&
        error.message.includes("native dialog");
    });
    assert.equal(testNativeModalInjected, true, "the test-native modal was not armed at native save dispatch");
    assert.equal(saveDispatches, 1, "the forced modal case dispatched more than one native save request");
    assert.ok(modalEvidence, "the save failed without an observed native dialog");
    assert.ok(
      modalEvidence?.kind === "owned_modal" || modalEvidence?.kind === "standalone_modal",
      "the native dialog was neither an owned child nor a safely attributable standalone Workbench window"
    );
    assert.equal(modalEvidence.closeAttempted, true);
    assert.equal(modalEvidence.closePosted, true, "WM_CLOSE was not posted to the observed native dialog");
    process.stdout.write(
      `[live-explicit-save-acceptance] modal ${run}: ${modalEvidence.kind}; ` +
      `class=${modalEvidence.window.className}; title=${JSON.stringify(modalEvidence.window.title)}; ` +
      `dismissed=${modalEvidence.dismissed}\n`
    );

    await assert.rejects(client.saveResource(worldPath), (error: unknown) =>
      error instanceof WorkbenchError && error.code === "TARGET_SESSION_TAINTED"
    );
    assert.equal(saveDispatches, 1, "a tainted session dispatched another native save request");

    const state = await guard.readLifecycleState();
    assert.equal(state.kind, "valid", "native-dialog case lost its lifecycle record");
    if (state.kind !== "valid" || !state.state.workbench) throw new Error("owned Workbench identity disappeared");
    const remainingWindows = await guard.inspectExactWindows(state.state.workbench);
    const modalStillVisible = remainingWindows.some((window) => window.handle === modalEvidence?.window.handle);
    if (modalEvidence.dismissed) {
      assert.equal(modalStillVisible, false, "dismissal evidence was inconsistent with the final exact window snapshot");
    }

    // A native dialog can settle just after the bounded close observation.
    // The production contract never treats a posted close as save success;
    // it taints this session and requires exact-owned shutdown before a fresh
    // target retry regardless of whether the dialog was observed to vanish.
    await client.shutdownOwnedWorkbench();
    assert.deepEqual(await guard.listWorkbenchProcesses(), []);
    assert.equal(await client.ping(), false);

    // A fresh exact process must be able to save normally after the
    // modal-tainted process has been retired. This also proves the test never
    // recovers by reusing the tainted session.
    await client.ensureTargetResourceRunning(project.projectPath, worldPath);
    await createProbe(context, `RFO_ModalRetryProbe_${run}_${randomUUID().replace(/-/g, "")}`);
    const retry = await client.saveResource(worldPath);
    assert.equal(retry.outcome, "changed", "fresh retry did not complete a normal target save");
    await client.shutdownOwnedWorkbench();
    assert.deepEqual(await guard.listWorkbenchProcesses(), []);
  });
}

export async function runWorkbenchExplicitSaveAcceptance(options: {
  readonly configPath: string;
  readonly confirmed: boolean;
  readonly modalRuns?: number;
  readonly environment?: NodeJS.ProcessEnv;
}): Promise<void> {
  assertAuthorized(options.confirmed, options.environment ?? process.env);
  const baseConfig = loadAcceptanceBaseConfig(options.configPath);
  await runHappySaveCase(options.configPath, baseConfig, "happy-before-modal");
  await runPrefabIntegrityCase(options.configPath, baseConfig);
  const modalRuns = options.modalRuns ?? 1;
  for (let run = 1; run <= modalRuns; run += 1) {
    await runForcedNativeModalCase(options.configPath, baseConfig, run);
  }
  await runHappySaveCase(options.configPath, baseConfig, "happy-after-modal");
}

function usage(): string {
  return [
    "Usage: npm run dev:workbench:acceptance:explicit-save -- --config <file> --confirm-live-run [--modal-runs <positive integer>]",
    `Required environment confirmation: ${LIVE_WORKBENCH_EXPLICIT_SAVE_ENVIRONMENT}=1`,
  ].join("\n");
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!parsed.configPath) throw new Error("--config is required");
  await runWorkbenchExplicitSaveAcceptance({
    configPath: parsed.configPath,
    confirmed: parsed.confirmed,
    modalRuns: parsed.modalRuns,
  });
  process.stdout.write("Workbench explicit target save acceptance passed with final process vacancy.\n");
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryPoint) {
  main().catch((error) => {
    process.stderr.write(`Workbench explicit-save acceptance failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
