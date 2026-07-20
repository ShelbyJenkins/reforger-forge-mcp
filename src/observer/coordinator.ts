import {
  createObserverApplication,
  type CreateObserverApplicationOptions,
  type ObserverApplication,
  type ObserverCaptureInput,
  type ObserverCaptureResult,
  type ObserverInstanceList,
  type ObserverInstanceQuery,
} from "./application.js";
import type { ObserverChildDescriptor } from "./agent-client.js";
import type {
  OwnedRuntimeLifecycleAuthority,
  OwnedRuntimeLifecycleIdentity,
  RuntimeStopPreflight,
} from "./owned-runtime-manager.js";

export { ObserverCoordinatorError } from "./errors.js";
export { redactChildLine } from "./agent-client.js";
export type { ObserverChildDescriptor } from "./agent-client.js";
export type {
  CreateObserverApplicationOptions as ObserverCoordinatorOptions,
  ObserverCaptureInput,
  ObserverCaptureResult,
  ObserverCaptureView,
  ObserverInstanceList,
  ObserverInstanceQuery,
} from "./application.js";

/**
 * Stage-4 compatibility facade. All mutable construction and domain ownership
 * live in createObserverApplication(); this class remains only for consumers
 * that still instantiate the historical coordinator name.
 */
export class ObserverCoordinator {
  readonly application: ObserverApplication;
  readonly maxInlineImageBytes: number;
  readonly defaultCaptureTimeoutMs: number;

  constructor(options?: CreateObserverApplicationOptions);
  constructor(application: ObserverApplication);
  constructor(value: CreateObserverApplicationOptions | ObserverApplication = {}) {
    this.application = "captureService" in value && "evidenceRuns" in value
      ? value as ObserverApplication
      : createObserverApplication(value as CreateObserverApplicationOptions);
    this.maxInlineImageBytes = this.application.maxInlineImageBytes;
    this.defaultCaptureTimeoutMs = this.application.defaultCaptureTimeoutMs;
  }

  static create(options: CreateObserverApplicationOptions = {}): ObserverCoordinator {
    return new ObserverCoordinator(createObserverApplication(options));
  }

  /** Compatibility constructor helper retained for direct callers. */
  // TypeScript cannot overload a public constructor with two implementation
  // bodies, so options are detected by the factory below at runtime.
  get child(): unknown { return this.application.child; }
  diagnosticPrivateChildCount(): number { return this.application.diagnosticPrivateChildCount(); }
  ensureStarted(): Promise<ObserverChildDescriptor> { return this.application.ensureStarted(); }
  status(): Promise<Record<string, unknown>> { return this.application.status(); }
  doctor(): Promise<Record<string, unknown>> { return this.application.doctor(); }
  ensureSetup(): Promise<Record<string, unknown>> { return this.application.ensureSetup(); }
  uninstall(): Promise<Record<string, unknown>> { return this.application.uninstall(); }
  prepareLaunch(input: Record<string, unknown>): Promise<Record<string, unknown>> { return this.application.prepareLaunch(input); }
  revokeSession(sessionId: string): Promise<Record<string, unknown>> { return this.application.revokeSession(sessionId); }
  retainRuntimeLifecycle(sessionId: string, runtimeId: string, generation: string, authority: OwnedRuntimeLifecycleAuthority): Promise<Record<string, unknown>> {
    return this.application.retainRuntimeLifecycle(sessionId, runtimeId, generation, authority);
  }
  releaseRuntimeLifecycle(sessionId: string, runtimeId: string, generation: string): Promise<Record<string, unknown>> {
    return this.application.releaseRuntimeLifecycle(sessionId, runtimeId, generation);
  }
  reserveRuntimeStop(sessionId: string, reservationId: string, exactRuntimeVacant = false, lifecycle?: OwnedRuntimeLifecycleIdentity): Promise<RuntimeStopPreflight> {
    return this.application.reserveRuntimeStop(sessionId, reservationId, exactRuntimeVacant, lifecycle);
  }
  releaseRuntimeStop(sessionId: string, reservationId: string, lifecycle?: OwnedRuntimeLifecycleIdentity): Promise<Record<string, unknown>> {
    return this.application.releaseRuntimeStop(sessionId, reservationId, lifecycle);
  }
  completeRuntimeStop(sessionId: string, reservationId?: string, exactRuntimeVacant = false, lifecycle?: OwnedRuntimeLifecycleIdentity): Promise<Record<string, unknown>> {
    return this.application.completeRuntimeStop(sessionId, reservationId, exactRuntimeVacant, lifecycle);
  }
  instances(query: ObserverInstanceQuery = {}): Promise<ObserverInstanceList> { return this.application.instances(query); }
  capture(input: ObserverCaptureInput): Promise<ObserverCaptureResult> { return this.application.capture(input); }
  beginRun(input: Record<string, unknown>): Promise<Record<string, unknown>> { return this.application.beginRun(input); }
  runStatus(runId: string): Promise<Record<string, unknown>> { return this.application.runStatus(runId); }
  finalizeRun(input: Record<string, unknown>): Promise<Record<string, unknown>> { return this.application.finalizeRun(input); }
  discardRun(runId: string): Promise<Record<string, unknown>> { return this.application.discardRun(runId); }
  jobStatus(sessionId: string | undefined, jobId: string): Promise<Record<string, unknown>> { return this.application.jobStatus(sessionId, jobId); }
  cancelJob(sessionId: string | undefined, jobId: string): Promise<Record<string, unknown>> { return this.application.cancelJob(sessionId, jobId); }
  releaseJob(sessionId: string | undefined, jobId: string): Promise<Record<string, unknown>> { return this.application.releaseJob(sessionId, jobId); }
  readJob(sessionId: string | undefined, jobId: string): Promise<{ job: Record<string, unknown>; image: Buffer; metadata: Record<string, unknown> }> {
    return this.application.readJob(sessionId, jobId);
  }
  close(): Promise<void> { return this.application.close(); }
}

export function createObserverCoordinator(options: CreateObserverApplicationOptions = {}): ObserverCoordinator {
  return new ObserverCoordinator(createObserverApplication(options));
}
