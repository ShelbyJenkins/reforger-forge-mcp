/**
 * Read-only Workbench configuration, companion, NET API, and lifecycle diagnostics.
 *
 * This module intentionally receives only a lifecycle reader and a NET call
 * callback. It has no staging, retention, ownership, spawn, or termination
 * authority.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  MCP_IDLE_SHUTDOWN_DEFAULT_MS,
  type Config,
} from "../config.js";
import {
  externallyManagedMcpLifecycleDiagnostic,
  type McpLifecycleDiagnostic,
} from "../mcp-idle-shutdown.js";
import {
  validateMcpHostIdentity,
  type McpHostIdentity,
} from "../mcp-host-identity.js";
import {
  WORKBENCH_HELPER_ADDON_GUID,
  WORKBENCH_HELPER_ADDON_ID,
  WORKBENCH_HELPER_ADDON_VERSION,
  WORKBENCH_HELPER_BUILD_IDENTITY,
  WORKBENCH_HELPER_PROTOCOL_VERSION,
  defaultWorkbenchHelperSource,
  verifyWorkbenchHelperSource,
} from "./helper-addon.js";
import type { LifecycleStateRead, WorkbenchProcessGuard } from "./process-guard.js";
import type { WorkbenchCompileFailure } from "./compile-diagnostics.js";

const WORKBENCH_EXE = "ArmaReforgerWorkbenchSteamDiag.exe";
const WORKBENCH_SUBDIR = "Workbench";

/**
 * Enough of the recorded lease to identify the owning MCP session without
 * exposing secrets or requiring an operator to hunt for an OS process to kill.
 */
export interface LifecycleLeaseOwnerDiagnostic {
  pid: number;
  instanceId: string;
  leaseId: string;
  claimedAtMs: number;
}

export interface LifecycleDiagnostic {
  state: "missing" | "valid" | "malformed";
  version: number | null;
  generation: string | null;
  phase: string | null;
  endpoint: string | null;
  target: string | null;
  lease: "current_mcp" | "other_mcp" | "vacant" | "unknown";
  leaseOwner: LifecycleLeaseOwnerDiagnostic | null;
  /**
   * Whether the durable record is quiescent enough for another MCP to preempt
   * the lease. This reports the recorded preconditions only; an actual claim
   * additionally proves that no Workbench process exists and that the NET API
   * endpoint is vacant.
   */
  leasePreemptible: boolean;
  operation: string | null;
  companionBuildIdentity: string | null;
  detail?: string;
}

export interface DiagnosticReport {
  mcpHost: McpHostIdentity;
  mcpLifecycle: McpLifecycleDiagnostic;
  host: string;
  port: number;
  workbenchExe: { path: string; exists: boolean } | null;
  companionAddon: {
    addonId: string;
    addonGuid: string;
    path: string;
    buildIdentity: string;
    bundleDigest: string;
  } | null;
  netApi: "up_with_companion" | "up_no_companion" | "refused" | "timeout" | "error";
  netApiError?: string;
  lifecycle: LifecycleDiagnostic;
  /** Exact owner-attributed compiler failure retained by this MCP launch session. */
  lastLaunchFailure?: WorkbenchCompileFailure;
}

export interface WorkbenchDiagnosticNetError {
  readonly code: string;
  readonly message: string;
}

export interface WorkbenchDiagnosticOptions {
  readonly hostIdentity: McpHostIdentity;
  readonly host: string;
  readonly port: number;
  readonly config?: Config;
  readonly mcpLifecycle?: () => McpLifecycleDiagnostic;
  readonly lifecycle: Pick<WorkbenchProcessGuard, "mcpInstanceId" | "readLifecycleState">;
  readonly callNetApi: <T = Record<string, unknown>>(
    apiFunc: string,
    params: Record<string, unknown>,
    options: { timeout: number; skipAutoLaunch: true }
  ) => Promise<T>;
  /** Preserve the caller's public error classification without importing it here. */
  readonly classifyNetError: (error: unknown) => WorkbenchDiagnosticNetError | null;
}

function workbenchExecutable(config: Config): string {
  const candidates = [
    join(config.workbenchPath, WORKBENCH_SUBDIR, WORKBENCH_EXE),
    join(config.workbenchPath, WORKBENCH_EXE),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function emptyLifecycleDiagnostic(
  state: "missing" | "malformed",
  lease: "vacant" | "unknown",
  detail?: string
): LifecycleDiagnostic {
  return {
    state,
    version: null,
    generation: null,
    phase: null,
    endpoint: null,
    target: null,
    lease,
    leaseOwner: null,
    // A missing record is claimable; a malformed one is never assumed to be.
    leasePreemptible: state === "missing",
    operation: null,
    companionBuildIdentity: null,
    ...(detail === undefined ? {} : { detail }),
  };
}

/** Convert a lifecycle state read into the stable public diagnostic shape. */
export function formatLifecycleDiagnostic(
  read: LifecycleStateRead,
  currentMcpInstanceId: string
): LifecycleDiagnostic {
  if (read.kind === "missing") {
    return emptyLifecycleDiagnostic("missing", "vacant");
  }
  if (read.kind === "malformed") {
    return emptyLifecycleDiagnostic("malformed", "unknown", read.message);
  }

  const state = read.state;
  return {
    state: "valid",
    version: 3,
    generation: state.generation,
    phase: state.phase,
    endpoint: `${state.endpoint.host}:${state.endpoint.port}`,
    target: state.target?.path ?? null,
    lease: !state.mcpOwner
      ? "vacant"
      : state.mcpOwner.instanceId === currentMcpInstanceId
        ? "current_mcp"
        : "other_mcp",
    leaseOwner: state.mcpOwner
      ? {
          pid: state.mcpOwner.pid,
          instanceId: state.mcpOwner.instanceId,
          leaseId: state.mcpOwner.leaseId,
          claimedAtMs: state.mcpOwner.claimedAtMs,
        }
      : null,
    leasePreemptible: state.phase === "vacant" && state.workbench === null &&
      state.operation === null,
    operation: state.operation ? `${state.operation.kind}:${state.operation.operationId}` : null,
    companionBuildIdentity: state.companion?.buildIdentity ?? null,
  };
}

/** Read lifecycle evidence without locking, claiming, reconciling, or writing it. */
export async function diagnoseLifecycle(
  lifecycle: Pick<WorkbenchProcessGuard, "mcpInstanceId" | "readLifecycleState">
): Promise<LifecycleDiagnostic> {
  try {
    return formatLifecycleDiagnostic(
      await lifecycle.readLifecycleState(),
      lifecycle.mcpInstanceId
    );
  } catch (error) {
    return emptyLifecycleDiagnostic(
      "malformed",
      "unknown",
      error instanceof Error ? error.message : String(error)
    );
  }
}

/** Produce the historical Workbench diagnostic report without lifecycle mutation. */
export async function diagnoseWorkbench(
  options: WorkbenchDiagnosticOptions
): Promise<DiagnosticReport> {
  const hostIdentity = validateMcpHostIdentity(options.hostIdentity);
  const workbenchExePath = options.config ? workbenchExecutable(options.config) : null;
  let companionAddon: DiagnosticReport["companionAddon"] = null;
  try {
    const verified = verifyWorkbenchHelperSource(defaultWorkbenchHelperSource());
    companionAddon = {
      addonId: verified.manifest.addonId,
      addonGuid: verified.manifest.addonGuid,
      path: verified.sourceDirectory,
      buildIdentity: verified.manifest.buildIdentity,
      bundleDigest: verified.manifest.bundleDigest,
    };
  } catch {
    // Diagnostics are read-only and best-effort; launch reports the exact stage error.
  }

  let netApi: DiagnosticReport["netApi"] = "refused";
  let netApiError: string | undefined;
  try {
    const response = await options.callNetApi<Record<string, unknown>>(
      "EMCP_WB_Ping",
      {},
      { timeout: 3000, skipAutoLaunch: true }
    );
    if (response.status === "ok" &&
        response.helperAddonId === WORKBENCH_HELPER_ADDON_ID &&
        response.helperAddonGuid === WORKBENCH_HELPER_ADDON_GUID &&
        response.helperAddonVersion === WORKBENCH_HELPER_ADDON_VERSION &&
        response.helperProtocolVersion === WORKBENCH_HELPER_PROTOCOL_VERSION &&
        response.workbenchProtocol === WORKBENCH_HELPER_PROTOCOL_VERSION &&
        response.helperBuildIdentity === WORKBENCH_HELPER_BUILD_IDENTITY) {
      netApi = "up_with_companion";
    } else {
      netApi = "up_no_companion";
      netApiError = "NET API responded without the exact managed Workbench companion identity.";
    }
  } catch (error) {
    const classified = options.classifyNetError(error);
    if (classified) {
      netApiError = classified.message;
      if (classified.code === "CONNECTION_REFUSED") netApi = "refused";
      else if (classified.code === "TIMEOUT") netApi = "timeout";
      else if (classified.code === "API_ERROR" &&
        (classified.message.includes("not existing Net API function") ||
          classified.message.includes("Undefined API func"))) {
        netApi = "up_no_companion";
      } else {
        netApi = "error";
      }
    } else {
      netApi = "error";
      netApiError = String(error);
    }
  }

  return {
    mcpHost: hostIdentity,
    mcpLifecycle: options.mcpLifecycle?.() ?? externallyManagedMcpLifecycleDiagnostic(
      hostIdentity,
      options.config?.mcpIdleShutdownMs ?? MCP_IDLE_SHUTDOWN_DEFAULT_MS,
    ),
    host: options.host,
    port: options.port,
    workbenchExe: workbenchExePath
      ? { path: workbenchExePath, exists: existsSync(workbenchExePath) }
      : null,
    companionAddon,
    netApi,
    netApiError,
    lifecycle: await diagnoseLifecycle(options.lifecycle),
  };
}
