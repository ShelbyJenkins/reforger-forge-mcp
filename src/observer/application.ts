import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedOption, type BoundedOptionErrorFactory } from "../foundation/bounded-option.js";
import { canonicalizePotentialPath } from "../foundation/managed-path.js";
import { redactDiagnostic, redactText } from "../foundation/redact.js";
import {
  validateMcpHostIdentity,
  type McpHostIdentity,
} from "../mcp-host-identity.js";
import type { WorkbenchObserverAdapter } from "../workbench/observer-adapter.js";
import { ObserverAgentClient, type ObserverAgentClientOptions, type ObserverChildDescriptor } from "./agent-client.js";
import type { CaptureInput, CaptureResult } from "./capture-contract.js";
import { resolveExpectedWorldRevision } from "./capture-request.js";
import { CaptureService } from "./capture-service.js";
import { ObserverApplicationError } from "./errors.js";
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

export type ObserverCaptureView = NonNullable<CaptureInput["view"]>;

export interface ObserverCaptureInput extends Omit<CaptureInput, "view" | "expectedWorldRevision"> {
  view: ObserverCaptureView;
  expectedWorldRevision?: string;
}

export type ObserverCaptureResult =
  | { asynchronous: true; job: Record<string, unknown> }
  | {
      asynchronous: false;
      job: Record<string, unknown>;
      image: Buffer;
      metadata: Record<string, unknown>;
      cleanup?: Record<string, unknown>;
      cleanupRequired?: boolean;
      cleanupWarning?: string;
    };

export type ObserverApplicationLifecycleState =
  | "open"
  | "quiescing"
  | "sealing"
  | "retryable_unsafe"
  | "closing"
  | "closed";

export interface CreateObserverApplicationOptions {
  /** Trusted identity shared with the Workbench lifecycle in MCP composition. */
  hostIdentity?: McpHostIdentity;
  debug?: boolean;
  agentPath?: string;
  managedRoot?: string;
  profileRoot?: string;
  gamePath?: string;
  sourceAddon?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Optional absolute cap applied to observer-agent startup and requests. */
  requestDeadlineAtMs?: () => number | undefined;
  defaultCaptureTimeoutMs?: number;
  maxInlineImageBytes?: number;
  defaultLossyImageQuality?: number;
  minimumLossyImageQuality?: number;
  maximumLossyImageQuality?: number;
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
  readonly managedRoot: string;
  readonly profileRoot: string;
  readonly maxInlineImageBytes: number;
  readonly defaultCaptureTimeoutMs: number;
  readonly agentClient: ObserverAgentClient;
  readonly captureService: CaptureService;
  readonly evidenceRuns: EvidenceRunService;
  readonly ownedRuntimeManager?: OwnedRuntimeManager;
  readonly child: unknown;
  readonly lifecycleState: ObserverApplicationLifecycleState;
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
  jobStatus(jobId: string): Promise<Record<string, unknown>>;
  cancelJob(jobId: string): Promise<Record<string, unknown>>;
  releaseJob(jobId: string): Promise<Record<string, unknown>>;
  readJob(jobId: string): Promise<{ job: Record<string, unknown>; image: Buffer; metadata: Record<string, unknown>; cleanup?: Record<string, unknown>; cleanupRequired?: boolean; cleanupWarning?: string }>;
  closeRuntimeLifecycle(deadlineAtMs?: number): Promise<Record<string, unknown>>;
  emergencyTerminatePrivateChildren(): void;
  close(): Promise<void>;
}

const optionError: BoundedOptionErrorFactory = ({ message }) => new ObserverApplicationError("INVALID_REQUEST", message);

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ObserverApplicationError("TRANSPORT_UNAVAILABLE", `${label} returned an invalid response`);
  }
  return value as Record<string, unknown>;
}

function defaultAgentPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const colocated = join(moduleDirectory, "agent", "private-child.js");
  // Production loads application.js from dist/observer, where the private
  // child is colocated. `tsx src/index.ts` loads this source file instead;
  // in that case the child remains in the built dist tree and must not be
  // resolved as the nonexistent src/observer/agent/private-child.js.
  if (existsSync(colocated)) return colocated;
  return resolve(moduleDirectory, "..", "..", "dist", "observer", "agent", "private-child.js");
}

export function defaultObserverManagedRoot(): string {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(localAppData, "ReforgerForge", "Observer", "v1");
}

function validateRoots(label: string, roots: string[] | undefined): void {
  if (roots === undefined) return;
  if (!Array.isArray(roots) || roots.length > 64 || roots.some((root) => typeof root !== "string" || root.length < 1 || root.length > 32_768)) {
    throw new ObserverApplicationError("INVALID_REQUEST", `Observer ${label} configuration is invalid`);
  }
}

class DefaultObserverApplication implements ObserverApplication {
  readonly managedRoot: string;
  readonly profileRoot: string;
  readonly maxInlineImageBytes: number;
  readonly defaultCaptureTimeoutMs: number;
  readonly agentClient: ObserverAgentClient;
  readonly captureService: CaptureService;
  readonly evidenceRuns: EvidenceRunService;
  readonly ownedRuntimeManager?: OwnedRuntimeManager;
  private readonly diagnostics: ObserverHostDiagnostics;
  private readonly requestTimeoutMs: number;
  private readonly workbenchAdapter?: CreateObserverApplicationOptions["workbenchAdapter"];
  private state: ObserverApplicationLifecycleState = "open";
  private closeAttempt: Promise<Record<string, unknown>> | null = null;
  private terminalResult: Record<string, unknown> | null = null;
  private terminalClosePromise: Promise<void> | null = null;

  constructor(options: CreateObserverApplicationOptions) {
    const hostIdentity = options.hostIdentity === undefined
      ? undefined
      : validateMcpHostIdentity(options.hostIdentity);
    const managedRoot = canonicalizePotentialPath(
      resolve(options.managedRoot ?? options.defaultManagedRoot ?? defaultObserverManagedRoot()),
      {
        linkPolicy: "no-links",
        existingAncestor: "directory",
        label: "Observer managed root",
      },
    );
    const profileRoot = canonicalizePotentialPath(
      resolve(options.profileRoot ?? join(managedRoot, "profiles")),
      {
        linkPolicy: "no-links",
        existingAncestor: "directory",
        label: "Observer profile root",
      },
    );
    this.managedRoot = managedRoot;
    this.profileRoot = profileRoot;
    validateRoots("evidence root", options.evidenceRoots);
    validateRoots("supporting log root", options.supportingLogRoots);
    this.requestTimeoutMs = boundedOption(options.requestTimeoutMs, 30_000, 1_000, 5 * 60_000, "Observer request timeout", optionError);
    this.defaultCaptureTimeoutMs = boundedOption(options.defaultCaptureTimeoutMs, 30_000, 1_000, 5 * 60_000, "Observer capture timeout", optionError);
    this.maxInlineImageBytes = boundedOption(options.maxInlineImageBytes, 8 * 1024 * 1024, 1_024, 64 * 1024 * 1024, "Observer inline image limit", optionError);
    const defaultLossyImageQuality = boundedOption(options.defaultLossyImageQuality, 75, 1, 100, "Observer default lossy image quality", optionError);
    const minimumLossyImageQuality = boundedOption(options.minimumLossyImageQuality, 1, 1, 100, "Observer minimum lossy image quality", optionError);
    const maximumLossyImageQuality = boundedOption(options.maximumLossyImageQuality, 100, 1, 100, "Observer maximum lossy image quality", optionError);
    if (minimumLossyImageQuality > defaultLossyImageQuality ||
        defaultLossyImageQuality > maximumLossyImageQuality) {
      throw new ObserverApplicationError(
        "INVALID_REQUEST",
        "Observer lossy image quality must satisfy minimum <= default <= maximum"
      );
    }
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
    // Deliberately not `this.maxInlineImageBytes`: that governs only whether an
    // already-fetched artifact is small enough to return directly in a
    // synchronous MCP response (enforced separately below, after fetch). The
    // backend's own transport read must stay at its default ceiling (matching
    // the observer protocol's actual production limit) so a legitimately
    // large-but-valid capture can still be fetched and persisted into the run;
    // capping it at the smaller inline limit here made status/finalize/discard
    // fail identically to the original inline read forever, since the
    // artifact was never actually retrieved in the first place.
    const backends = [new RuntimeCaptureBackend(this.agentClient)];
    if (options.workbenchAdapter) backends.push(new WorkbenchCaptureBackend(options.workbenchAdapter) as never);
    let captureService!: CaptureService;
    this.evidenceRuns = new EvidenceRunService(this.agentClient, async (run) => captureService.convergeRun(run));
    captureService = new CaptureService({
      backends,
      runPort: this.evidenceRuns,
      defaultTimeoutMs: this.defaultCaptureTimeoutMs,
      pollIntervalMs,
      maxInlineImageBytes: this.maxInlineImageBytes,
      imagePolicyDefaults: {
        lossyQuality: defaultLossyImageQuality,
        minimumLossyQuality: minimumLossyImageQuality,
        maximumLossyQuality: maximumLossyImageQuality,
      },
    });
    this.captureService = captureService;
    if (options.gamePath) {
      this.ownedRuntimeManager = new OwnedRuntimeManager({
        managedRoot,
        gamePath: options.gamePath,
        observerGate: this,
        ...(hostIdentity === undefined
          ? {}
          : { managerInstanceId: hostIdentity.instanceId }),
      });
    }
  }

  get child(): unknown { return this.agentClient.childProcess; }
  get lifecycleState(): ObserverApplicationLifecycleState { return this.state; }
  diagnosticPrivateChildCount(): number { return this.agentClient.diagnosticPrivateChildCount(); }
  ensureStarted(): Promise<ObserverChildDescriptor> {
    this.assertPublicOpen();
    return this.agentClient.ensureStarted();
  }
  async status(): Promise<Record<string, unknown>> {
    this.assertPublicOpen();
    return {
      ...await this.diagnostics.inspect("status", false, false),
      imageOutput: this.imageOutputDiagnostics(),
    };
  }
  async doctor(): Promise<Record<string, unknown>> {
    this.assertPublicOpen();
    return {
      ...await this.diagnostics.inspect("doctor", false, false),
      imageOutput: this.imageOutputDiagnostics(),
    };
  }
  async ensureSetup(): Promise<Record<string, unknown>> { return asRecord(await this.request("stage", {}), "Observer setup"); }
  async uninstall(): Promise<Record<string, unknown>> { return asRecord(await this.request("uninstall", {}), "Observer uninstall"); }
  async prepareLaunch(input: Record<string, unknown>): Promise<Record<string, unknown>> { return asRecord(await this.request("prepareLaunch", input), "Observer launch preparation"); }
  async revokeSession(sessionId: string): Promise<Record<string, unknown>> { return asRecord(await this.request("revoke", { sessionId }), "Observer session revocation"); }

  async retainRuntimeLifecycle(sessionId: string, runtimeId: string, generation: string, authority: OwnedRuntimeLifecycleAuthority): Promise<Record<string, unknown>> {
    return asRecord(await this.lifecycleRequest("runtimeLifecycleRetain", { sessionId, runtimeId, generation, authority }), "Observer runtime lifecycle retention");
  }
  async releaseRuntimeLifecycle(sessionId: string, runtimeId: string, generation: string): Promise<Record<string, unknown>> {
    return asRecord(await this.lifecycleRequest("runtimeLifecycleRelease", { sessionId, runtimeId, generation }), "Observer runtime lifecycle release");
  }
  async reserveRuntimeStop(sessionId: string, reservationId: string, exactRuntimeVacant = false, lifecycle?: OwnedRuntimeLifecycleIdentity): Promise<RuntimeStopPreflight> {
    if (!lifecycle) throw new ObserverApplicationError("INVALID_REQUEST", "Observer runtime stop reservation requires an exact lifecycle generation");
    const value = asRecord(await this.lifecycleRequest("runtimeStopPreflight", { sessionId, reservationId, exactRuntimeVacant, runtimeId: lifecycle.runtimeId, generation: lifecycle.generation }), "Observer runtime stop preflight");
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
    if (!lifecycle) throw new ObserverApplicationError("INVALID_REQUEST", "Observer runtime stop release requires an exact lifecycle generation");
    return asRecord(await this.lifecycleRequest("runtimeStopRelease", { sessionId, reservationId, runtimeId: lifecycle.runtimeId, generation: lifecycle.generation }), "Observer runtime stop release");
  }
  async completeRuntimeStop(sessionId: string, reservationId?: string, exactRuntimeVacant = false, lifecycle?: OwnedRuntimeLifecycleIdentity): Promise<Record<string, unknown>> {
    if (!lifecycle) throw new ObserverApplicationError("INVALID_REQUEST", "Observer runtime stop completion requires an exact lifecycle generation");
    return asRecord(await this.lifecycleRequest("runtimeStopComplete", { sessionId, ...(reservationId ? { reservationId } : {}), exactRuntimeVacant, runtimeId: lifecycle.runtimeId, generation: lifecycle.generation }), "Observer runtime stop completion");
  }

  async instances(query: ObserverInstanceQuery = {}): Promise<ObserverInstanceList> {
    this.assertPublicOpen();
    try { return await this.captureService.instances(query) as ObserverInstanceList; }
    catch (error) { throw this.mapError(error); }
  }
  async capture(input: ObserverCaptureInput): Promise<ObserverCaptureResult> {
    this.assertPublicOpen();
    try {
      const { expectedWorldRevision: rawRevision, ...captureInput } = input;
      const expectedWorldRevision = rawRevision === undefined
        ? undefined
        : resolveExpectedWorldRevision({ expectedWorldRevision: rawRevision });
      return await this.captureService.capture({
        ...captureInput,
        ...(expectedWorldRevision ? { expectedWorldRevision } : {}),
      }) as CaptureResult;
    } catch (error) { throw this.mapError(error); }
  }
  async beginRun(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertPublicOpen();
    try { return await this.evidenceRuns.begin(input); } catch (error) { throw this.mapError(error); }
  }
  async runStatus(runId: string): Promise<Record<string, unknown>> {
    this.assertPublicOpen();
    try { return await this.evidenceRuns.status(runId); } catch (error) { throw this.mapError(error); }
  }
  async finalizeRun(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertPublicOpen();
    try { return await this.evidenceRuns.finalize(input); } catch (error) { throw this.mapError(error); }
  }
  async discardRun(runId: string): Promise<Record<string, unknown>> {
    this.assertPublicOpen();
    try { return await this.evidenceRuns.discard(runId); } catch (error) { throw this.mapError(error); }
  }
  async jobStatus(jobId: string): Promise<Record<string, unknown>> {
    this.assertPublicOpen();
    try { return await this.captureService.status(jobId); } catch (error) { throw this.mapError(error); }
  }
  async cancelJob(jobId: string): Promise<Record<string, unknown>> {
    this.assertPublicOpen();
    try { return await this.captureService.cancel(jobId); } catch (error) { throw this.mapError(error); }
  }
  async releaseJob(jobId: string): Promise<Record<string, unknown>> {
    this.assertPublicOpen();
    try { return await this.captureService.release(jobId); } catch (error) { throw this.mapError(error); }
  }
  async readJob(jobId: string): Promise<{ job: Record<string, unknown>; image: Buffer; metadata: Record<string, unknown>; cleanup?: Record<string, unknown>; cleanupRequired?: boolean; cleanupWarning?: string }> {
    this.assertPublicOpen();
    try { return await this.captureService.read(jobId); } catch (error) { throw this.mapError(error); }
  }

  closeRuntimeLifecycle(deadlineAtMs = Date.now() + 30_000): Promise<Record<string, unknown>> {
    if (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= 0) {
      return Promise.reject(new TypeError("Observer application shutdown deadline is invalid"));
    }
    if (this.terminalResult) return Promise.resolve(this.terminalResult);
    if (this.closeAttempt) return this.closeAttempt;
    const attempt = this.performCloseAttempt(deadlineAtMs);
    let tracked!: Promise<Record<string, unknown>>;
    tracked = attempt.finally(() => {
      if (this.closeAttempt === tracked) this.closeAttempt = null;
    });
    this.closeAttempt = tracked;
    return tracked;
  }

  async close(): Promise<void> {
    await this.closeRuntimeLifecycle();
  }

  emergencyTerminatePrivateChildren(): void {
    this.agentClient.emergencyTerminatePrivateChildren();
  }

  private async performCloseAttempt(deadlineAtMs: number): Promise<Record<string, unknown>> {
    try {
      this.state = "quiescing";
      const quiescence = await this.captureService.quiesce(deadlineAtMs);
      if (!quiescence.quiescent) {
        throw new OwnedRuntimeError(
          "SHUTDOWN_SEAL_FAILED",
          "Observer capture work did not quiesce before the shutdown deadline",
          {
            state: "quiescing",
            applicationCloseSafe: false,
            busyRuntimeIds: [],
            errorRuntimes: quiescence.remainingJobIds.map((jobId) => ({
              runtimeId: jobId,
              reason: "Capture job still has an active or restoration-pending obligation",
            })),
            ...quiescence,
          },
        );
      }

      this.state = "sealing";
      const result = this.ownedRuntimeManager
        ? await this.ownedRuntimeManager.close(deadlineAtMs)
        : { sealedRuntimeIds: [], busyRuntimeIds: [], errorRuntimes: [], applicationCloseSafe: true };
      if (result.applicationCloseSafe !== true) {
        throw new OwnedRuntimeError(
          "SHUTDOWN_SEAL_FAILED",
          "Observer application remains live because one or more exact runtimes were not safely sealed",
          result,
        );
      }

      this.state = "closing";
      await this.closeServices();
      this.state = "closed";
      this.terminalResult = result;
      return result;
    } catch (error) {
      if (this.state !== "closed") this.state = "retryable_unsafe";
      throw error;
    }
  }

  private async closeServices(): Promise<void> {
    if (this.state === "closed") return;
    if (this.terminalClosePromise) return this.terminalClosePromise;
    const attempt = (async () => {
      await this.captureService.close();
      if (this.workbenchAdapter) {
        await this.workbenchAdapter.restoreAll();
      }
      await this.agentClient.close();
    })();
    this.terminalClosePromise = attempt.catch((error) => {
      this.terminalClosePromise = null;
      throw error;
    });
    return this.terminalClosePromise;
  }

  private async request(operation: string, payload: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    this.assertPublicOpen();
    await this.agentClient.ensureStarted();
    return this.agentClient.request(operation, payload, { timeoutMs });
  }

  private async lifecycleRequest(operation: string, payload: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    if (this.state === "closing" || this.state === "closed") {
      throw new ObserverApplicationError("TRANSPORT_UNAVAILABLE", "Observer application is unavailable");
    }
    await this.agentClient.ensureStarted();
    return this.agentClient.request(operation, payload, { timeoutMs });
  }

  private assertPublicOpen(): void {
    if (this.state !== "open") {
      throw new ObserverApplicationError("TRANSPORT_UNAVAILABLE", "Observer application is unavailable");
    }
  }

  private imageOutputDiagnostics(): Record<string, unknown> {
    return {
      formats: ["png", "jpeg", "webp"],
      defaultFormat: "png",
      defaultLossyQuality: this.captureService.imagePolicyDefaults.lossyQuality,
      minimumLossyQuality: this.captureService.imagePolicyDefaults.minimumLossyQuality,
      maximumLossyQuality: this.captureService.imagePolicyDefaults.maximumLossyQuality,
      maximumRequestedWidth: this.captureService.imagePolicyDefaults.maximumWidth,
      maximumRequestedHeight: this.captureService.imagePolicyDefaults.maximumHeight,
      maximumDecodedPixels: this.captureService.imagePolicyDefaults.maximumPixels,
      sourceArtifactMaxBytes: 64 * 1024 * 1024,
      retainedArtifactMaxBytes: 64 * 1024 * 1024,
      inlineResponseMaxBytes: this.maxInlineImageBytes,
      aggregateRetention: "observer.retentionMaxBytes",
    };
  }

  private mapError(error: unknown): ObserverApplicationError {
    if (error instanceof ObserverApplicationError) return error;
    const value = error as { code?: unknown; details?: Record<string, unknown> };
    const details = value?.details === undefined
      ? undefined
      : redactDiagnostic(value.details, { profile: "diagnostic" }) as Record<string, unknown>;
    return new ObserverApplicationError(
      typeof value?.code === "string" ? value.code : "INTERNAL_ERROR",
      error instanceof Error ? redactText(error.message, { profile: "diagnostic", maxLength: 1_024 }) : "Observer operation failed",
      details
    );
  }
}

export function createObserverApplication(options: CreateObserverApplicationOptions = {}): ObserverApplication {
  return new DefaultObserverApplication(options);
}
