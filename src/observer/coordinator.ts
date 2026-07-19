import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../utils/logger.js";
import type {
  WorkbenchObserverAdapter,
  WorkbenchObserverInstance,
  WorkbenchObserverJobStatus,
} from "../workbench/observer-adapter.js";
import type { RuntimeStopPreflight } from "./owned-runtime-manager.js";
import { canonicalPublicObserverErrorCode } from "./public-contract.js";

const CHILD_PROTOCOL = "rfo-observer-child-v1" as const;
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const MAX_WORKBENCH_RELEASE_RECEIPTS = 1_024;
const SOURCE_MANIFEST_NAME = ".reforger-forge-observer-source.json";
const MAX_READ_ONLY_MANIFEST_BYTES = 2 * 1024 * 1024;
const WORKBENCH_PUBLIC_ERROR_MAP: Readonly<Record<string, string>> = Object.freeze({
  HANDLER_UNAVAILABLE: "WORKBENCH_ADAPTER_UNAVAILABLE",
  HANDLER_REJECTED: "CAPTURE_REJECTED",
  STALE_LIFECYCLE: "STALE_INSTANCE",
  WORKBENCH_EXITED: "STALE_INSTANCE",
});

function canonicalWorkbenchErrorCode(value: unknown): string {
  const mapped = typeof value === "string" ? (WORKBENCH_PUBLIC_ERROR_MAP[value] ?? value) : undefined;
  return canonicalPublicObserverErrorCode(mapped, "WORKBENCH_ADAPTER_UNAVAILABLE");
}

export class ObserverCoordinatorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ObserverCoordinatorError";
  }
}

export interface ObserverChildDescriptor {
  protocolVersion: string;
  agentVersion: string;
  agentInstanceId: string;
  host: "127.0.0.1" | "::1";
  port: number;
}

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

export type ObserverCaptureView =
  | { kind: "current" }
  | { kind: "pose"; position: [number, number, number]; orientation: [number, number, number, number]; fov: number }
  | { kind: "lookAt"; position: [number, number, number]; target: [number, number, number]; fov: number };

export interface ObserverCaptureInput {
  sessionId?: string;
  instanceId?: string;
  idempotencyKey: string;
  view: ObserverCaptureView;
  settleFrames?: number;
  performancePolicy?: "evidence" | "instrumented" | "performance";
  runId?: string;
  captureLabel?: string;
  purpose?: string;
  expectedWorldId?: string | null;
  expectedWorldEpoch?: number;
  asynchronous?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type ObserverCaptureResult =
  | { asynchronous: true; job: Record<string, unknown> }
  | {
      asynchronous: false;
      job: Record<string, unknown>;
      image: Buffer;
      metadata: Record<string, unknown>;
    };

export interface ObserverCoordinatorOptions {
  agentPath?: string;
  managedRoot?: string;
  profileRoot?: string;
  projectPath?: string;
  sourceAddon?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  defaultCaptureTimeoutMs?: number;
  maxInlineImageBytes?: number;
  retentionIntervalMs?: number;
  retentionMaxAgeMs?: number;
  retentionMaxBytes?: number;
  evidenceRoots?: string[];
  supportingLogRoots?: string[];
  pollIntervalMs?: number;
  forkChild?: typeof fork;
  /** One adapter built from the server's existing shared WorkbenchClient. */
  workbenchAdapter?: Pick<
    WorkbenchObserverAdapter,
    "instances" | "submit" | "recover" | "status" | "cancel" | "release" | "readCompletedArtifact" | "restoreAll"
  >;
  /** Test-only injection for the platform-derived default managed root. */
  defaultManagedRoot?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface WorkbenchIdempotencyRecord {
  readonly fingerprint: string;
  readonly submission: Promise<WorkbenchObserverJobStatus>;
  status?: WorkbenchObserverJobStatus;
  releaseReceipt?: Record<string, unknown>;
  terminalError?: ObserverCoordinatorError;
}

interface TrackedWorkbenchJob {
  sessionId?: string;
  instanceId: string;
  runId?: string;
  captureLabel?: string;
  performancePolicy: "evidence" | "instrumented";
  requestedView: ObserverCaptureView;
  expectedWorldId?: string | null;
  expectedWorldEpoch?: number;
  /** False when reconstructed from a durable run record after coordinator restart. */
  adapterAttached: boolean;
  /** Last handler-authoritative status retained before the handler transaction
   * is released. Managed status/read retries continue to expose this richer
   * camera evidence without keeping Workbench's single job slot occupied. */
  lastStatus?: WorkbenchObserverJobStatus;
  /** Handler-only release is distinct from public job/artifact release. */
  handlerReleaseReceipt?: {
    jobId: string;
    restorationConfirmed: boolean;
    artifactRemoved: boolean;
    handlerAlreadyAbsent?: boolean;
  };
  recoveredAssociation?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ObserverCoordinatorError("TRANSPORT_UNAVAILABLE", `${label} returned an invalid response`);
  return value;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new ObserverCoordinatorError("INVALID_REQUEST", `${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return result;
}

function defaultAgentPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "agent", "private-child.js");
}

function potentialCanonicalPath(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return absolute;
    existing = parent;
  }
  const canonicalExisting = realpathSync.native(existing);
  const suffix = relative(existing, absolute);
  return resolve(canonicalExisting, suffix);
}

function containsPath(root: string, candidate: string): boolean {
  const normalize = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
  const rel = relative(normalize(root), normalize(candidate));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function platformDefaultManagedRoot(): string {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "ReforgerForge", "Observer", "v1");
  }
  if (process.env.XDG_STATE_HOME) {
    return join(process.env.XDG_STATE_HOME, "reforger-forge", "observer", "v1");
  }
  return join(homedir(), ".local", "state", "reforger-forge", "observer", "v1");
}

function assertObserverPathsOutsideProject(
  projectPath: string | undefined,
  managedRoot: string,
  profileRoot: string
): void {
  if (!projectPath) return;
  const project = potentialCanonicalPath(projectPath);
  for (const [label, path] of [
    ["managed root", managedRoot],
    ["profile root", profileRoot],
  ] as const) {
    const observerPath = potentialCanonicalPath(path);
    if (containsPath(project, observerPath) || containsPath(observerPath, project)) {
      throw new ObserverCoordinatorError(
        "INVALID_REQUEST",
        `Observer ${label} must not overlap the configured project path`
      );
    }
  }
}

function readOnlyPathStatus(path: string): Record<string, unknown> {
  try {
    const entry = lstatSync(path);
    return {
      path,
      exists: true,
      symbolicLink: entry.isSymbolicLink(),
      kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { path, exists: false, symbolicLink: false, kind: "missing" };
    return {
      path,
      exists: null,
      symbolicLink: null,
      kind: "unreadable",
      errorCode: typeof code === "string" ? code : "READ_FAILED",
    };
  }
}

function readOnlySourceManifestStatus(sourceAddon: string): Record<string, unknown> {
  const source = readOnlyPathStatus(sourceAddon);
  const manifestPath = join(sourceAddon, SOURCE_MANIFEST_NAME);
  const manifestFile = readOnlyPathStatus(manifestPath);
  if (source.exists !== true || source.kind !== "directory" || source.symbolicLink === true) {
    return {
      verificationState: "source_unavailable",
      verified: false,
      source,
      manifestFile,
    };
  }
  if (manifestFile.exists !== true || manifestFile.kind !== "file" || manifestFile.symbolicLink === true) {
    return {
      verificationState: "manifest_unavailable",
      verified: false,
      source,
      manifestFile,
    };
  }
  try {
    const entry = lstatSync(manifestPath);
    if (entry.size < 2 || entry.size > MAX_READ_ONLY_MANIFEST_BYTES) {
      return {
        verificationState: "manifest_size_invalid",
        verified: false,
        source,
        manifestFile,
        bytes: entry.size,
      };
    }
    const bytes = readFileSync(manifestPath);
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(parsed)) throw new TypeError("manifest root is not an object");
    const declared = {
      manifestVersion: typeof parsed.manifestVersion === "number" ? parsed.manifestVersion : null,
      addonVersion: typeof parsed.addonVersion === "string" ? parsed.addonVersion : null,
      protocolVersion: typeof parsed.protocolVersion === "string" ? parsed.protocolVersion : null,
      addonId: typeof parsed.addonId === "string" ? parsed.addonId : null,
      addonGuid: typeof parsed.addonGuid === "string" ? parsed.addonGuid : null,
      buildIdentity: typeof parsed.buildIdentity === "string" ? parsed.buildIdentity : null,
      bundleDigest: typeof parsed.bundleDigest === "string" ? parsed.bundleDigest : null,
      fileCount: Array.isArray(parsed.files) ? parsed.files.length : null,
    };
    const declarationReadable = declared.manifestVersion === 1 &&
      typeof declared.addonVersion === "string" &&
      typeof declared.protocolVersion === "string" &&
      typeof declared.addonId === "string" &&
      typeof declared.addonGuid === "string" &&
      typeof declared.buildIdentity === "string" && /^[a-f0-9]{64}$/.test(declared.buildIdentity) &&
      typeof declared.bundleDigest === "string" && /^[a-f0-9]{64}$/.test(declared.bundleDigest) &&
      typeof declared.fileCount === "number" && declared.fileCount > 0;
    return {
      verificationState: declarationReadable ? "declared" : "manifest_shape_invalid",
      // Full payload hashing remains an agent operation. Do not claim that a
      // manifest-only idle inspection cryptographically verified the bundle.
      verified: false,
      source,
      manifestFile,
      bytes: bytes.length,
      manifestSha256: createHash("sha256").update(bytes).digest("hex"),
      declared,
    };
  } catch (error) {
    return {
      verificationState: "manifest_unreadable",
      verified: false,
      source,
      manifestFile,
      errorCode: (error as NodeJS.ErrnoException).code ?? "INVALID_JSON",
    };
  }
}

const CHILD_CONTRACT_BODY = /((?:"?[A-Za-z0-9]*contract(?:body|payload)?"?)\s*[:=]\s*).*/i;

export function redactChildLine(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
    .replace(/((?:[A-Za-z0-9_-]*nonce|(?:session|control)?token|authorization|credential|secret)(?:\"?\s*[:=]\s*\"?))[^\s\",}]+/gi, "$1[REDACTED]")
    // Contract payloads contain several non-token identity and authority facts.
    // Once a contract assignment is present, redact the complete remaining body
    // instead of attempting to enumerate sensitive fields inside it.
    .replace(CHILD_CONTRACT_BODY, "$1[REDACTED]")
    .slice(0, 1_024);
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new ObserverCoordinatorError("CANCELLED", "Observer request was cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new ObserverCoordinatorError("CANCELLED", "Observer request was cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export class ObserverCoordinator {
  readonly maxInlineImageBytes: number;
  readonly defaultCaptureTimeoutMs: number;
  private readonly agentPath: string;
  private readonly sourceAddon: string;
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly spawnChild: typeof fork;
  private readonly managedRoot: string;
  private readonly profileRoot: string;
  private readonly workbenchAdapter: ObserverCoordinatorOptions["workbenchAdapter"];
  private readonly workbenchJobs = new Map<string, TrackedWorkbenchJob>();
  private readonly workbenchIdempotency = new Map<string, WorkbenchIdempotencyRecord>();
  private readonly workbenchIdempotencyByJob = new Map<string, string>();
  private readonly workbenchReleaseReceipts = new Map<string, {
    sessionId?: string;
    idempotencyKey?: string;
    result: Record<string, unknown>;
  }>();
  private child: ChildProcess | null = null;
  private descriptor: ObserverChildDescriptor | null = null;
  private startPromise: Promise<ObserverChildDescriptor> | null = null;
  private rejectStartup: ((error: Error) => void) | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: ObserverCoordinatorOptions = {}) {
    this.managedRoot = resolve(options.managedRoot ?? options.defaultManagedRoot ?? platformDefaultManagedRoot());
    this.profileRoot = resolve(options.profileRoot ?? join(this.managedRoot, "profiles"));
    assertObserverPathsOutsideProject(options.projectPath, this.managedRoot, this.profileRoot);
    this.agentPath = options.agentPath ?? defaultAgentPath();
    this.sourceAddon = options.sourceAddon ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "observer", "addon");
    this.startupTimeoutMs = boundedInteger(options.startupTimeoutMs, 10_000, 1_000, 60_000, "Observer startup timeout");
    this.requestTimeoutMs = boundedInteger(options.requestTimeoutMs, 30_000, 1_000, 5 * 60_000, "Observer request timeout");
    this.defaultCaptureTimeoutMs = boundedInteger(options.defaultCaptureTimeoutMs, 30_000, 1_000, 5 * 60_000, "Observer capture timeout");
    this.maxInlineImageBytes = boundedInteger(options.maxInlineImageBytes, 8 * 1024 * 1024, 1_024, 64 * 1024 * 1024, "Observer inline image limit");
    this.pollIntervalMs = boundedInteger(options.pollIntervalMs, 200, 10, 5_000, "Observer poll interval");
    if (options.retentionIntervalMs !== undefined) {
      boundedInteger(options.retentionIntervalMs, options.retentionIntervalMs, 1_000, 24 * 60 * 60_000, "Observer retention interval");
    }
    if (options.retentionMaxAgeMs !== undefined) {
      boundedInteger(options.retentionMaxAgeMs, options.retentionMaxAgeMs, 1_000, 5 * 365 * 24 * 60 * 60_000, "Observer retention maximum age");
    }
    if (options.retentionMaxBytes !== undefined) {
      boundedInteger(options.retentionMaxBytes, options.retentionMaxBytes, 1_024 * 1_024, 64 * 1024 * 1024 * 1024, "Observer retention maximum bytes");
    }
    for (const [label, roots] of [
      ["evidence root", options.evidenceRoots],
      ["supporting log root", options.supportingLogRoots],
    ] as const) {
      if (roots !== undefined && (!Array.isArray(roots) || roots.length > 64 || roots.some((root) => typeof root !== "string" || root.length < 1 || root.length > 32_768))) {
        throw new ObserverCoordinatorError("INVALID_REQUEST", `Observer ${label} configuration is invalid`);
      }
    }
    this.spawnChild = options.forkChild ?? fork;
    this.workbenchAdapter = options.workbenchAdapter;
  }

  async ensureStarted(): Promise<ObserverChildDescriptor> {
    if (this.closed || this.closing) {
      throw new ObserverCoordinatorError("TRANSPORT_UNAVAILABLE", "Observer coordinator is shutting down");
    }
    if (this.child?.connected && this.descriptor) return this.descriptor;
    if (this.startPromise) return this.startPromise;

    const argumentsArray: string[] = [];
    const addOption = (name: string, value: string | number | undefined): void => {
      if (value !== undefined) argumentsArray.push(name, String(value));
    };
    addOption("--root", this.managedRoot);
    addOption("--profile-root", this.profileRoot);
    addOption("--source-addon", this.sourceAddon);
    addOption("--retention-interval-ms", this.options.retentionIntervalMs);
    addOption("--retention-max-age-ms", this.options.retentionMaxAgeMs);
    addOption("--retention-max-bytes", this.options.retentionMaxBytes);
    for (const root of this.options.evidenceRoots ?? []) addOption("--evidence-root", root);
    for (const root of this.options.supportingLogRoots ?? []) addOption("--supporting-log-root", root);

    const child = this.spawnChild(this.agentPath, argumentsArray, {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      execArgv: [],
      env: { ...process.env },
      serialization: "advanced",
    });
    this.child = child;
    this.descriptor = null;
    this.attachChild(child);
    this.startPromise = new Promise<ObserverChildDescriptor>((resolve, reject) => {
      this.rejectStartup = reject;
      const timer = setTimeout(() => {
        if (this.child === child && !this.descriptor) {
          reject(new ObserverCoordinatorError("TRANSPORT_UNAVAILABLE", "Private observer agent did not become ready before the startup deadline"));
          child.kill();
        }
      }, this.startupTimeoutMs);
      timer.unref();
      const ready = (message: unknown): void => {
        if (!isRecord(message) || message.protocol !== CHILD_PROTOCOL || message.type !== "ready") return;
        try {
          const descriptor = this.parseDescriptor(message.descriptor);
          clearTimeout(timer);
          child.off("message", ready);
          this.descriptor = descriptor;
          this.rejectStartup = null;
          resolve(descriptor);
        } catch (error) {
          clearTimeout(timer);
          child.off("message", ready);
          reject(error instanceof Error ? error : new Error(String(error)));
          child.kill();
        }
      };
      child.on("message", ready);
    }).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async status(): Promise<Record<string, unknown>> {
    return this.readOnlySetupStatus("status");
  }

  async doctor(): Promise<Record<string, unknown>> {
    return this.readOnlySetupStatus("doctor");
  }

  async ensureSetup(): Promise<Record<string, unknown>> {
    return asRecord(await this.request("stage", {}), "Observer setup");
  }

  async uninstall(): Promise<Record<string, unknown>> {
    return asRecord(await this.request("uninstall", {}), "Observer uninstall");
  }

  async prepareLaunch(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return asRecord(await this.request("prepareLaunch", input), "Observer launch preparation");
  }

  async revokeSession(sessionId: string): Promise<Record<string, unknown>> {
    return asRecord(await this.request("revoke", { sessionId }), "Observer session revocation");
  }

  async reserveRuntimeStop(
    sessionId: string,
    proposedReservationId: string,
    exactRuntimeVacant = false
  ): Promise<RuntimeStopPreflight> {
    const response = asRecord(
      await this.request("runtimeStopPreflight", {
        sessionId,
        reservationId: proposedReservationId,
        exactRuntimeVacant,
      }),
      "Observer runtime stop preflight"
    );
    const strings = (value: unknown): string[] => Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
    return {
      sessionKnown: response.sessionKnown === true,
      ready: response.ready === true,
      reserved: response.reserved === true,
      activeJobIds: strings(response.activeJobIds),
      cameraLeaseJobIds: strings(response.cameraLeaseJobIds),
      restorationPendingJobIds: strings(response.restorationPendingJobIds),
      ...(typeof response.reservationId === "string" ? { reservationId: response.reservationId } : {}),
      ...(typeof response.reason === "string" ? { reason: response.reason } : {}),
    };
  }

  async releaseRuntimeStop(sessionId: string, reservationId: string): Promise<Record<string, unknown>> {
    return asRecord(
      await this.request("runtimeStopRelease", { sessionId, reservationId }),
      "Observer runtime stop release"
    );
  }

  async completeRuntimeStop(
    sessionId: string,
    reservationId?: string,
    exactRuntimeVacant = false
  ): Promise<Record<string, unknown>> {
    return asRecord(
      await this.request("runtimeStopComplete", {
        sessionId,
        ...(reservationId ? { reservationId } : {}),
        exactRuntimeVacant,
      }),
      "Observer runtime stop completion"
    );
  }

  private async readOnlySetupStatus(operation: "status" | "doctor"): Promise<Record<string, unknown>> {
    if (!this.closed && !this.closing) {
      const child = this.child;
      const descriptor = this.descriptor;
      if (child?.connected && descriptor) {
        // Capture and query only this already-ready child. A send/exit race is
        // reported as unavailable; status/doctor must never turn that race into
        // a replacement child or a filesystem-initializing restart.
        return asRecord(
          await this.sendRequest(child, operation, {}, this.requestTimeoutMs),
          `Observer ${operation}`
        );
      }
    }

    const state = this.closed
      ? "closed"
      : this.closing
        ? "closing"
        : this.startPromise
          ? "starting"
          : "idle";
    const sourceManifest = readOnlySourceManifestStatus(this.sourceAddon);
    const declared = isRecord(sourceManifest.declared) ? sourceManifest.declared : null;
    const declaredDigest = typeof declared?.bundleDigest === "string" && /^[a-f0-9]{64}$/.test(declared.bundleDigest)
      ? declared.bundleDigest
      : null;
    const declaredAddonId = typeof declared?.addonId === "string" && /^[A-Za-z0-9_-]{1,96}$/.test(declared.addonId)
      ? declared.addonId
      : null;
    const stagedAddonPath = declaredDigest && declaredAddonId
      ? join(this.managedRoot, "addons", declaredDigest, declaredAddonId)
      : null;
    return {
      readOnly: true,
      mutationPerformed: false,
      diagnostic: operation,
      agentState: state,
      running: false,
      endpoint: null,
      observerRoot: this.managedRoot,
      profileRoot: this.profileRoot,
      managedStorage: {
        root: readOnlyPathStatus(this.managedRoot),
        addons: readOnlyPathStatus(join(this.managedRoot, "addons")),
        artifacts: readOnlyPathStatus(join(this.managedRoot, "artifacts")),
        runs: readOnlyPathStatus(join(this.managedRoot, "runs")),
        exportWork: readOnlyPathStatus(join(this.managedRoot, "export-work")),
        state: readOnlyPathStatus(join(this.managedRoot, "state")),
        logs: readOnlyPathStatus(join(this.managedRoot, "logs")),
        profileRoot: readOnlyPathStatus(this.profileRoot),
        expectedStagedAddon: stagedAddonPath ? readOnlyPathStatus(stagedAddonPath) : null,
      },
      sourceManifest,
      stateLoaded: false,
      sessions: [],
      instances: [],
      jobs: [],
      promises: {
        launchesProcesses: false,
        signalsProcesses: false,
        mutatesWorkbenchHandlers: false,
      },
      note: "Private observer agent is not running; durable profile contracts and staged payloads were not opened or modified.",
    };
  }

  async instances(query: ObserverInstanceQuery = {}): Promise<ObserverInstanceList> {
    const startedAt = Date.now();
    const waitMs = Math.max(0, query.waitMs ?? 0);
    for (;;) {
      if (query.signal?.aborted) throw new ObserverCoordinatorError("CANCELLED", "Observer instance wait was cancelled");
      const response = asRecord(await this.request("instances", {}), "Observer instances");
      const runtimeInstances = Array.isArray(response.instances)
        ? response.instances.filter(isRecord)
        : [];
      const workbench = await this.workbenchInventory();
      const instances = [...runtimeInstances, ...workbench.instances];
      const compatible = instances.filter((instance) => this.isCompatibleInstance(instance, query));
      const elapsed = Date.now() - startedAt;
      if (waitMs === 0 || compatible.length > 0 || elapsed >= waitMs) {
        return {
          instances,
          compatibleCount: compatible.length,
          waitedMs: elapsed,
          timedOut: waitMs > 0 && compatible.length === 0,
          ...(workbench.warning ? { warnings: [workbench.warning] } : {}),
        };
      }
      await sleep(Math.min(this.pollIntervalMs, waitMs - elapsed), query.signal);
    }
  }

  private async workbenchInventory(): Promise<{
    instances: Array<Record<string, unknown>>;
    warning?: string;
  }> {
    if (!this.workbenchAdapter) return { instances: [] };
    try {
      const instances = await this.workbenchAdapter.instances();
      return {
        instances: instances.map((instance) => this.workbenchInstanceRecord(instance)),
      };
    } catch (error) {
      // A missing, stopped, foreign, or handler-incompatible Workbench is not a
      // runtime observer inventory failure. Preserve the runtime list and make
      // the optional adapter diagnostic visible without auto-launching it.
      return {
        instances: [],
        warning: `Workbench observer unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 512),
      };
    }
  }

  private workbenchInstanceRecord(instance: WorkbenchObserverInstance): Record<string, unknown> {
    return {
      ...instance,
      backend: "workbench",
      runtimeKind: "workbench",
      selectedTransport: "workbench-netapi",
      sessionId: null,
      stale: false,
      transportHealthy: true,
      headless: false,
      worldId: instance.worldIdentity,
      worldEpoch: 0,
      activeJob: instance.activeJobId,
      health: "live",
    };
  }

  async capture(input: ObserverCaptureInput): Promise<ObserverCaptureResult> {
    const timeoutMs = boundedInteger(input.timeoutMs, this.defaultCaptureTimeoutMs, 1_000, 5 * 60_000, "Observer capture timeout");
    if (input.signal?.aborted) throw new ObserverCoordinatorError("CANCELLED", "Observer capture was cancelled");
    if ((input.runId === undefined) !== (input.captureLabel === undefined)) {
      throw new ObserverCoordinatorError("INVALID_REQUEST", "runId and captureLabel must be supplied together");
    }
    if (input.performancePolicy === "performance") {
      throw new ObserverCoordinatorError("PERFORMANCE_POLICY_BLOCKED", "Performance capture requires an external measurement coordinator");
    }
    let reservedCapture: Record<string, unknown> | null = null;
    if (input.runId && input.captureLabel) {
      const reservation = asRecord(await this.request("runReserveCapture", {
        runId: input.runId,
        captureLabel: input.captureLabel,
        ...(input.purpose ? { purpose: input.purpose } : {}),
        idempotencyKey: input.idempotencyKey,
        ...(input.expectedWorldId !== undefined ? { expectedWorldId: input.expectedWorldId } : {}),
        ...(input.expectedWorldEpoch !== undefined ? { expectedWorldEpoch: input.expectedWorldEpoch } : {}),
        requestedView: input.view,
        performancePolicy: input.performancePolicy ?? "evidence",
      }), "Observer run capture reservation");
      reservedCapture = isRecord(reservation.capture) ? reservation.capture : null;
    }
    try {
      const workbenchIdempotencyKey = this.workbenchIdempotencyKey(input.idempotencyKey);
      if (input.runId && input.captureLabel && reservedCapture?.backend === "workbench" &&
          typeof reservedCapture.jobId === "string" && typeof reservedCapture.instanceId === "string") {
        const jobId = reservedCapture.jobId;
        const existing = this.workbenchJobs.get(jobId);
        if (existing && (existing.instanceId !== reservedCapture.instanceId ||
            (existing.runId !== undefined && existing.runId !== input.runId) ||
            (existing.captureLabel !== undefined && existing.captureLabel !== input.captureLabel))) {
          throw new ObserverCoordinatorError(
            "STALE_INSTANCE",
            "Durable Workbench capture association conflicts with the retained coordinator job"
          );
        }
        const tracked: TrackedWorkbenchJob = existing ?? {
          instanceId: reservedCapture.instanceId,
          performancePolicy: input.performancePolicy === "instrumented" ? "instrumented" : "evidence",
          requestedView: input.view,
          adapterAttached: false,
          recoveredAssociation: true,
        };
        tracked.sessionId = input.sessionId;
        tracked.instanceId = reservedCapture.instanceId;
        tracked.runId = input.runId;
        tracked.captureLabel = input.captureLabel;
        tracked.performancePolicy = input.performancePolicy === "instrumented" ? "instrumented" : "evidence";
        tracked.requestedView = input.view;
        if (input.expectedWorldId !== undefined) tracked.expectedWorldId = input.expectedWorldId;
        if (input.expectedWorldEpoch !== undefined) tracked.expectedWorldEpoch = input.expectedWorldEpoch;
        this.workbenchJobs.set(jobId, tracked);
        this.workbenchIdempotencyByJob.set(jobId, workbenchIdempotencyKey);
        if (reservedCapture.state === "completed" && reservedCapture.artifactAvailable === true) {
          if (input.asynchronous) {
            return {
              asynchronous: true,
              job: await this.jobStatus(input.sessionId, jobId),
            };
          }
          const completed = await this.readJob(input.sessionId, jobId);
          return { asynchronous: false, ...completed };
        }
        const retained: WorkbenchIdempotencyRecord = {
          fingerprint: this.workbenchCaptureFingerprint(input, timeoutMs),
          submission: this.recoverOrSubmitBoundWorkbench(input, jobId, tracked.instanceId),
        };
        this.workbenchIdempotency.set(workbenchIdempotencyKey, retained);
      }
      if (this.workbenchIdempotency.has(workbenchIdempotencyKey)) {
        return await this.captureWorkbench(input, timeoutMs, workbenchIdempotencyKey);
      }
      if (await this.shouldRouteToWorkbench(input)) {
        return await this.captureWorkbench(input, timeoutMs, workbenchIdempotencyKey);
      }
      if (!input.sessionId) {
        throw new ObserverCoordinatorError(
          "INVALID_REQUEST",
          "sessionId is required for runtime capture; omit it only when selecting a live Workbench observer instance"
        );
      }
      return await this.captureRuntime(input as ObserverCaptureInput & { sessionId: string }, timeoutMs);
    } catch (error) {
      if (input.runId && input.captureLabel) {
        const code = canonicalPublicObserverErrorCode(
          error instanceof ObserverCoordinatorError ? error.code : "INTERNAL_ERROR"
        );
        const message = error instanceof Error ? error.message : "Observer capture failed";
        await this.request("runFailCapture", {
          runId: input.runId,
          captureLabel: input.captureLabel,
          code,
          message: message.slice(0, 512),
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  private async captureRuntime(
    input: ObserverCaptureInput & { sessionId: string },
    timeoutMs: number
  ): Promise<ObserverCaptureResult> {
    const deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
    const submitted = asRecord(await this.request("submitJob", {
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
      ...(input.instanceId ? { instanceId: input.instanceId } : {}),
      deadlineAt,
      deadlinePolicyMs: timeoutMs,
      view: input.view,
      settleFrames: input.settleFrames ?? 0,
      performancePolicy: input.performancePolicy ?? "evidence",
      ...(input.expectedWorldId !== undefined ? { expectedWorldId: input.expectedWorldId } : {}),
      ...(input.expectedWorldEpoch !== undefined ? { expectedWorldEpoch: input.expectedWorldEpoch } : {}),
    }), "Observer job submission");
    if (input.runId && input.captureLabel) {
      await this.request("runBindCapture", {
        runId: input.runId,
        captureLabel: input.captureLabel,
        backend: "runtime",
        sessionId: input.sessionId,
        jobId: submitted.jobId,
        instanceId: submitted.instanceId,
        worldId: submitted.worldId ?? null,
        worldEpoch: submitted.worldEpoch,
      });
    }
    if (input.asynchronous) return { asynchronous: true, job: submitted };

    const jobId = typeof submitted.jobId === "string" ? submitted.jobId : null;
    if (!jobId) throw new ObserverCoordinatorError("TRANSPORT_UNAVAILABLE", "Observer agent returned a job without an ID");
    let job = submitted;
    try {
      for (;;) {
        const state = typeof job.state === "string" ? job.state : "";
        if (TERMINAL_STATES.has(state)) break;
        const remaining = Date.parse(deadlineAt) - Date.now();
        if (remaining <= 0) throw new ObserverCoordinatorError("CAPTURE_TIMEOUT", "Observer capture exceeded its deadline");
        await sleep(Math.min(this.pollIntervalMs, remaining), input.signal);
        job = asRecord(await this.request("jobStatus", { sessionId: input.sessionId, jobId }), "Observer job status");
      }
    } catch (error) {
      await this.request("cancelJob", { sessionId: input.sessionId, jobId }, 5_000).catch(() => undefined);
      if (error instanceof ObserverCoordinatorError && !error.details) {
        throw new ObserverCoordinatorError(error.code, error.message, { job });
      }
      throw error;
    }

    if (job.state !== "completed") {
      const code = typeof job.terminalErrorCode === "string"
        ? canonicalPublicObserverErrorCode(job.terminalErrorCode)
        : job.state === "cancelled" ? "CANCELLED" : "CAPTURE_REJECTED";
      const message = typeof job.terminalMessage === "string"
        ? job.terminalMessage
        : `Observer capture ended in ${String(job.state)}`;
      throw new ObserverCoordinatorError(code, message, { job });
    }
    let artifact: Record<string, unknown>;
    try {
      artifact = asRecord(await this.request("readArtifact", {
        sessionId: input.sessionId,
        jobId,
        maxBytes: this.maxInlineImageBytes,
      }), "Observer artifact read");
    } catch (error) {
      if (error instanceof ObserverCoordinatorError && error.code === "ARTIFACT_TOO_LARGE") {
        throw new ObserverCoordinatorError(error.code, error.message, { job });
      }
      throw error;
    }
    if (typeof artifact.imageBase64 !== "string") {
      throw new ObserverCoordinatorError("TRANSPORT_UNAVAILABLE", "Observer agent returned an invalid image payload");
    }
    const image = Buffer.from(artifact.imageBase64, "base64");
    if (image.length === 0 || image.length > this.maxInlineImageBytes) {
      throw new ObserverCoordinatorError("ARTIFACT_TOO_LARGE", "Validated observer image exceeds the MCP inline image limit");
    }
    const metadata = isRecord(artifact.metadata) ? artifact.metadata : {};
    return { asynchronous: false, job, image, metadata };
  }

  private async shouldRouteToWorkbench(input: ObserverCaptureInput): Promise<boolean> {
    if (!this.workbenchAdapter) return false;
    const workbench = await this.workbenchInventory();
    if (input.instanceId) {
      const selected = workbench.instances.find((instance) => instance.instanceId === input.instanceId);
      if (selected) {
        this.assertWorkbenchViewCapability(selected, input.view);
        return true;
      }
      if (!input.sessionId) {
        throw new ObserverCoordinatorError("INVALID_REQUEST", "The selected instance is not a live Workbench observer and runtime capture requires sessionId");
      }
      return false;
    }

    if (!input.sessionId) {
      const eligible = workbench.instances.filter((instance) => this.workbenchSupportsView(instance, input.view));
      if (eligible.length === 1) return true;
      if (eligible.length > 1) throw new ObserverCoordinatorError("AMBIGUOUS_INSTANCE", "Multiple compatible Workbench observer instances are available");
      throw new ObserverCoordinatorError(
        "NO_RENDER_ENDPOINT",
        workbench.warning ?? "No compatible already-running exact-owned Workbench observer is available"
      );
    }

    const inventory = await this.instances({ sessionId: input.sessionId, renderersOnly: true });
    const eligible = inventory.instances.filter((instance) => {
      if (!this.isCompatibleInstance(instance, { sessionId: input.sessionId, renderersOnly: true })) return false;
      const capabilities = Array.isArray(instance.capabilities)
        ? instance.capabilities.filter((value): value is string => typeof value === "string")
        : [];
      return input.view.kind === "current"
        ? capabilities.includes("render.capture")
        : instance.backend === "workbench"
          ? capabilities.includes("camera.editor")
          : capabilities.includes("camera.runtime");
    });
    if (eligible.length > 1) {
      throw new ObserverCoordinatorError(
        "AMBIGUOUS_INSTANCE",
        "Multiple compatible runtime/Workbench renderers are available; select instanceId explicitly",
        { instanceIds: eligible.map((instance) => instance.instanceId).filter((value): value is string => typeof value === "string") }
      );
    }
    return eligible.length === 1 && eligible[0].backend === "workbench";
  }

  private workbenchSupportsView(instance: Record<string, unknown>, view: ObserverCaptureView): boolean {
    const capabilities = Array.isArray(instance.capabilities)
      ? instance.capabilities.filter((value): value is string => typeof value === "string")
      : [];
    return capabilities.includes("render.capture") &&
      (view.kind === "current" || capabilities.includes("camera.editor"));
  }

  private assertWorkbenchViewCapability(instance: Record<string, unknown>, view: ObserverCaptureView): void {
    if (!this.workbenchSupportsView(instance, view)) {
      throw new ObserverCoordinatorError(
        "CAPABILITY_UNAVAILABLE",
        view.kind === "current"
          ? "Selected Workbench does not advertise current-view capture"
          : "Selected Workbench has not proven exact restoration and does not advertise camera.editor"
      );
    }
  }

  private async captureWorkbench(
    input: ObserverCaptureInput,
    timeoutMs: number,
    idempotencyKey: string
  ): Promise<ObserverCaptureResult> {
    const adapter = this.workbenchAdapter;
    if (!adapter) throw new ObserverCoordinatorError("NO_RENDER_ENDPOINT", "Workbench observer adapter is unavailable");
    const fingerprint = this.workbenchCaptureFingerprint(input, timeoutMs);
    let retained = this.workbenchIdempotency.get(idempotencyKey);
    if (retained && retained.fingerprint !== fingerprint) {
      throw new ObserverCoordinatorError(
        "IDEMPOTENCY_CONFLICT",
        "Workbench observer idempotency key was reused with a different capture request"
      );
    }
    if (retained?.terminalError) {
      throw new ObserverCoordinatorError(
        retained.terminalError.code,
        retained.terminalError.message,
        retained.terminalError.details
      );
    }
    if (retained?.releaseReceipt) {
      throw new ObserverCoordinatorError(
        "JOB_RELEASED",
        "Workbench observer idempotency key belongs to an already released capture",
        { release: retained.releaseReceipt }
      );
    }
    if (input.performancePolicy === "performance") {
      throw new ObserverCoordinatorError("PERFORMANCE_POLICY_BLOCKED", "Workbench screenshots are not performance-neutral");
    }
    const reused = retained !== undefined;
    if (!retained) {
      const submission = (async (): Promise<WorkbenchObserverJobStatus> => {
        let selected: WorkbenchObserverInstance | undefined;
        if ((input.runId && input.captureLabel) || input.expectedWorldId !== undefined || input.expectedWorldEpoch !== undefined) {
          selected = await this.assertExpectedWorkbenchWorld(input);
        }
        const jobId = input.runId && input.captureLabel ? randomUUID() : undefined;
        if (jobId && selected) {
          // Persist the association before the handler can retain camera state.
          // A crash on either side of submit can then recover or idempotently
          // submit this exact durable job ID without an orphaned transaction.
          await this.request("runBindCapture", {
            runId: input.runId!,
            captureLabel: input.captureLabel!,
            backend: "workbench",
            jobId,
            instanceId: selected.instanceId,
            worldId: selected.worldIdentity,
            worldEpoch: 0,
          });
        }
        return adapter.submit({
          ...(jobId ? { jobId } : {}),
          view: input.view,
          settlePolls: input.settleFrames ?? 0,
        });
      })();
      retained = {
        fingerprint,
        submission,
      };
      // Store the hashed key before awaiting so concurrent client retries share
      // the same in-flight handler transaction instead of racing a second job.
      this.workbenchIdempotency.set(idempotencyKey, retained);
    }
    let status: WorkbenchObserverJobStatus;
    try {
      status = await retained.submission;
      retained.status = status;
      if (reused) {
        const tracked = this.workbenchJobs.get(status.jobId);
        if (tracked?.handlerReleaseReceipt) {
          const managed = await this.inspectManagedWorkbenchArtifact(status.jobId);
          if (managed) {
            if (input.asynchronous) {
              return {
                asynchronous: true,
                job: await this.jobStatus(input.sessionId, status.jobId),
              };
            }
            const completed = await this.readJob(input.sessionId, status.jobId);
            return { asynchronous: false, ...completed };
          }
        }
        status = await adapter.status(status.jobId);
        retained.status = status;
      }
    } catch (error) {
      if (!retained.status && this.workbenchIdempotency.get(idempotencyKey) === retained) {
        this.workbenchIdempotency.delete(idempotencyKey);
      }
      throw this.mapWorkbenchError(error);
    }
    this.workbenchJobs.set(status.jobId, {
      sessionId: input.sessionId,
      instanceId: status.instanceId,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.captureLabel ? { captureLabel: input.captureLabel } : {}),
      performancePolicy: input.performancePolicy === "instrumented" ? "instrumented" : "evidence",
      requestedView: input.view,
      ...(input.expectedWorldId !== undefined ? { expectedWorldId: input.expectedWorldId } : {}),
      ...(input.expectedWorldEpoch !== undefined ? { expectedWorldEpoch: input.expectedWorldEpoch } : {}),
      adapterAttached: true,
      lastStatus: status,
    });
    this.workbenchIdempotencyByJob.set(status.jobId, idempotencyKey);
    if (input.instanceId && status.instanceId !== input.instanceId) {
      let job = this.workbenchPublicJob(status, input.sessionId);
      try {
        status = await adapter.cancel(status.jobId);
        retained.status = status;
        job = this.workbenchPublicJob(status, input.sessionId);
        if (!status.cameraLeaseHeld && status.restorationConfirmed) {
          const released = { backend: "workbench", ...await adapter.release(status.jobId) };
          this.rememberWorkbenchRelease(status.jobId, input.sessionId, released);
        }
      } catch (error) {
        throw new ObserverCoordinatorError(
          "STALE_INSTANCE",
          "Workbench lifecycle generation changed and cancellation did not prove release",
          { job, cancellationError: error instanceof Error ? error.message : String(error) }
        );
      }
      const terminalError = new ObserverCoordinatorError(
        "STALE_INSTANCE",
        "Workbench lifecycle generation changed before capture submission",
        { job }
      );
      retained.terminalError = terminalError;
      throw terminalError;
    }
    if ((input.expectedWorldId !== undefined && status.worldIdentity !== input.expectedWorldId) ||
        (input.expectedWorldEpoch !== undefined && input.expectedWorldEpoch !== 0)) {
      await adapter.cancel(status.jobId).catch(() => undefined);
      throw new ObserverCoordinatorError("WORLD_CHANGED", "Workbench world identity changed before capture submission", {
        expectedWorldId: input.expectedWorldId ?? null,
        actualWorldId: status.worldIdentity,
        expectedWorldEpoch: input.expectedWorldEpoch ?? null,
        actualWorldEpoch: 0,
      });
    }
    if (input.runId && input.captureLabel) {
      await this.request("runBindCapture", {
        runId: input.runId,
        captureLabel: input.captureLabel,
        backend: "workbench",
        jobId: status.jobId,
        instanceId: status.instanceId,
        worldId: status.worldIdentity,
        worldEpoch: 0,
      });
    }
    let job = this.workbenchPublicJob(status, input.sessionId);
    if (input.asynchronous) return { asynchronous: true, job };

    const deadline = Date.now() + timeoutMs;
    try {
      while (!TERMINAL_STATES.has(status.state)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new ObserverCoordinatorError("CAPTURE_TIMEOUT", "Workbench observer capture exceeded its deadline", { job });
        await sleep(Math.min(this.pollIntervalMs, remaining), input.signal);
        status = await adapter.status(status.jobId);
        retained.status = status;
        job = this.workbenchPublicJob(status, input.sessionId);
      }
    } catch (error) {
      await adapter.cancel(status.jobId).catch(() => undefined);
      if (error instanceof ObserverCoordinatorError) throw error;
      throw this.mapWorkbenchError(error, { job });
    }

    if (status.state !== "completed") {
      throw new ObserverCoordinatorError(
        status.terminalErrorCode
          ? canonicalWorkbenchErrorCode(status.terminalErrorCode)
          : (status.state === "cancelled" ? "CANCELLED" : "CAPTURE_REJECTED"),
        status.message,
        { job }
      );
    }
    if ((input.expectedWorldId !== undefined && status.worldIdentity !== input.expectedWorldId) ||
        (input.expectedWorldEpoch !== undefined && input.expectedWorldEpoch !== 0)) {
      throw new ObserverCoordinatorError("WORLD_CHANGED", "Workbench world identity changed before artifact completion", { job });
    }
    let completed: { image: Buffer; metadata: Record<string, unknown> };
    try {
      completed = adapter.readCompletedArtifact(status.jobId);
    } catch (error) {
      throw this.mapWorkbenchError(error, { job });
    }
    const instrumented = input.performancePolicy === "instrumented";
    const metadata = {
      ...completed.metadata,
      actualCamera: status.actualCamera,
      actualFov: status.actualFov,
      completedAt: status.artifact?.completedAt ?? completed.metadata.completedAt,
      worldId: status.worldIdentity,
      worldEpoch: 0,
      instanceId: status.instanceId,
      viewKind: status.viewKind,
      ownerCameraId: status.ownerCameraId,
      requestedView: input.view,
      contaminated: instrumented,
      warnings: instrumented ? ["Workbench capture ran under instrumented performance policy"] : [],
    };
    if (input.runId && input.captureLabel) {
      await this.importWorkbenchArtifact(status.jobId, completed.image, metadata, input.runId, input.captureLabel);
      const tracked = this.workbenchJobs.get(status.jobId);
      if (tracked) await this.retireImportedWorkbenchHandler(status.jobId, tracked, status);
    }
    if (completed.image.length === 0 || completed.image.length > this.maxInlineImageBytes) {
      throw new ObserverCoordinatorError(
        "ARTIFACT_TOO_LARGE",
        "Validated Workbench PNG exceeds the MCP inline limit; finalize its managed run to export it",
        { job }
      );
    }
    return {
      asynchronous: false,
      job,
      image: completed.image,
      metadata,
    };
  }

  private async assertExpectedWorkbenchWorld(input: ObserverCaptureInput): Promise<WorkbenchObserverInstance> {
    if (input.expectedWorldEpoch !== undefined && input.expectedWorldEpoch !== 0) {
      throw new ObserverCoordinatorError("WORLD_CHANGED", "Workbench observer world epoch is 0 and no longer matches the expected epoch");
    }
    const instances = await this.workbenchAdapter!.instances();
    const compatible = instances.filter((instance) => {
      if (input.instanceId && instance.instanceId !== input.instanceId) return false;
      return input.view.kind === "current" || instance.capabilities.includes("camera.editor");
    });
    if (compatible.length !== 1) {
      throw new ObserverCoordinatorError(
        compatible.length === 0 ? "NO_RENDER_ENDPOINT" : "AMBIGUOUS_INSTANCE",
        "Expected-world validation could not identify exactly one compatible Workbench renderer"
      );
    }
    if (input.expectedWorldId !== undefined && compatible[0].worldIdentity !== input.expectedWorldId) {
      throw new ObserverCoordinatorError("WORLD_CHANGED", "Selected Workbench no longer matches the expected world ID", {
        expectedWorldId: input.expectedWorldId,
        actualWorldId: compatible[0].worldIdentity,
      });
    }
    return compatible[0];
  }

  private async recoverOrSubmitBoundWorkbench(
    input: ObserverCaptureInput,
    jobId: string,
    expectedInstanceId: string
  ): Promise<WorkbenchObserverJobStatus> {
    const adapter = this.workbenchAdapter;
    if (!adapter) throw new ObserverCoordinatorError("WORKBENCH_ADAPTER_UNAVAILABLE", "Workbench observer adapter is unavailable");
    try {
      return await adapter.recover({ jobId, expectedInstanceId });
    } catch (error) {
      const mapped = this.mapWorkbenchError(error);
      if (mapped.code !== "JOB_NOT_FOUND") throw mapped;
    }
    // The durable association is written before initial submission. If no
    // matching handler job exists in the same lifecycle, the crash occurred on
    // the pre-submit side of that boundary and the exact job can be submitted.
    const selected = await this.assertExpectedWorkbenchWorld(input);
    if (selected.instanceId !== expectedInstanceId) {
      throw new ObserverCoordinatorError("STALE_INSTANCE", "Durably bound Workbench capture belongs to a different lifecycle instance");
    }
    if (selected.activeJobId && selected.activeJobId !== jobId) {
      throw new ObserverCoordinatorError("CAMERA_BUSY", "A different Workbench observer job is retained; the durable capture was not resubmitted");
    }
    return adapter.submit({
      jobId,
      view: input.view,
      settlePolls: input.settleFrames ?? 0,
    });
  }

  private async importWorkbenchArtifact(
    jobId: string,
    image: Buffer,
    metadata: Record<string, unknown>,
    runId?: string,
    captureLabel?: string
  ): Promise<void> {
    await this.request("importWorkbenchArtifact", {
      jobId,
      image,
      metadata,
      ...(runId && captureLabel ? { runId, captureLabel } : {}),
    }, Math.max(this.requestTimeoutMs, 60_000));
  }

  private workbenchPublicJob(status: WorkbenchObserverJobStatus, sessionId?: string): Record<string, unknown> {
    const artifact = status.artifact
      ? {
          format: "png",
          bytes: status.artifact.pngBytes,
          sourceBytes: status.artifact.bytes,
          width: status.artifact.width,
          height: status.artifact.height,
          contentSha256: status.artifact.pngSha256,
          sourceContentSha256: status.artifact.sha256,
          completedAt: status.artifact.completedAt,
        }
      : undefined;
    return {
      backend: "workbench",
      jobId: status.jobId,
      ...(sessionId ? { sessionId } : {}),
      instanceId: status.instanceId,
      lifecycleGeneration: status.lifecycleGeneration,
      canonicalTarget: status.canonicalTarget,
      worldId: status.worldIdentity,
      worldEpoch: 0,
      viewKind: status.viewKind,
      state: status.state,
      sequence: status.sequence,
      terminalErrorCode: status.terminalErrorCode
        ? canonicalWorkbenchErrorCode(status.terminalErrorCode)
        : undefined,
      terminalMessage: status.message,
      cameraLeaseHeld: status.cameraLeaseHeld,
      restorationConfirmed: status.restorationConfirmed,
      ownerCameraId: status.ownerCameraId,
      actualCamera: status.actualCamera,
      actualFov: status.actualFov,
      ...(artifact ? { artifact } : {}),
    };
  }

  private mapWorkbenchError(error: unknown, details?: Record<string, unknown>): ObserverCoordinatorError {
    const candidate = error as { code?: unknown; message?: unknown };
    return new ObserverCoordinatorError(
      canonicalWorkbenchErrorCode(candidate?.code),
      typeof candidate?.message === "string" ? candidate.message : "Workbench observer operation failed",
      details
    );
  }

  private workbenchIdempotencyKey(value: string): string {
    // The caller-controlled key is never a handler job ID, filename, or map
    // key in plaintext. Only a fixed-size digest is retained locally.
    return createHash("sha256").update(value, "utf8").digest("hex");
  }

  private workbenchCaptureFingerprint(input: ObserverCaptureInput, timeoutMs: number): string {
    const canonical = JSON.stringify({
      sessionId: input.sessionId ?? null,
      instanceId: input.instanceId ?? null,
      view: input.view,
      settleFrames: input.settleFrames ?? 0,
      performancePolicy: input.performancePolicy ?? "evidence",
      timeoutMs,
      runId: input.runId ?? null,
      captureLabel: input.captureLabel ?? null,
      purpose: input.purpose ?? null,
      expectedWorldId: input.expectedWorldId,
      expectedWorldEpoch: input.expectedWorldEpoch,
    });
    return createHash("sha256").update(canonical, "utf8").digest("hex");
  }

  async beginRun(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return asRecord(await this.request("runBegin", input), "Observer run begin");
  }

  async runStatus(runId: string): Promise<Record<string, unknown>> {
    return this.syncWorkbenchRun(runId);
  }

  async finalizeRun(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const runId = typeof input.runId === "string" ? input.runId : "";
    if (!runId) throw new ObserverCoordinatorError("INVALID_REQUEST", "runId is required");
    const before = await this.syncWorkbenchRun(runId);
    const result = asRecord(
      await this.request("runFinalize", input, Math.max(this.requestTimeoutMs, 5 * 60_000)),
      "Observer run finalization"
    );
    if (input.releaseManagedArtifacts !== false) {
      const receipt = asRecord(result.receipt, "Observer run finalization receipt");
      if (receipt.managedArtifactsReleased !== true) {
        throw new ObserverCoordinatorError(
          "TRANSPORT_UNAVAILABLE",
          "Observer run finalization did not confirm managed artifact release"
        );
      }
      const warnings = await this.releaseWorkbenchJobsFromRun(before, true);
      if (warnings.length > 0) result.workbenchReleaseWarnings = warnings;
    }
    return result;
  }

  async discardRun(runId: string): Promise<Record<string, unknown>> {
    const before = await this.syncWorkbenchRun(runId);
    const result = asRecord(await this.request("runDiscard", { runId }), "Observer run discard");
    if (result.discarded !== true) {
      throw new ObserverCoordinatorError(
        "TRANSPORT_UNAVAILABLE",
        "Observer run discard did not confirm managed artifact release"
      );
    }
    const warnings = await this.releaseWorkbenchJobsFromRun(before, true);
    if (warnings.length > 0) result.workbenchReleaseWarnings = warnings;
    return result;
  }

  private recoverWorkbenchAssociations(run: Record<string, unknown>): Array<{
    jobId: string;
    capture: Record<string, unknown>;
    tracked: TrackedWorkbenchJob;
  }> {
    const runId = typeof run.runId === "string" ? run.runId : "";
    const warnings = new Set(Array.isArray(run.warnings) ? run.warnings.filter((item): item is string => typeof item === "string") : []);
    const captures = Array.isArray(run.captures) ? run.captures.filter(isRecord) : [];
    const result: Array<{ jobId: string; capture: Record<string, unknown>; tracked: TrackedWorkbenchJob }> = [];
    for (const capture of captures) {
      if (capture.backend !== "workbench" || typeof capture.jobId !== "string" ||
          typeof capture.captureLabel !== "string" || typeof capture.instanceId !== "string") continue;
      const jobId = capture.jobId;
      let tracked = this.workbenchJobs.get(jobId);
      if (tracked) {
        if ((tracked.runId && tracked.runId !== runId) ||
            (tracked.captureLabel && tracked.captureLabel !== capture.captureLabel) ||
            tracked.instanceId !== capture.instanceId) {
          throw new ObserverCoordinatorError("STALE_INSTANCE", "Durable Workbench capture association conflicts with the retained coordinator job");
        }
        tracked.runId = runId;
        tracked.captureLabel = capture.captureLabel;
        tracked.performancePolicy = warnings.has(`Capture '${capture.captureLabel}' used instrumented policy`) ? "instrumented" : "evidence";
        if (capture.expectedWorldId === null || typeof capture.expectedWorldId === "string") {
          tracked.expectedWorldId = capture.expectedWorldId;
        }
        if (Number.isSafeInteger(capture.expectedWorldEpoch)) tracked.expectedWorldEpoch = capture.expectedWorldEpoch as number;
        tracked.recoveredAssociation = true;
      } else {
        tracked = {
          instanceId: capture.instanceId,
          runId,
          captureLabel: capture.captureLabel,
          performancePolicy: warnings.has(`Capture '${capture.captureLabel}' used instrumented policy`) ? "instrumented" : "evidence",
          // The exact requested pose is intentionally not present in the public
          // run status. Promotion records the handler-reported view kind and a
          // recovery marker instead of fabricating lost pose coordinates.
          requestedView: { kind: "current" },
          ...(capture.expectedWorldId !== undefined && capture.expectedWorldId !== null
            ? { expectedWorldId: String(capture.expectedWorldId) }
            : capture.expectedWorldId === null ? { expectedWorldId: null } : {}),
          ...(Number.isSafeInteger(capture.expectedWorldEpoch) ? { expectedWorldEpoch: capture.expectedWorldEpoch as number } : {}),
          adapterAttached: false,
          recoveredAssociation: true,
        };
        this.workbenchJobs.set(jobId, tracked);
      }
      result.push({ jobId, capture, tracked });
    }
    return result;
  }

  private async attachedWorkbenchStatus(jobId: string, tracked: TrackedWorkbenchJob): Promise<WorkbenchObserverJobStatus> {
    const adapter = this.workbenchAdapter;
    if (!adapter) throw new ObserverCoordinatorError("WORKBENCH_ADAPTER_UNAVAILABLE", "Workbench observer adapter is unavailable");
    const status = tracked.adapterAttached
      ? await adapter.status(jobId)
      : await adapter.recover({ jobId, expectedInstanceId: tracked.instanceId });
    tracked.adapterAttached = true;
    tracked.instanceId = status.instanceId;
    tracked.lastStatus = status;
    return status;
  }

  /**
   * Retire Workbench's single native handler slot only after the validated PNG
   * has been imported into durable managed storage. This deliberately does not
   * populate the public/full release receipt: the managed artifact and run
   * association remain readable and finalizable until observer_job/run release.
   */
  private async retireImportedWorkbenchHandler(
    jobId: string,
    tracked: TrackedWorkbenchJob,
    completedStatus?: WorkbenchObserverJobStatus
  ): Promise<void> {
    if (tracked.handlerReleaseReceipt) return;
    const adapter = this.workbenchAdapter;
    if (!adapter) {
      throw new ObserverCoordinatorError(
        "WORKBENCH_ADAPTER_UNAVAILABLE",
        "Workbench observer adapter is unavailable while retiring an imported handler transaction"
      );
    }

    let status = completedStatus;
    if (!status) {
      try {
        status = tracked.adapterAttached
          ? await adapter.status(jobId)
          : await adapter.recover({ jobId, expectedInstanceId: tracked.instanceId });
        tracked.adapterAttached = true;
      } catch (error) {
        const mapped = this.mapWorkbenchError(error);
        if (mapped.code !== "JOB_NOT_FOUND") throw mapped;
        // The durable artifact could only have been imported after a completed,
        // restoration-confirmed handler status. Absence now proves that no
        // native handler reference remains to release.
        tracked.adapterAttached = false;
        tracked.handlerReleaseReceipt = {
          jobId,
          restorationConfirmed: true,
          artifactRemoved: false,
          handlerAlreadyAbsent: true,
        };
        return;
      }
    }
    tracked.lastStatus = status;
    if (status.jobId !== jobId || status.state !== "completed" ||
        status.cameraLeaseHeld || !status.restorationConfirmed) {
      throw new ObserverCoordinatorError(
        "RESTORATION_UNCONFIRMED",
        `Imported Workbench job ${jobId} cannot release its handler transaction without terminal restoration proof`,
        { job: this.workbenchPublicJob(status, tracked.sessionId) }
      );
    }
    const released = await adapter.release(jobId);
    if (!released.restorationConfirmed) {
      throw new ObserverCoordinatorError(
        "RESTORATION_UNCONFIRMED",
        `Workbench handler release for imported job ${jobId} did not preserve restoration proof`
      );
    }
    tracked.adapterAttached = false;
    tracked.handlerReleaseReceipt = { ...released };
  }

  private async syncWorkbenchRun(runId: string): Promise<Record<string, unknown>> {
    let run = asRecord(await this.request("runStatus", { runId }), "Observer run status");
    const matching = this.recoverWorkbenchAssociations(run);
    for (const { jobId, capture, tracked } of matching) {
      try {
        if (capture.state === "completed" && capture.artifactAvailable === true) {
          // Converge a crash between durable import and native handler release.
          // A known handler-only receipt makes this a no-op in the normal path.
          await this.retireImportedWorkbenchHandler(jobId, tracked);
          continue;
        }
        const status = await this.attachedWorkbenchStatus(jobId, tracked);
        const key = this.workbenchIdempotencyByJob.get(jobId);
        if (key) {
          const retained = this.workbenchIdempotency.get(key);
          if (retained) retained.status = status;
        }
        await this.promoteCompletedWorkbench(status, tracked);
      } catch (error) {
        if (tracked.captureLabel) {
          const mapped = this.mapWorkbenchError(error);
          if (!["HANDLER_UNAVAILABLE", "WORKBENCH_ADAPTER_UNAVAILABLE", "TRANSPORT_UNAVAILABLE"].includes(mapped.code)) {
            await this.request("runFailCapture", {
              runId,
              captureLabel: tracked.captureLabel,
              code: mapped.code,
              message: mapped.message.slice(0, 512),
            }).catch(() => undefined);
          }
        }
      }
    }
    run = asRecord(await this.request("runStatus", { runId }), "Observer run status");
    return run;
  }

  private async releaseWorkbenchJobsFromRun(
    run: Record<string, unknown>,
    managedArtifactsAlreadyReleased: boolean
  ): Promise<string[]> {
    const captures = this.recoverWorkbenchAssociations(run);
    const warnings: string[] = [];
    for (const { jobId, tracked } of captures) {
      try {
        await this.releaseWorkbenchJob(
          tracked.sessionId,
          jobId,
          true,
          managedArtifactsAlreadyReleased
        );
      } catch (error) {
        warnings.push(`Workbench job ${jobId}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 512));
      }
    }
    return warnings;
  }

  async jobStatus(sessionId: string | undefined, jobId: string): Promise<Record<string, unknown>> {
    const workbench = this.workbenchJobs.get(jobId);
    if (workbench) {
      this.assertWorkbenchJobSession(workbench.sessionId, sessionId);
      try {
        if (!workbench.adapterAttached) {
          const managed = await this.inspectManagedWorkbenchArtifact(jobId);
          if (managed) {
            return workbench.lastStatus
              ? this.workbenchPublicJob(workbench.lastStatus, workbench.sessionId)
              : this.managedWorkbenchPublicJob(jobId, managed);
          }
        }
        const status = await this.attachedWorkbenchStatus(jobId, workbench);
        const key = this.workbenchIdempotencyByJob.get(jobId);
        if (key) {
          const retained = this.workbenchIdempotency.get(key);
          if (retained) retained.status = status;
        }
        await this.promoteCompletedWorkbench(status, workbench);
        return this.workbenchPublicJob(status, workbench.sessionId);
      } catch (error) {
        throw this.mapWorkbenchError(error);
      }
    }
    if (!sessionId) {
      const managed = await this.inspectManagedWorkbenchArtifact(jobId);
      if (managed) return this.managedWorkbenchPublicJob(jobId, managed);
      try {
        const status = await this.workbenchAdapter!.recover({ jobId });
        this.workbenchJobs.set(jobId, {
          instanceId: status.instanceId,
          performancePolicy: "evidence",
          requestedView: { kind: "current" },
          adapterAttached: true,
          recoveredAssociation: true,
        });
        return this.workbenchPublicJob(status);
      } catch (error) {
        throw this.mapWorkbenchError(error);
      }
    }
    return asRecord(await this.request("jobStatus", { sessionId, jobId }), "Observer job status");
  }

  async cancelJob(sessionId: string | undefined, jobId: string): Promise<Record<string, unknown>> {
    let workbench = this.workbenchJobs.get(jobId);
    if (!workbench && !sessionId) {
      try {
        const recovered = await this.workbenchAdapter!.recover({ jobId });
        workbench = {
          instanceId: recovered.instanceId,
          performancePolicy: "evidence",
          requestedView: { kind: "current" },
          adapterAttached: true,
          recoveredAssociation: true,
        };
        this.workbenchJobs.set(jobId, workbench);
      } catch (error) {
        throw this.mapWorkbenchError(error);
      }
    }
    if (workbench) {
      this.assertWorkbenchJobSession(workbench.sessionId, sessionId);
      try {
        if (!workbench.adapterAttached) await this.attachedWorkbenchStatus(jobId, workbench);
        const status = await this.workbenchAdapter!.cancel(jobId);
        const key = this.workbenchIdempotencyByJob.get(jobId);
        if (key) {
          const retained = this.workbenchIdempotency.get(key);
          if (retained) retained.status = status;
        }
        if (TERMINAL_STATES.has(status.state) && status.state !== "completed" && workbench.runId && workbench.captureLabel) {
          await this.request("runFailCapture", {
            runId: workbench.runId,
            captureLabel: workbench.captureLabel,
            code: status.terminalErrorCode
              ? canonicalWorkbenchErrorCode(status.terminalErrorCode)
              : (status.state === "cancelled" ? "CANCELLED" : "CAPTURE_REJECTED"),
            message: status.message.slice(0, 512),
          }).catch(() => undefined);
        }
        return this.workbenchPublicJob(status, workbench.sessionId);
      } catch (error) {
        throw this.mapWorkbenchError(error);
      }
    }
    if (!sessionId) throw new ObserverCoordinatorError("INVALID_REQUEST", "sessionId is required for runtime observer jobs");
    return asRecord(await this.request("cancelJob", { sessionId, jobId }), "Observer job cancellation");
  }

  async releaseJob(sessionId: string | undefined, jobId: string): Promise<Record<string, unknown>> {
    const receipt = this.workbenchReleaseReceipts.get(jobId);
    if (receipt) {
      this.assertWorkbenchJobSession(receipt.sessionId, sessionId);
      return { ...receipt.result };
    }
    const workbench = this.workbenchJobs.get(jobId);
    if (workbench) {
      this.assertWorkbenchJobSession(workbench.sessionId, sessionId);
      return this.releaseWorkbenchJob(workbench.sessionId, jobId, false);
    }
    if (!sessionId) return this.releaseWorkbenchJob(undefined, jobId, false);
    return asRecord(await this.request("releaseJob", { sessionId, jobId }), "Observer artifact release");
  }

  private async releaseWorkbenchJob(
    sessionId: string | undefined,
    jobId: string,
    cancelIfActive: boolean,
    managedArtifactAlreadyReleased = false
  ): Promise<Record<string, unknown>> {
    const receipt = this.workbenchReleaseReceipts.get(jobId);
    if (receipt) return { ...receipt.result };
    let tracked = this.workbenchJobs.get(jobId);
    const hasManagedAssociation = tracked?.runId !== undefined || (!tracked && await this.inspectManagedWorkbenchArtifact(jobId) !== null);
    try {
      // Direct job release disposes the durable MCP copy first. Run
      // finalize/discard already performed that operation transactionally and
      // passes an authoritative completion fact here, so it must not be issued
      // a second time. In either case handler-only bookkeeping is completed
      // only after managed release is proven.
      const managed = hasManagedAssociation
        ? managedArtifactAlreadyReleased
          ? { released: true, alreadyReleasedByRun: true }
          : asRecord(await this.request("releaseWorkbenchArtifact", { jobId }), "Workbench artifact release")
        : null;

      let released: {
        jobId: string;
        restorationConfirmed: boolean;
        artifactRemoved: boolean;
        handlerAlreadyAbsent?: boolean;
      };
      if (tracked?.handlerReleaseReceipt) {
        released = { ...tracked.handlerReleaseReceipt };
      } else if (tracked?.adapterAttached) {
        try {
          // Attempt release directly so an acknowledgement-lost handler release
          // can replay its exact receipt. A preflight status would fail after
          // the handler has already cleared the job and strand that receipt.
          released = await this.workbenchAdapter!.release(jobId);
        } catch (error) {
          const mapped = this.mapWorkbenchError(error);
          if (!cancelIfActive || mapped.code !== "CAMERA_BUSY") throw mapped;
          let status = await this.workbenchAdapter!.status(jobId);
          if (!TERMINAL_STATES.has(status.state) || status.cameraLeaseHeld || !status.restorationConfirmed) {
            status = await this.workbenchAdapter!.cancel(jobId);
          }
          released = await this.workbenchAdapter!.release(jobId);
        }
      } else {
        let status: WorkbenchObserverJobStatus;
        try {
          status = await this.workbenchAdapter!.recover({
            jobId,
            ...(tracked ? { expectedInstanceId: tracked.instanceId } : {}),
          });
          if (!tracked) {
            tracked = {
              instanceId: status.instanceId,
              performancePolicy: "evidence",
              requestedView: { kind: "current" },
              adapterAttached: true,
              recoveredAssociation: true,
            };
            this.workbenchJobs.set(jobId, tracked);
          } else {
            tracked.adapterAttached = true;
          }
        } catch (error) {
          const mapped = this.mapWorkbenchError(error);
          if (mapped.code !== "JOB_NOT_FOUND") throw mapped;
          const result = {
            backend: "workbench",
            jobId,
            restorationConfirmed: false,
            artifactRemoved: false,
            handlerAlreadyAbsent: true,
            ...(managed ? { managedArtifactReleased: managed.released === true } : {}),
          };
          this.rememberWorkbenchRelease(jobId, sessionId, result);
          return result;
        }
        if (cancelIfActive && (!TERMINAL_STATES.has(status.state) || status.cameraLeaseHeld || !status.restorationConfirmed)) {
          status = await this.workbenchAdapter!.cancel(jobId);
        }
        released = await this.workbenchAdapter!.release(jobId);
      }
      const result = {
        backend: "workbench",
        ...released,
        ...(managed ? { managedArtifactReleased: managed.released === true } : {}),
      };
      this.rememberWorkbenchRelease(jobId, sessionId, result);
      return result;
    } catch (error) {
      throw error instanceof ObserverCoordinatorError ? error : this.mapWorkbenchError(error);
    }
  }

  private async inspectManagedWorkbenchArtifact(jobId: string): Promise<Record<string, unknown> | null> {
    const inspected = asRecord(
      await this.request("inspectWorkbenchArtifact", { jobId }),
      "Workbench artifact inspection"
    );
    if (inspected.available !== true) return null;
    return isRecord(inspected.metadata) ? inspected.metadata : {};
  }

  private managedWorkbenchPublicJob(jobId: string, metadata: Record<string, unknown>): Record<string, unknown> {
    const requestedView = isRecord(metadata.requestedView) ? metadata.requestedView : null;
    return {
      backend: "workbench",
      jobId,
      state: "completed",
      instanceId: metadata.instanceId ?? null,
      worldId: metadata.worldId ?? null,
      worldEpoch: metadata.worldEpoch ?? 0,
      ...(typeof metadata.viewKind === "string"
        ? { viewKind: metadata.viewKind }
        : typeof requestedView?.kind === "string" ? { viewKind: requestedView.kind } : {}),
      cameraLeaseHeld: false,
      restorationConfirmed: true,
      ...(Number.isSafeInteger(metadata.ownerCameraId) ? { ownerCameraId: metadata.ownerCameraId } : {}),
      ...(isRecord(metadata.actualCamera) ? { actualCamera: metadata.actualCamera } : {}),
      ...(typeof metadata.actualFov === "number" ? { actualFov: metadata.actualFov } : {}),
      artifact: {
        format: "png",
        width: metadata.width ?? null,
        height: metadata.height ?? null,
        contentSha256: metadata.contentSha256 ?? null,
        completedAt: metadata.completedAt ?? null,
      },
      recoveredFromManagedArtifact: true,
    };
  }

  async readJob(sessionId: string | undefined, jobId: string): Promise<{
    job: Record<string, unknown>;
    image: Buffer;
    metadata: Record<string, unknown>;
  }> {
    const workbench = this.workbenchJobs.get(jobId);
    let job: Record<string, unknown>;
    let artifact: Record<string, unknown>;
    if (workbench) {
      this.assertWorkbenchJobSession(workbench.sessionId, sessionId);
      job = await this.jobStatus(sessionId, jobId);
      if (job.state !== "completed") throw new ObserverCoordinatorError("ARTIFACT_INCOMPLETE", "Workbench capture is not completed");
      artifact = asRecord(await this.request("readWorkbenchArtifact", { jobId, maxBytes: this.maxInlineImageBytes }), "Workbench artifact read");
    } else {
      if (!sessionId) {
        artifact = asRecord(await this.request("readWorkbenchArtifact", { jobId, maxBytes: this.maxInlineImageBytes }), "Workbench artifact read");
        const metadata = isRecord(artifact.metadata) ? artifact.metadata : {};
        job = this.managedWorkbenchPublicJob(jobId, metadata);
      } else {
        try {
          artifact = asRecord(await this.request("readArtifact", { sessionId, jobId, maxBytes: this.maxInlineImageBytes }), "Observer artifact read");
        } catch (error) {
          let status: Record<string, unknown>;
          try { status = await this.jobStatus(sessionId, jobId); } catch { throw error; }
          if (status.state !== "completed") throw new ObserverCoordinatorError("ARTIFACT_INCOMPLETE", "Runtime capture is not completed", { job: status });
          throw error;
        }
        try {
          job = await this.jobStatus(sessionId, jobId);
        } catch {
          const metadata = isRecord(artifact.metadata) ? artifact.metadata : {};
          job = {
            backend: "runtime",
            sessionId,
            jobId,
            state: "completed",
            instanceId: metadata.instanceId ?? null,
            worldId: metadata.worldId ?? null,
            worldEpoch: metadata.worldEpoch ?? null,
            artifact: {
              width: metadata.width ?? null,
              height: metadata.height ?? null,
              contentSha256: metadata.contentSha256 ?? null,
              completedAt: metadata.completedAt ?? null,
            },
            recoveredFromManagedArtifact: true,
          };
        }
      }
    }
    if (typeof artifact.imageBase64 !== "string") throw new ObserverCoordinatorError("TRANSPORT_UNAVAILABLE", "Observer agent returned an invalid image payload");
    const image = Buffer.from(artifact.imageBase64, "base64");
    if (image.length === 0 || image.length > this.maxInlineImageBytes) throw new ObserverCoordinatorError("ARTIFACT_TOO_LARGE", "Validated observer PNG exceeds the MCP inline limit");
    return { job, image, metadata: isRecord(artifact.metadata) ? artifact.metadata : {} };
  }

  private async promoteCompletedWorkbench(
    status: WorkbenchObserverJobStatus,
    tracked: TrackedWorkbenchJob
  ): Promise<void> {
    if (!tracked.runId || !tracked.captureLabel) return;
    if (status.state !== "completed") {
      if (TERMINAL_STATES.has(status.state) && tracked.runId && tracked.captureLabel) {
        await this.request("runFailCapture", {
          runId: tracked.runId,
          captureLabel: tracked.captureLabel,
          code: status.terminalErrorCode
            ? canonicalWorkbenchErrorCode(status.terminalErrorCode)
            : (status.state === "cancelled" ? "CANCELLED" : "CAPTURE_REJECTED"),
          message: status.message.slice(0, 512),
        }).catch(() => undefined);
      }
      return;
    }
    if ((tracked.expectedWorldId !== undefined && status.worldIdentity !== tracked.expectedWorldId) ||
        (tracked.expectedWorldEpoch !== undefined && tracked.expectedWorldEpoch !== 0)) {
      await this.request("runFailCapture", {
        runId: tracked.runId,
        captureLabel: tracked.captureLabel,
        code: "WORLD_CHANGED",
        message: "Workbench world identity changed before artifact completion",
      });
      return;
    }
    let completed: { image: Buffer; metadata: Record<string, unknown> };
    try {
      completed = this.workbenchAdapter!.readCompletedArtifact(status.jobId);
    } catch (error) {
      throw this.mapWorkbenchError(error, { job: this.workbenchPublicJob(status) });
    }
    const instrumented = tracked.performancePolicy === "instrumented";
    await this.importWorkbenchArtifact(status.jobId, completed.image, {
      ...completed.metadata,
      actualCamera: status.actualCamera,
      actualFov: status.actualFov,
      completedAt: status.artifact?.completedAt ?? completed.metadata.completedAt,
      worldId: status.worldIdentity,
      worldEpoch: 0,
      instanceId: status.instanceId,
      viewKind: status.viewKind,
      ownerCameraId: status.ownerCameraId,
      requestedView: tracked.recoveredAssociation
        ? { kind: status.viewKind, detailsUnavailableAfterCoordinatorRestart: true }
        : tracked.requestedView,
      contaminated: instrumented,
      warnings: [
        ...(instrumented ? ["Workbench capture ran under instrumented performance policy"] : []),
        ...(tracked.recoveredAssociation ? ["Workbench capture association was recovered after coordinator restart"] : []),
      ],
    }, tracked.runId, tracked.captureLabel);
    tracked.lastStatus = status;
    await this.retireImportedWorkbenchHandler(status.jobId, tracked, status);
  }

  private assertWorkbenchJobSession(expected: string | undefined, supplied: string | undefined): void {
    if (expected && supplied && expected !== supplied) {
      throw new ObserverCoordinatorError("SESSION_MISMATCH", "Workbench observer job was submitted with a different optional session context");
    }
  }

  private rememberWorkbenchRelease(
    jobId: string,
    sessionId: string | undefined,
    result: Record<string, unknown>
  ): void {
    const idempotencyKey = this.workbenchIdempotencyByJob.get(jobId);
    if (idempotencyKey) {
      const retained = this.workbenchIdempotency.get(idempotencyKey);
      if (retained) retained.releaseReceipt = { ...result };
    }
    this.workbenchReleaseReceipts.set(jobId, {
      sessionId,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      result: { ...result },
    });
    this.workbenchJobs.delete(jobId);
    this.workbenchIdempotencyByJob.delete(jobId);
    while (this.workbenchReleaseReceipts.size > MAX_WORKBENCH_RELEASE_RECEIPTS) {
      const oldest = this.workbenchReleaseReceipts.entries().next().value as
        | [string, { idempotencyKey?: string }]
        | undefined;
      if (!oldest) break;
      this.workbenchReleaseReceipts.delete(oldest[0]);
      if (oldest[1].idempotencyKey) this.workbenchIdempotency.delete(oldest[1].idempotencyKey);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      if (this.workbenchAdapter) {
        try {
          await this.workbenchAdapter.restoreAll();
        } catch (error) {
          logger.warn(
            `Workbench observer shutdown restoration failed: ${redactChildLine(error instanceof Error ? error.message : String(error))}`
          );
        }
      }
      const child = this.child;
      if (!child) return;
      try {
        if (child.connected && this.descriptor) {
          await this.request("shutdown", {}, 2_000, true).catch(() => undefined);
        } else if (child.connected) {
          child.disconnect();
        }
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            child.removeListener("exit", exited);
            if (child.connected) child.disconnect();
            child.kill();
            resolve();
          }, 2_000);
          timer.unref();
          const exited = (): void => {
            clearTimeout(timer);
            resolve();
          };
          child.once("exit", exited);
        });
      } finally {
        this.child = null;
        this.descriptor = null;
        this.rejectAll(new ObserverCoordinatorError("TRANSPORT_UNAVAILABLE", "Observer coordinator stopped"));
      }
    })().finally(() => {
      this.closed = true;
      this.closing = false;
    });
    return this.closePromise;
  }

  private attachChild(child: ChildProcess): void {
    let stderrBuffer = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrBuffer = `${stderrBuffer}${chunk}`.slice(-8_192);
      for (;;) {
        const newline = stderrBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stderrBuffer.slice(0, newline).trim();
        stderrBuffer = stderrBuffer.slice(newline + 1);
        if (line) logger.warn(`observer child: ${redactChildLine(line)}`);
      }
    });
    child.on("message", (message: unknown) => this.onMessage(message));
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.rejectStartup?.(new ObserverCoordinatorError("TRANSPORT_UNAVAILABLE", `Private observer agent failed: ${error.message}`));
      this.descriptor = null;
      this.rejectAll(new ObserverCoordinatorError("TRANSPORT_UNAVAILABLE", "Private observer agent became unavailable"));
      child.kill();
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      if (stderrBuffer.trim()) logger.warn(`observer child: ${redactChildLine(stderrBuffer.trim())}`);
      this.child = null;
      this.descriptor = null;
      const detail = code === 0 || this.closing ? "Private observer agent stopped" : `Private observer agent exited (${code ?? signal ?? "unknown"})`;
      const error = new ObserverCoordinatorError("TRANSPORT_UNAVAILABLE", detail);
      this.rejectStartup?.(error);
      this.rejectStartup = null;
      this.rejectAll(error);
    });
  }

  private onMessage(message: unknown): void {
    if (!isRecord(message) || message.protocol !== CHILD_PROTOCOL) return;
    if (message.type === "fatal") {
      const error = isRecord(message.error) ? message.error : {};
      const reject = this.rejectStartup;
      this.rejectStartup = null;
      reject?.(new ObserverCoordinatorError(
        canonicalPublicObserverErrorCode(error.code, "TRANSPORT_UNAVAILABLE"),
        typeof error.message === "string" ? error.message : "Private observer agent failed during startup"
      ));
      this.child?.kill();
      return;
    }
    if (message.type !== "response" || typeof message.requestId !== "string") return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.ok === true) {
      pending.resolve(message.result);
      return;
    }
    const error = isRecord(message.error) ? message.error : {};
    pending.reject(new ObserverCoordinatorError(
      canonicalPublicObserverErrorCode(error.code),
      typeof error.message === "string" ? error.message : "Observer operation failed"
    ));
  }

  private async request(
    operation: string,
    payload: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs,
    allowClosing = false
  ): Promise<unknown> {
    if ((!allowClosing && this.closing) || this.closed) {
      throw new ObserverCoordinatorError("TRANSPORT_UNAVAILABLE", "Observer coordinator is unavailable");
    }
    if (!allowClosing) await this.ensureStarted();
    const child = this.child;
    if (!child?.connected) throw new ObserverCoordinatorError("TRANSPORT_UNAVAILABLE", "Private observer agent is unavailable");
    return this.sendRequest(child, operation, payload, timeoutMs);
  }

  private sendRequest(
    child: ChildProcess,
    operation: string,
    payload: Record<string, unknown>,
    timeoutMs: number
  ): Promise<unknown> {
    if (!child.connected) {
      return Promise.reject(new ObserverCoordinatorError("TRANSPORT_UNAVAILABLE", "Private observer agent is unavailable"));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ObserverCoordinatorError("TRANSPORT_UNAVAILABLE", `Observer ${operation} request timed out`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(requestId, { resolve, reject, timer });
      child.send({ protocol: CHILD_PROTOCOL, type: "request", requestId, operation, payload }, (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        reject(new ObserverCoordinatorError("TRANSPORT_UNAVAILABLE", "Could not send a private observer request"));
      });
    });
  }

  private isCompatibleInstance(instance: Record<string, unknown>, query: ObserverInstanceQuery): boolean {
    // Workbench is not launched through an observer session. A supplied
    // runtime session narrows runtime records only; it must not silently hide
    // an already-running Workbench renderer from ambiguity/capability checks.
    if (query.sessionId && instance.backend !== "workbench" && instance.sessionId !== query.sessionId) return false;
    if (instance.stale === true || instance.transportHealthy === false) return false;
    const capabilities = Array.isArray(instance.capabilities)
      ? instance.capabilities.filter((value): value is string => typeof value === "string")
      : [];
    if (query.renderersOnly && (instance.headless === true || !capabilities.includes("render.capture"))) return false;
    return (query.requiredCapabilities ?? []).every((capability) => capabilities.includes(capability));
  }

  private parseDescriptor(value: unknown): ObserverChildDescriptor {
    const descriptor = asRecord(value, "Private observer startup");
    if (typeof descriptor.protocolVersion !== "string" || !/^1\.\d+$/.test(descriptor.protocolVersion) ||
        typeof descriptor.agentVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(descriptor.agentVersion) ||
        typeof descriptor.agentInstanceId !== "string" || descriptor.agentInstanceId.length < 1 || descriptor.agentInstanceId.length > 96 ||
        (descriptor.host !== "127.0.0.1" && descriptor.host !== "::1") ||
        !Number.isInteger(descriptor.port) || (descriptor.port as number) < 1 || (descriptor.port as number) > 65_535) {
      throw new ObserverCoordinatorError("TRANSPORT_UNAVAILABLE", "Private observer agent returned an invalid startup descriptor");
    }
    return descriptor as unknown as ObserverChildDescriptor;
  }

  private rejectAll(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }
}
