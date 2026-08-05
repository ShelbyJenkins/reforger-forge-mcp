import { randomUUID } from "node:crypto";
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
import { registerWbBuild } from "./tools/wb-build.js";
import { registerWbCheck } from "./tools/wb-check.js";
import { registerWbLogQuery } from "./tools/wb-log-query.js";
import { registerWbConnect } from "./tools/wb-connect.js";
import { registerWbDiagnose } from "./tools/wb-diagnose.js";
import { registerWbReload } from "./tools/wb-reload.js";
import { registerWbRestart } from "./tools/wb-restart.js";
import { registerWbShutdown } from "./tools/wb-shutdown.js";
import { registerWbSaveResource } from "./tools/wb-save-resource.js";
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
import {
  createMcpHostIdentity,
  validateMcpHostIdentity,
  type McpHostIdentity,
} from "./mcp-host-identity.js";

/**
 * Explicit application shutdown contract returned by {@link registerTools}.
 * Embedders must await this disposer before closing their MCP server so owned
 * observer runtime lifecycle state can be sealed through supported APIs.
 */
export interface RegisteredToolsDisposer {
  (deadlineAtMs?: number): Promise<Record<string, unknown>>;
  /** CLI-only synchronous crash path; never terminates Workbench or runtimes. */
  emergencyTerminate(): void;
  /** Starts idempotent local handle cleanup before the CLI exits. */
  emergencyCleanup(): void;
}

export interface RegisterToolsOptions {
  /** Internal composition seam used by lifecycle probes and hermetic tests. */
  searchEngine?: SearchEngine;
  /** One trusted process-wide identity shared by all lifecycle subsystems. */
  hostIdentity?: McpHostIdentity;
}

/**
 * The process-wide Workbench lifecycle object graph owned by the MCP server.
 * Keeping construction here makes it impossible for tool registrars or the
 * observer adapter to accidentally create a second observer application.
 */
export interface WorkbenchServerComposition {
  readonly hostIdentity: McpHostIdentity;
  readonly processGuard: WorkbenchProcessGuard;
  readonly netApi: WorkbenchNetApiClient;
  readonly activityGate: WorkbenchActivityGate;
  readonly childSupervisor: ChildSupervisor;
  readonly companionProvider: WorkbenchCompanionProvider;
  readonly lifecycleExecution: WorkbenchLifecycleExecutionPort;
  readonly diagnostics: typeof diagnoseWorkbench;
  readonly client: WorkbenchSessionController;
}

function fallbackHostIdentity(): McpHostIdentity {
  return createMcpHostIdentity({
    clientLabel: "manual",
    instanceId: randomUUID(),
  });
}

export function createWorkbenchServerComposition(
  config: Config,
  hostIdentity: McpHostIdentity = fallbackHostIdentity()
): WorkbenchServerComposition {
  const trustedHostIdentity = validateMcpHostIdentity(hostIdentity);
  const observerConfig = config.observer;
  const processGuard = new WorkbenchProcessGuard({
    mcpInstanceId: trustedHostIdentity.instanceId,
  });
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
      hostIdentity: trustedHostIdentity,
    }
  );

  return Object.freeze({
    hostIdentity: trustedHostIdentity,
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

export function registerTools(
  server: McpServer,
  config: Config,
  options: RegisterToolsOptions = {}
): RegisteredToolsDisposer {
  const hostIdentity = options.hostIdentity === undefined
    ? fallbackHostIdentity()
    : validateMcpHostIdentity(options.hostIdentity);
  const searchEngine = options.searchEngine ?? new SearchEngine(config.dataDir);
  const patterns = new PatternLibrary(config.patternsDir);
  const observerConfig = config.observer;
  const workbenchComposition = createWorkbenchServerComposition(config, hostIdentity);
  const wbClient = workbenchComposition.client;

  // Phase 0 tools
  registerApiSearch(server, searchEngine);
  registerComponentSearch(server, searchEngine);
  registerWikiSearch(server, searchEngine);
  registerWikiRead(server, searchEngine);
  registerProject(server, wbClient);

  // Phase 1 tools
  registerMod(server, config, searchEngine, patterns, wbClient);
  registerScriptCreate(server, config, searchEngine, wbClient);
  registerPrefab(server, config, wbClient);

  // Phase 3 tools
  registerConfigCreate(server, config, wbClient);
  registerServerConfig(server, config, wbClient);
  registerLayoutCreate(server, config, wbClient);

  // Workbench Live Control tools (Phase 4)
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
    gamePath: config.gamePath,
    startupTimeoutMs: observerConfig?.startupTimeoutMs,
    requestTimeoutMs: observerConfig?.requestTimeoutMs,
    defaultCaptureTimeoutMs: observerConfig?.defaultCaptureTimeoutMs,
    maxInlineImageBytes: observerConfig?.maxInlineImageBytes,
    defaultLossyImageQuality: observerConfig?.defaultLossyImageQuality,
    minimumLossyImageQuality: observerConfig?.minimumLossyImageQuality,
    maximumLossyImageQuality: observerConfig?.maximumLossyImageQuality,
    retentionIntervalMs: observerConfig?.retentionIntervalMs,
    retentionMaxAgeMs: observerConfig?.retentionMaxAgeMs,
    retentionMaxBytes: observerConfig?.retentionMaxBytes,
    evidenceRoots: observerConfig?.evidenceRoots,
    supportingLogRoots: observerConfig?.supportingLogRoots,
    workbenchAdapter: workbenchObserver,
    hostIdentity,
  });
  const ownedRuntimeManager = observerApplication.ownedRuntimeManager!;
  registerObserverTools(server, observerApplication, {
    sessionTtlMs: observerConfig?.sessionTtlMs,
    defaultCaptureTimeoutMs: observerConfig?.defaultCaptureTimeoutMs,
    workbenchClient: wbClient,
    workbenchAddonDirs: config.workbenchAddonDirs,
    evidenceRoots: observerConfig?.evidenceRoots,
    ownedRuntimeManager,
  });
  let activeObserverShutdown: Promise<Record<string, unknown>> | null = null;
  let terminalObserverShutdown: Record<string, unknown> | null = null;
  let processGuardClose: Promise<void> | null = null;
  const closeProcessGuard = (): Promise<void> => {
    if (!processGuardClose) {
      const attempt = workbenchComposition.processGuard.close();
      let tracked!: Promise<void>;
      tracked = attempt.catch((error) => {
        if (processGuardClose === tracked) processGuardClose = null;
        throw error;
      });
      processGuardClose = tracked;
    }
    return processGuardClose;
  };
  const disposeObserverAttempt = (deadlineAtMs?: number): Promise<Record<string, unknown>> => {
    if (terminalObserverShutdown) return Promise.resolve(terminalObserverShutdown);
    if (activeObserverShutdown) return activeObserverShutdown;
    const attempt = (async () => {
      await wbClient.closeOwnerScopedTargetBuild();
      const result = await observerApplication.closeRuntimeLifecycle(deadlineAtMs);
      if (result.applicationCloseSafe === true) {
        await closeProcessGuard();
        terminalObserverShutdown = result;
      }
      return result;
    })();
    let tracked!: Promise<Record<string, unknown>>;
    tracked = attempt.finally(() => {
      if (activeObserverShutdown === tracked) activeObserverShutdown = null;
    });
    activeObserverShutdown = tracked;
    return tracked;
  };
  const disposeObserverLifecycle = Object.assign(disposeObserverAttempt, {
    emergencyTerminate: (): void => observerApplication.emergencyTerminatePrivateChildren(),
    emergencyCleanup: (): void => { void closeProcessGuard().catch(() => undefined); },
  }) satisfies RegisteredToolsDisposer;
  registerWbLaunch(server, wbClient);
  registerWbBuild(server, config, wbClient, {
    companionProvider: workbenchComposition.companionProvider,
    managedRoot: observerConfig?.managedRoot ?? defaultWorkbenchHelperManagedRoot(),
    processGuard: workbenchComposition.processGuard,
  });
  registerWbCheck(server, config, wbClient, {
    managedRoot: observerConfig?.managedRoot ?? defaultWorkbenchHelperManagedRoot(),
    processGuard: workbenchComposition.processGuard,
  });
  registerWbLogQuery(server, config);
  registerWbConnect(server, wbClient);
  registerWbDiagnose(server, wbClient);
  registerWbReload(server, wbClient);
  registerWbRestart(server, wbClient);
  registerWbShutdown(server, wbClient);
  registerWbSaveResource(server, config, wbClient);
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
  registerScenarioCreate(server, config, wbClient);

  // Base game access tools
  registerGameBrowse(server, config);
  registerGameRead(server, config);
  registerAssetSearch(server, config);
  registerGameDuplicate(server, config, wbClient);
  registerWbEntityDuplicate(server, config, wbClient);
  registerWorkshopInfo(server, wbClient);
  registerAnimationGraph(server, config, wbClient);
  registerWbKnowledge(server);
  registerBuildingSetup(server, config, wbClient);

  // MCP Prompts
  registerCreateModPrompt(server, patterns);
  registerModifyModPrompt(server);

  // MCP Resources
  registerClassResource(server, searchEngine);
  registerPatternResource(server, patterns);
  registerGroupResource(server, searchEngine);
  return disposeObserverLifecycle;
}
