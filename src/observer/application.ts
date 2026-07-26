import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedOption, type BoundedOptionErrorFactory } from "../foundation/bounded-option.js";
import { canonicalizePotentialPath, isPathContained } from "../foundation/managed-path.js";
import { redactDiagnostic, redactText } from "../foundation/redact.js";
import { logger } from "../utils/logger.js";
import type { WorkbenchObserverAdapter } from "../workbench/observer-adapter.js";
import { ObserverAgentClient, type ObserverAgentClientOptions, type ObserverChildDescriptor, redactChildLine } from "./agent-client.js";
import type { CaptureInput, CaptureResult } from "./capture-contract.js";
import { CaptureService } from "./capture-service.js";
import { ObserverCoordinatorError } from "./errors.js";
import { EvidenceRunService } from "./evidence-run-service.js";
import { ObserverHostDiagnostics } from "./host-diagnostics.js";
import {
  OwnedRuntimeError,
  OwnedRuntimeManager,
  type OwnedRuntimeLifecycleAuthority,
  type OwnedRuntimeLifecycleIdentity,
  type RuntimeStopPreflight,
} from "./owned-runtime-manager.js";
import { RuntimeCaptureBackend } from "./runtime-capture-backend.js";
import { WorkbenchCaptureBackend } from "./workbench-capture-backend.js";
import { assertWorldRevision } from "./world-revision.js";

export interface ObserverInstanceQuery {
  sessionId?: string;
  requiredCapabilities?: string[];
  renderersOnly?: boolean;
  waitMs?: number;
  signal?: AbortSignal;
}

export interface ObserverInstanceList {
  instances: Array<Record<string, unknown>>;
  compatibleCount: number;
  waitedMs: number;
  timedOut: boolean;
  warnings?: string[];
}

export type ObserverCaptureView = CaptureInput["view"];

export interface ObserverCaptureInput extends Omit<CaptureInput, "expectedWorldRevision"> {
  expectedWorldRevision?: string;
}

export type ObserverCaptureResult =
  | { asynchronous: true; job: Record<string, unknown> }
  | { asynchronous: false; job: Record<string, unknown>; image: Buffer; metadata: Record<string, unknown> };

export interface CreateObserverApplicationOptions {
  debug?: boolean;
  agentPath?: string;
  managedRoot?: string;
  profileRoot?: string;
  projectPath?: string;
  gamePath?: string;
  sourceAddon?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Optional absolute cap applied to observer-agent startup and requests. */
  requestDeadlineAtMs?: () => number | undefined;
  defaultCaptureTimeoutMs?: number;
  maxInlineImageBytes?: number;
  retentionIntervalMs?: number;
  retentionMaxAgeMs?: number;
  retentionMaxBytes?: number;
  privateChildSweepIntervalMs?: number;
  privateChildSessionTerminalRetentionMs?: number;
  evidenceRoots?: string[];
  supportingLogRoots?: string[];
  pollIntervalMs?: number;
  forkChild?: ObserverAgentClientOptions["forkChild"];
  workbenchAdapter?: Pick<WorkbenchObserverAdapter,
    "instances" | "submit" | "recover" | "status" | "cancel" | "release" | "readCompletedArtifact" | "restoreAll">;
  defaultManagedRoot?: string;
}

export interface ObserverApplication {
  readonly maxInlineImageBytes: number;
  readonly defaultCaptureTimeoutMs: number;
  readonly agentClient: ObserverAgentClient;
  readonly captureService: CaptureService;
  readonly evidenceRuns: EvidenceRunService;
  readonly ownedRuntimeManager?: OwnedRuntimeManager;
  readonly child: unknown;
  diagnosticPrivateChildCount(): number;
  ensureStarted(): Promise<ObserverChildDescriptor>;
  status(): Promise<Record<string, unknown>>;
  doctor(): Promise<Record<string, unknown>>;
  ensureSetup(): Promise<Record<string, unknown>>;
  uninstall(): Promise<Record<string, unknown>>;
  prepareLaunch(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  revokeSession(sessionId: string): Promise<Record<string, unknown>>;
  retainRuntimeLifecycle(sessionId: string, runtimeId: string, generation: string, authority: OwnedRuntimeLifecycleAuthority): Promise<Record<string, unknown>>;
  releaseRuntimeLifecycle(sessionId: string, runtimeId: string, generation: string): Promise<Record<string, unknown>>;
  reserveRuntimeStop(sessionId: string, reservationId: string, exactRuntimeVacant?: boolean, lifecycle?: OwnedRuntimeLifecycleIdentity): Promise<RuntimeStopPreflight>;
  releaseRuntimeStop(sessionId: string, reservationId: string, lifecycle?: OwnedRuntimeLifecycleIdentity): Promise<Record<string, unknown>>;
  completeRuntimeStop(sessionId: string, reservationId?: string, exactRuntimeVacant?: boolean, lifecycle?: OwnedRuntimeLifecycleIdentity): Promise<Record<string, unknown>>;
  instances(query?: ObserverInstanceQuery): Promise<ObserverInstanceList>;
  capture(input: ObserverCaptureInput): Promise<ObserverCaptureResult>;
  beginRun(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  runStatus(runId: string): Promise<Record<string, unknown>>;
  finalizeRun(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  discardRun(runId: string): Promise<Record<string, unknown>>;
  jobStatus(sessionId: string | undefined, jobId: string): Promise<Record<string, unknown>>;
  cancelJob(sessionId: string | undefined, jobId: string): Promise<Record<string, unknown>>;
  releaseJob(sessionId: string | undefined, jobId: string): Promise<Record<string, unknown>>;
  readJob(sessionId: string | undefined, jobId: string): Promise<{ job: Record<string, unknown>; image: Buffer; metadata: Record<string, unknown> }>;
  closeRuntimeLifecycle(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

const optionError: BoundedOptionErrorFactory = ({ message }) => new ObserverCoordinatorError("INVALID_REQUEST", message);

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ObserverCoordinatorError("TRANSPORT_UNAVAILABLE", `${label} returned an invalid response`);
  }
  return value as Record<string, unknown>;
}

function defaultAgentPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "agent", "private-child.js");
}

export function defaultObserverManagedRoot(): string {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(localAppData, "ReforgerForge", "Observer", "v1");
}

function assertPaths(projectPath: string | undefined, managedRoot: string, profileRoot: string): void {
  if (!projectPath) return;
  const project = canonicalizePotentialPath(projectPath, { linkPolicy: "follow-existing", existingAncestor: "any", label: "Project path" });
  for (const [label, path] of [["managed root", managedRoot], ["profile root", profileRoot]] as const) {
    const candidate = canonicalizePotentialPath(path, { linkPolicy: "follow-existing", existingAncestor: "any", label: `Observer ${label}` });
    if (isPathContained(project, candidate) || isPathContained(candidate, project)) {
      throw new ObserverCoordinatorError("INVALID_REQUEST", `Observer ${label} must not overlap the configured project path`);
    }
  }
}

function validateRoots(label: string, roots: string[] | undefined): void {
  if (roots === undefined) return;
  if (!Array.isArray(roots) || roots.length > 64 || roots.some((root) => typeof root !== "string" || root.length < 1 || root.length > 32_768)) {
    throw new ObserverCoordinatorError("INVALID_REQUEST", `Observer ${label} configuration is invalid`);
  }
}

class DefaultObserverApplication implements ObserverApplication {
  readonly maxInlineImageBytes: number;
  readonly defaultCaptureTimeoutMs: number;
  readonly agentClient: ObserverAgentClient;
  readonly captureService: CaptureService;
  readonly evidenceRuns: EvidenceRunService;
  readonly ownedRuntimeManager?: OwnedRuntimeManager;
  private readonly diagnostics: ObserverHostDiagnostics;
  private readonly requestTimeoutMs: number;
  private readonly workbenchAdapter?: CreateObserverApplicationOptions["workbenchAdapter"];
  private closing = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: CreateObserverApplicationOptions) {
    const managedRoot = resolve(options.managedRoot ?? options.defaultManagedRoot ?? defaultObserverManagedRoot());
    const profileRoot = resolve(options.profileRoot ?? join(managedRoot, "profiles"));
    assertPaths(options.projectPath, managedRoot, profileRoot);
    validateRoots("evidence root", options.evidenceRoots);
    validateRoots("supporting log root", options.supportingLogRoots);
    this.requestTimeoutMs = boundedOption(options.requestTimeoutMs, 30_000, 1_000, 5 * 60_000, "Observer request timeout", optionError);
    this.defaultCaptureTimeoutMs = boundedOption(options.defaultCaptureTimeoutMs, 30_000, 1_000, 5 * 60_000, "Observer capture timeout", optionError);
    this.maxInlineImageBytes = boundedOption(options.maxInlineImageBytes, 8 * 1024 * 1024, 1_024, 64 * 1024 * 1024, "Observer inline image limit", optionError);
    const pollIntervalMs = boundedOption(options.pollIntervalMs, 200, 10, 5_000, "Observer poll interval", optionError);
    if (options.retentionIntervalMs !== undefined) boundedOption(options.retentionIntervalMs, options.retentionIntervalMs, 1_000, 24 * 60 * 60_000, "Observer retention interval", optionError);
    if (options.retentionMaxAgeMs !== undefined) boundedOption(options.retentionMaxAgeMs, options.retentionMaxAgeMs, 1_000, 5 * 365 * 24 * 60 * 60_000, "Observer retention maximum age", optionError);
    if (options.retentionMaxBytes !== undefined) boundedOption(options.retentionMaxBytes, options.retentionMaxBytes, 1_024 * 1_024, 64 * 1024 * 1024 * 1024, "Observer retention maximum bytes", optionError);

    const sourceAddon = options.sourceAddon ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "observer", "addon");
    const argumentsArray: string[] = [];
    const add = (name: string, value: string | number | undefined): void => { if (value !== undefined) argumentsArray.push(name, String(value)); };
    add("--root", managedRoot);
    add("--profile-root", profileRoot);
    add("--source-addon", sourceAddon);
    add("--retention-interval-ms", options.retentionIntervalMs);
    add("--retention-max-age-ms", options.retentionMaxAgeMs);
    add("--retention-max-bytes", options.retentionMaxBytes);
    add("--sweep-interval-ms", options.privateChildSweepIntervalMs);
    add("--session-terminal-retention-ms", options.privateChildSessionTerminalRetentionMs);
    if (options.debug) argumentsArray.push("--debug");
    for (const root of options.evidenceRoots ?? []) add("--evidence-root", root);
    for (const root of options.supportingLogRoots ?? []) add("--supporting-log-root", root);
    this.agentClient = new ObserverAgentClient({
      agentPath: options.agentPath ?? defaultAgentPath(),
      arguments: argumentsArray,
      startupTimeoutMs: options.startupTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
      requestDeadlineAtMs: options.requestDeadlineAtMs,
      forkChild: options.forkChild,
    });
    this.diagnostics = new ObserverHostDiagnostics(this.agentClient, managedRoot, profileRoot, sourceAddon, this.requestTimeoutMs);
    this.workbenchAdapter = options.workbenchAdapter;
    const backends = [new RuntimeCaptureBackend(this.agentClient, { maxInlineImageBytes: this.maxInlineImageBytes })];
    if (options.workbenchAdapter) backends.push(new WorkbenchCaptureBackend(options.workbenchAdapter) as never);
    let captureService!: CaptureService;
    this.evidenceRuns = new EvidenceRunService(this.agentClient, async (run) => captureService.convergeRun(run));
    captureService = new CaptureService({
      backends,
      runPort: this.evidenceRuns,
      defaultTimeoutMs: this.defaultCaptureTimeoutMs,
      pollIntervalMs,
      maxInlineImageBytes: this.maxInlineImageBytes,
    });
    this.captureService = captureService;
    if (options.gamePath) {
      this.ownedRuntimeManager = new OwnedRuntimeManager({
        managedRoot,
        gamePath: options.gamePath,
        ...(options.projectPath ? { projectPath: options.projectPath } : {}),
        observerGate: this,
      });
    }
  }

  get child(): unknown { return this.agentClient.childProcess; }
  diagnosticPrivateChildCount(): number { return this.agentClient.diagnosticPrivateChildCount(); }
  ensureStarted(): Promise<ObserverChildDescriptor> { return this.agentClient.ensureStarted(); }
  status(): Promise<Record<string, unknown>> { return this.diagnostics.inspect("status", this.closing, this.closed); }
  doctor(): Promise<Record<string, unknown>> { return this.diagnostics.inspect("doctor", this.closing, this.closed); }
  async ensureSetup(): Promise<Record<string, unknown>> { return asRecord(await this.request("stage", {}), "Observer setup"); }
  async uninstall(): Promise<Record<string, unknown>> { return asRecord(await this.request("uninstall", {}), "Observer uninstall"); }
  async prepareLaunch(input: Record<string, unknown>): Promise<Record<string, unknown>> { return asRecord(await this.request("prepareLaunch", input), "Observer launch preparation"); }
  async revokeSession(sessionId: string): Promise<Record<string, unknown>> { return asRecord(await this.request("revoke", { sessionId }), "Observer session revocation"); }

  async retainRuntimeLifecycle(sessionId: string, runtimeId: string, generation: string, authority: OwnedRuntimeLifecycleAuthority): Promise<Record<string, unknown>> {
    return asRecord(await this.request("runtimeLifecycleRetain", { sessionId, runtimeId, generation, authority }), "Observer runtime lifecycle retention");
  }
  async releaseRuntimeLifecycle(sessionId: string, runtimeId: string, generation: string): Promise<Record<string, unknown>> {
    return asRecord(await this.request("runtimeLifecycleRelease", { sessionId, runtimeId, generation }), "Observer runtime lifecycle release");
  }
  async reserveRuntimeStop(sessionId: string, reservationId: string, exactRuntimeVacant = false, lifecycle?: OwnedRuntimeLifecycleIdentity): Promise<RuntimeStopPreflight> {
    if (!lifecycle) throw new ObserverCoordinatorError("INVALID_REQUEST", "Observer runtime stop reservation requires an exact lifecycle generation");
    const value = asRecord(await this.request("runtimeStopPreflight", { sessionId, reservationId, exactRuntimeVacant, runtimeId: lifecycle.runtimeId, generation: lifecycle.generation }), "Observer runtime stop preflight");
    const strings = (input: unknown): string[] => Array.isArray(input) ? input.filter((entry): entry is string => typeof entry === "string") : [];
    return {
      sessionKnown: value.sessionKnown === true,
      ready: value.ready === true,
      reserved: value.reserved === true,
      activeJobIds: strings(value.activeJobIds),
      cameraLeaseJobIds: strings(value.cameraLeaseJobIds),
      restorationPendingJobIds: strings(value.restorationPendingJobIds),
      ...(typeof value.reservationRequired === "boolean"
        ? { reservationRequired: value.reservationRequired }
        : {}),
      ...(typeof value.reservationId === "string" ? { reservationId: value.reservationId } : {}),
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    };
  }
  async releaseRuntimeStop(sessionId: string, reservationId: string, lifecycle?: OwnedRuntimeLifecycleIdentity): Promise<Record<string, unknown>> {
    if (!lifecycle) throw new ObserverCoordinatorError("INVALID_REQUEST", "Observer runtime stop release requires an exact lifecycle generation");
    return asRecord(await this.request("runtimeStopRelease", { sessionId, reservationId, runtimeId: lifecycle.runtimeId, generation: lifecycle.generation }), "Observer runtime stop release");
  }
  async completeRuntimeStop(sessionId: string, reservationId?: string, exactRuntimeVacant = false, lifecycle?: OwnedRuntimeLifecycleIdentity): Promise<Record<string, unknown>> {
    if (!lifecycle) throw new ObserverCoordinatorError("INVALID_REQUEST", "Observer runtime stop completion requires an exact lifecycle generation");
    return asRecord(await this.request("runtimeStopComplete", { sessionId, ...(reservationId ? { reservationId } : {}), exactRuntimeVacant, runtimeId: lifecycle.runtimeId, generation: lifecycle.generation }), "Observer runtime stop completion");
  }

  async instances(query: ObserverInstanceQuery = {}): Promise<ObserverInstanceList> {
    try { return await this.captureService.instances(query) as ObserverInstanceList; }
    catch (error) { throw this.mapError(error); }
  }
  async capture(input: ObserverCaptureInput): Promise<ObserverCaptureResult> {
    try {
      const { expectedWorldRevision: rawRevision, ...captureInput } = input;
      const expectedWorldRevision = rawRevision === undefined ? undefined : assertWorldRevision(rawRevision);
      return await this.captureService.capture({ ...captureInput, ...(expectedWorldRevision ? { expectedWorldRevision } : {}) }) as CaptureResult;
    } catch (error) { throw this.mapError(error); }
  }
  async beginRun(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    try { return await this.evidenceRuns.begin(input); } catch (error) { throw this.mapError(error); }
  }
  async runStatus(runId: string): Promise<Record<string, unknown>> {
    try { return await this.evidenceRuns.status(runId); } catch (error) { throw this.mapError(error); }
  }
  async finalizeRun(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    try { return await this.evidenceRuns.finalize(input); } catch (error) { throw this.mapError(error); }
  }
  async discardRun(runId: string): Promise<Record<string, unknown>> {
    try { return await this.evidenceRuns.discard(runId); } catch (error) { throw this.mapError(error); }
  }
  async jobStatus(sessionId: string | undefined, jobId: string): Promise<Record<string, unknown>> {
    try { return await this.captureService.status(sessionId, jobId); } catch (error) { throw this.mapError(error); }
  }
  async cancelJob(sessionId: string | undefined, jobId: string): Promise<Record<string, unknown>> {
    try { return await this.captureService.cancel(sessionId, jobId); } catch (error) { throw this.mapError(error); }
  }
  async releaseJob(sessionId: string | undefined, jobId: string): Promise<Record<string, unknown>> {
    try { return await this.captureService.release(sessionId, jobId); } catch (error) { throw this.mapError(error); }
  }
  async readJob(sessionId: string | undefined, jobId: string): Promise<{ job: Record<string, unknown>; image: Buffer; metadata: Record<string, unknown> }> {
    try { return await this.captureService.read(sessionId, jobId); } catch (error) { throw this.mapError(error); }
  }

  async closeRuntimeLifecycle(): Promise<Record<string, unknown>> {
    if (!this.ownedRuntimeManager) {
      await this.closeServices();
      return { sealedRuntimeIds: [], busyRuntimeIds: [], errorRuntimes: [], applicationCloseSafe: true };
    }
    const result = await this.ownedRuntimeManager.close();
    if (result.applicationCloseSafe !== true) {
      throw new OwnedRuntimeError(
        "SHUTDOWN_SEAL_FAILED",
        "Observer application remains live because one or more exact runtimes were not safely sealed",
        result
      );
    }
    await this.closeServices();
    return result;
  }

  async close(): Promise<void> {
    await this.closeRuntimeLifecycle();
  }

  private async closeServices(): Promise<void> {
    if (this.closed) return;
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await this.captureService.close().catch((error) => logger.warn(`Observer capture convergence failed: ${redactChildLine(error instanceof Error ? error.message : String(error))}`));
      if (this.workbenchAdapter) {
        await this.workbenchAdapter.restoreAll().catch((error) => logger.warn(`Workbench observer shutdown restoration failed: ${redactChildLine(error instanceof Error ? error.message : String(error))}`));
      }
      await this.agentClient.close();
    })().finally(() => { this.closed = true; this.closing = false; });
    return this.closePromise;
  }

  private async request(operation: string, payload: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    if (this.closing || this.closed) throw new ObserverCoordinatorError("TRANSPORT_UNAVAILABLE", "Observer application is unavailable");
    await this.ensureStarted();
    return this.agentClient.request(operation, payload, { timeoutMs });
  }

  private mapError(error: unknown): ObserverCoordinatorError {
    if (error instanceof ObserverCoordinatorError) return error;
    const value = error as { code?: unknown; details?: Record<string, unknown> };
    const details = value?.details === undefined
      ? undefined
      : redactDiagnostic(value.details, { profile: "diagnostic" }) as Record<string, unknown>;
    return new ObserverCoordinatorError(
      typeof value?.code === "string" ? value.code : "INTERNAL_ERROR",
      error instanceof Error ? redactText(error.message, { profile: "diagnostic", maxLength: 1_024 }) : "Observer operation failed",
      details
    );
  }
}

export function createObserverApplication(options: CreateObserverApplicationOptions = {}): ObserverApplication {
  return new DefaultObserverApplication(options);
}
