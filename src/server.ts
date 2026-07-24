import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerApiSearch } from "./tools/api-search.js";
import { registerComponentSearch } from "./tools/component-search.js";
import { registerWikiSearch } from "./tools/wiki-search.js";
import { registerWikiRead } from "./tools/wiki-read.js";
import { registerProject } from "./tools/project.js";
import { registerScriptCreate } from "./tools/script-create.js";
import { registerPrefab } from "./tools/prefab.js";
import { registerMod } from "./tools/mod.js";
import { registerConfigCreate } from "./tools/config-create.js";
import { registerServerConfig } from "./tools/server-config.js";
import { registerLayoutCreate } from "./tools/layout-create.js";
import { registerCreateModPrompt } from "./prompts/create-mod.js";
import { registerModifyModPrompt } from "./prompts/modify-mod.js";
import { registerClassResource } from "./resources/class-resource.js";
import { registerPatternResource } from "./resources/pattern-resource.js";
import { registerGroupResource } from "./resources/group-resource.js";
import { SearchEngine } from "./index/search-engine.js";
import { PatternLibrary } from "./patterns/loader.js";
import { ChildSupervisor } from "./foundation/child-supervisor.js";
import { WorkbenchActivityGate } from "./workbench/activity-gate.js";
import { WorkbenchNetApiClient } from "./workbench/net-api-client.js";
import { WorkbenchProcessGuard } from "./workbench/process-guard.js";
import { WorkbenchSessionController } from "./workbench/session-controller.js";
import type { WorkbenchLifecycleExecutionPort } from "./workbench/lifecycle-execution.js";
import { diagnoseWorkbench } from "./workbench/diagnostics.js";
import {
  WorkbenchHelperStager,
  defaultWorkbenchHelperManagedRoot,
  type WorkbenchCompanionProvider,
} from "./workbench/helper-addon.js";
import { WorkbenchObserverAdapter } from "./workbench/observer-adapter.js";
import { registerWbLaunch } from "./tools/wb-launch.js";
import { registerWbConnect } from "./tools/wb-connect.js";
import { registerWbDiagnose } from "./tools/wb-diagnose.js";
import { registerWbReload } from "./tools/wb-reload.js";
import { registerWbRestart } from "./tools/wb-restart.js";
import { registerWbShutdown } from "./tools/wb-shutdown.js";
import { registerWbEditorTools } from "./tools/wb-editor.js";
import { registerWbEntityTools } from "./tools/wb-entities.js";
import { registerWbComponent } from "./tools/wb-components.js";
import { registerWbTerrain } from "./tools/wb-terrain.js";
import { registerWbLayers } from "./tools/wb-layers.js";
import { registerWbResources } from "./tools/wb-resources.js";
import { registerWbPrefabs } from "./tools/wb-prefabs.js";
import { registerWbClipboard } from "./tools/wb-clipboard.js";
import { registerWbScriptEditor } from "./tools/wb-script-editor.js";
import { registerWbLocalization } from "./tools/wb-localization.js";
import { registerWbProjects } from "./tools/wb-projects.js";
import { registerWbValidate } from "./tools/wb-validate.js";
import { registerWbState } from "./tools/wb-state.js";
import { registerGameBrowse } from "./tools/game-browse.js";
import { registerGameRead } from "./tools/game-read.js";
import { registerAssetSearch } from "./tools/asset-search.js";
import { registerGameDuplicate } from "./tools/game-duplicate.js";
import { registerWbEntityDuplicate } from "./tools/wb-entity-duplicate.js";
import { registerWorkshopInfo } from "./tools/workshop-info.js";
import { registerScenarioTools } from "./tools/wb-scenario.js";
import { registerScenarioCreate } from "./tools/scenario-create.js";
import { registerAnimationGraph } from "./tools/animation-graph.js";
import { registerWbKnowledge } from "./tools/wb-knowledge.js";
import { registerBuildingSetup } from "./tools/building-setup.js";
import type { Config } from "./config.js";
import { createObserverApplication } from "./observer/application.js";
import { registerObserverTools } from "./observer/tools.js";

/**
 * Explicit application shutdown contract returned by {@link registerTools}.
 * Embedders must await this disposer before closing their MCP server so owned
 * observer runtime lifecycle state can be sealed through supported APIs.
 */
export type RegisteredToolsDisposer = () => Promise<Record<string, unknown>>;

/**
 * The process-wide Workbench lifecycle object graph owned by the MCP server.
 * Keeping construction here makes it impossible for tool registrars or the
 * observer adapter to accidentally create a second observer application.
 */
export interface WorkbenchServerComposition {
  readonly processGuard: WorkbenchProcessGuard;
  readonly netApi: WorkbenchNetApiClient;
  readonly activityGate: WorkbenchActivityGate;
  readonly childSupervisor: ChildSupervisor;
  readonly companionProvider: WorkbenchCompanionProvider;
  readonly lifecycleExecution: WorkbenchLifecycleExecutionPort;
  readonly diagnostics: typeof diagnoseWorkbench;
  readonly client: WorkbenchSessionController;
}

export function createWorkbenchServerComposition(config: Config): WorkbenchServerComposition {
  const observerConfig = config.observer;
  const processGuard = new WorkbenchProcessGuard();
  const netApi = new WorkbenchNetApiClient(config.workbenchHost, config.workbenchPort);
  const activityGate = new WorkbenchActivityGate();
  const childSupervisor = new ChildSupervisor();
  const companionProvider = new WorkbenchHelperStager({
    managedRoot: observerConfig?.managedRoot ?? defaultWorkbenchHelperManagedRoot(),
  });
  const lifecycleExecution = WorkbenchSessionController.composeLifecycleExecution({
    processGuard,
    childSupervisor,
  });
  const diagnostics = diagnoseWorkbench;
  const client = new WorkbenchSessionController(
    config.workbenchHost,
    config.workbenchPort,
    config,
    undefined,
    processGuard,
    {
      companionProvider,
      netApi,
      activityGate,
      childSupervisor,
      lifecycleExecution,
      diagnostics,
    }
  );

  return Object.freeze({
    processGuard,
    netApi,
    activityGate,
    childSupervisor,
    companionProvider,
    lifecycleExecution,
    diagnostics,
    client,
  });
}

export function registerTools(server: McpServer, config: Config): RegisteredToolsDisposer {
  const searchEngine = new SearchEngine(config.dataDir);
  const patterns = new PatternLibrary(config.patternsDir);

  // Phase 0 tools
  registerApiSearch(server, searchEngine);
  registerComponentSearch(server, searchEngine);
  registerWikiSearch(server, searchEngine);
  registerWikiRead(server, searchEngine);
  registerProject(server, config);

  // Phase 1 tools
  registerMod(server, config, searchEngine, patterns);
  registerScriptCreate(server, config, searchEngine);
  registerPrefab(server, config);

  // Phase 3 tools
  registerConfigCreate(server, config);
  registerServerConfig(server, config);
  registerLayoutCreate(server, config);

  // Workbench Live Control tools (Phase 4)
  const observerConfig = config.observer;
  const workbenchComposition = createWorkbenchServerComposition(config);
  const wbClient = workbenchComposition.client;
  // The observer adapter deliberately shares the one Workbench client and its
  // lifecycle/activity gate with every other Workbench tool. It never owns an
  // independent connection or auto-launch path.
  const workbenchObserver = new WorkbenchObserverAdapter(wbClient, {
    handlerTimeoutMs: observerConfig?.requestTimeoutMs,
  });
  const observerApplication = createObserverApplication({
    debug: config.debug,
    agentPath: observerConfig?.agentPath,
    managedRoot: observerConfig?.managedRoot,
    profileRoot: observerConfig?.profileRoot,
    projectPath: config.projectPath,
    gamePath: config.gamePath,
    startupTimeoutMs: observerConfig?.startupTimeoutMs,
    requestTimeoutMs: observerConfig?.requestTimeoutMs,
    defaultCaptureTimeoutMs: observerConfig?.defaultCaptureTimeoutMs,
    maxInlineImageBytes: observerConfig?.maxInlineImageBytes,
    retentionIntervalMs: observerConfig?.retentionIntervalMs,
    retentionMaxAgeMs: observerConfig?.retentionMaxAgeMs,
    retentionMaxBytes: observerConfig?.retentionMaxBytes,
    evidenceRoots: observerConfig?.evidenceRoots,
    supportingLogRoots: observerConfig?.supportingLogRoots,
    workbenchAdapter: workbenchObserver,
  });
  const ownedRuntimeManager = observerApplication.ownedRuntimeManager!;
  registerObserverTools(server, observerApplication, {
    sessionTtlMs: observerConfig?.sessionTtlMs,
    defaultCaptureTimeoutMs: observerConfig?.defaultCaptureTimeoutMs,
    workbenchClient: wbClient,
    projectPath: config.projectPath,
    ownedRuntimeManager,
  });
  let observerShutdown: Promise<Record<string, unknown>> | null = null;
  const disposeObserverLifecycle = (): Promise<Record<string, unknown>> => {
    // Seal owned-runtime lifecycle state, then always release the Workbench
    // process guard's LMDB environment. The composition's guard is otherwise
    // never closed on the embedded-server disposal path, leaking its handle
    // (and, on Windows, the memory map) until process exit.
    observerShutdown ??= (async () => {
      try {
        return await observerApplication.closeRuntimeLifecycle();
      } finally {
        await workbenchComposition.processGuard.close();
      }
    })();
    return observerShutdown;
  };
  registerWbLaunch(server, config, wbClient);
  registerWbConnect(server, wbClient);
  registerWbDiagnose(server, wbClient);
  registerWbReload(server, wbClient);
  registerWbRestart(server, wbClient);
  registerWbShutdown(server, wbClient);
  registerWbEditorTools(server, wbClient);
  registerWbEntityTools(server, wbClient);
  registerWbComponent(server, wbClient);
  registerWbTerrain(server, wbClient);
  registerWbLayers(server, wbClient);
  registerWbResources(server, wbClient);
  registerWbPrefabs(server, wbClient);
  registerWbClipboard(server, wbClient);
  registerWbScriptEditor(server, wbClient);
  registerWbLocalization(server, wbClient);
  registerWbProjects(server, wbClient);
  registerWbValidate(server, wbClient);
  registerWbState(server, wbClient);
  registerScenarioTools(server, wbClient);
  registerScenarioCreate(server, config);

  // Base game access tools
  registerGameBrowse(server, config);
  registerGameRead(server, config);
  registerAssetSearch(server, config);
  registerGameDuplicate(server, config, wbClient);
  registerWbEntityDuplicate(server, config, wbClient);
  registerWorkshopInfo(server, config);
  registerAnimationGraph(server, config);
  registerWbKnowledge(server);
  registerBuildingSetup(server, config);

  // MCP Prompts
  registerCreateModPrompt(server, patterns);
  registerModifyModPrompt(server);

  // MCP Resources
  registerClassResource(server, searchEngine);
  registerPatternResource(server, patterns);
  registerGroupResource(server, searchEngine);
  return disposeObserverLifecycle;
}
