import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { OBSERVER_TERMINAL_STATES } from "../observer/protocol/enforce-contract.js";
import {
  isCanonicalFaultMatrixTerminal,
  type FaultMatrixCase,
  type FaultMatrixTerminal,
  type WorkbenchFaultMatrixCase,
} from "../observer/protocol/fault-matrix.js";
import {
  deadlineAt,
  pollUntil,
  systemClock,
  systemSleeper,
} from "../src/foundation/time.js";
import {
  type ObserverApplication,
  type ObserverCaptureResult,
  type ObserverCaptureView,
} from "../src/observer/application.js";
import { workbenchWorldRevision } from "../src/observer/world-revision.js";
import {
  WorkbenchObserverAdapter,
  workbenchCameraMatrix,
  type WorkbenchCameraMatrix,
  type WorkbenchObserverJobStatus,
} from "../src/workbench/observer-adapter.js";
import type { FaultMatrixScheduler } from "./observer-fault-matrix-support.js";
import {
  matrixRetainedDiagnostic,
  operationalBaselineProcedureSha256,
  type MatrixCaseEntry,
} from "./observer-live-acceptance-support.js";
import type {
  WorkbenchDecoyIdentityResult,
  WorkbenchHandlerLossResult,
  WorkbenchPngMutationResult,
} from "./observer-workbench-failure-support.js";

const TERMINAL_STATES = new Set<string>(OBSERVER_TERMINAL_STATES);

export type WorkbenchMatrixCaseApplication = Pick<
  ObserverApplication, "capture" | "cancelJob" | "jobStatus" | "readJob"
>;

export type WorkbenchMatrixCaseAdapter = Pick<
  WorkbenchObserverAdapter,
  "ping" | "status" | "release"
>;

export type WorkbenchMatrixCaseScheduler = Pick<
  FaultMatrixScheduler,
  "arm" | "releaseBarrier" | "finishCase" | "finishAfterExactOwnerExit"
>;

export interface WorkbenchMatrixShutdownEvidence {
  readonly exactOwnerVacant: boolean;
  readonly decoy?: WorkbenchDecoyIdentityResult;
}

export interface WorkbenchMatrixValidatedCapture {
  readonly submitted: Record<string, unknown>;
  readonly completed: Record<string, unknown>;
  readonly image: Buffer;
  readonly metadata: Record<string, unknown>;
}

export interface WorkbenchMatrixCaseActions {
  readonly armHandlerLoss?: (input: {
    readonly phase: WorkbenchFaultMatrixCase["injection"]["phase"];
    readonly jobId: string | null;
  }) => void;
  readonly handlerLossResult?: () => WorkbenchHandlerLossResult;
  readonly replaceFixtureWorld?: () => Promise<void>;
  readonly confirmFixtureWorldReplacement?: () => Promise<{ readonly currentWorldId: string }>;
  readonly shutdownOwnedWorkbench?: () => Promise<WorkbenchMatrixShutdownEvidence>;
  readonly verifyShutdownDecoy?: () => Promise<WorkbenchDecoyIdentityResult | undefined>;
  readonly armTerminalReleaseOwnerShutdown?: (jobId: string) => void;
  readonly requireExactOwnerExit?: (jobId: string) => void;
  readonly confirmExactOwnerExit?: (jobId: string, exactOwnerVacant: boolean) => void;
  readonly artifactMutationResult?: () => WorkbenchPngMutationResult | null;
  readonly finalizeValidatedCapture?: (
    capture: WorkbenchMatrixValidatedCapture
  ) => Promise<{ readonly manifestPublished: boolean }>;
  readonly discardRun?: () => Promise<void>;
}

export interface RunWorkbenchMatrixCaseInput {
  readonly application: WorkbenchMatrixCaseApplication;
  readonly adapter: WorkbenchMatrixCaseAdapter;
  readonly scheduler: WorkbenchMatrixCaseScheduler;
  readonly actions: WorkbenchMatrixCaseActions;
  readonly matrixCase: WorkbenchFaultMatrixCase;
  readonly runId: string;
  readonly instanceId: string;
  readonly expectedWorldRevision: string;
  readonly expectedWorldId: string;
  readonly baselineCurrent: Pick<
    WorkbenchObserverJobStatus, "actualCamera" | "ownerCameraId" | "worldIdentity"
  >;
  readonly captureView: ObserverCaptureView;
  readonly caseStartedAt: number;
  readonly caseDeadline: number;
  readonly caseBudgetMs: number;
  readonly onPublicTerminal?: (terminal: FaultMatrixTerminal) => void;
}

/** Compatibility input retained for callers of the original pilot helper. */
export interface RunWorkbenchCancelBarrierCaseInput extends Omit<
  RunWorkbenchMatrixCaseInput, "actions" | "captureView" | "matrixCase"
> {
  readonly matrixCase: FaultMatrixCase;
  readonly poseView: ObserverCaptureView;
  readonly actions?: WorkbenchMatrixCaseActions;
}

interface SettledCapture {
  readonly result?: ObserverCaptureResult;
  readonly error?: unknown;
}

export function remainingWorkbenchMatrixCaptureTimeout(
  caseDeadline: number,
  now = Date.now()
): number {
  const remainingMs = caseDeadline - now;
  if (remainingMs < 1_000) {
    throw new Error("Workbench matrix case deadline expired before capture dispatch");
  }
  return Math.min(5 * 60_000, remainingMs);
}

export function remainingWorkbenchMatrixStepTimeout(
  caseDeadline: number,
  maximumMs: number,
  step: string,
  now = Date.now()
): number {
  if (!Number.isSafeInteger(maximumMs) || maximumMs <= 0) {
    throw new TypeError("Workbench matrix step timeout maximum must be a positive integer");
  }
  const remainingMs = Math.floor(caseDeadline - now);
  if (remainingMs <= 0) {
    throw new Error(`Workbench matrix case deadline expired before ${step}`);
  }
  return Math.min(maximumMs, remainingMs);
}

function settledCapture(operation: Promise<ObserverCaptureResult>): Promise<SettledCapture> {
  return operation.then(
    (result) => ({ result }),
    (error: unknown) => ({ error })
  );
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is missing`);
  }
  return value;
}

function finiteMatrix(matrix: WorkbenchCameraMatrix): void {
  if (matrix.length !== 4 || matrix.some((axis) =>
    axis.length !== 3 || axis.some((value) => !Number.isFinite(value)))) {
    throw new Error("Workbench observer returned a non-finite camera matrix");
  }
}

function assertCameraMatrixClose(
  expected: WorkbenchCameraMatrix,
  actual: WorkbenchCameraMatrix,
  tolerance = 0.002,
  comparePosition = true
): void {
  finiteMatrix(expected);
  finiteMatrix(actual);
  for (let axis = 0; axis < (comparePosition ? 4 : 3); axis += 1) {
    for (let component = 0; component < 3; component += 1) {
      if (Math.abs(expected[axis][component] - actual[axis][component]) > tolerance) {
        throw new Error(
          `Camera restoration mismatch at matrix[${axis}][${component}]: ` +
          `${expected[axis][component]} != ${actual[axis][component]}`
        );
      }
    }
  }
}

function canonicalTerminalFromStatus(status: Record<string, unknown>): FaultMatrixTerminal {
  const terminal: FaultMatrixTerminal = {
    state: status.state as FaultMatrixTerminal["state"],
    errorCode: status.state === "failed" && typeof status.terminalErrorCode === "string"
      ? status.terminalErrorCode as FaultMatrixTerminal["errorCode"]
      : null,
  };
  if (!isCanonicalFaultMatrixTerminal(terminal)) {
    throw new Error(
      `Workbench matrix observed a non-canonical public terminal state=${String(status.state)} ` +
      `errorCode=${String(status.terminalErrorCode ?? null)}`
    );
  }
  return terminal;
}

function canonicalTerminalFromError(error: unknown): FaultMatrixTerminal {
  let code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "INTERNAL_ERROR";
  if (["HANDLER_UNAVAILABLE", "TIMEOUT", "CONNECTION_REFUSED", "PROTOCOL_ERROR"].includes(code)) {
    code = "TRANSPORT_UNAVAILABLE";
  }
  const terminal = { state: "failed", errorCode: code };
  return isCanonicalFaultMatrixTerminal(terminal)
    ? terminal
    : { state: "failed", errorCode: "INTERNAL_ERROR" };
}

function workbenchCameraProof(
  status: Record<string, unknown>,
  label: string
): Pick<WorkbenchObserverJobStatus, "actualCamera" | "ownerCameraId" | "worldIdentity"> {
  const actualCamera = status.actualCamera;
  if (!actualCamera || typeof actualCamera !== "object" || Array.isArray(actualCamera)) {
    throw new Error(`${label} omitted its independently observable camera`);
  }
  const camera = actualCamera as Record<string, unknown>;
  const matrix = camera.matrix as WorkbenchCameraMatrix;
  finiteMatrix(matrix);
  const position = camera.position;
  if (!Array.isArray(position) || position.length !== 3 ||
      position.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`${label} returned an invalid camera position`);
  }
  const verticalFov = camera.verticalFov;
  const nearPlane = camera.nearPlane;
  const farPlane = camera.farPlane;
  const ownerCameraId = status.ownerCameraId;
  const worldIdentity = status.worldIdentity;
  if (typeof verticalFov !== "number" || !Number.isFinite(verticalFov) ||
      typeof nearPlane !== "number" || !Number.isFinite(nearPlane) ||
      typeof farPlane !== "number" || !Number.isFinite(farPlane) ||
      typeof ownerCameraId !== "number" || !Number.isInteger(ownerCameraId) ||
      typeof worldIdentity !== "string" || worldIdentity.length === 0) {
    throw new Error(`${label} returned incomplete camera/FOV/owner/world evidence`);
  }
  return {
    actualCamera: {
      matrix,
      position: position as [number, number, number],
      verticalFov,
      nearPlane,
      farPlane,
    },
    ownerCameraId,
    worldIdentity,
  };
}

function assertRequestedWorkbenchMatrixView(
  requested: ObserverCaptureView,
  completed: Record<string, unknown>
): void {
  const observed = workbenchCameraProof(completed, "Workbench matrix completed capture");
  if (requested.kind === "current") return;
  assertCameraMatrixClose(workbenchCameraMatrix(requested), observed.actualCamera.matrix);
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(observed.actualCamera.position[axis] - requested.position[axis]) > 0.01) {
      throw new Error(`Workbench matrix rendered position differs from the requested view at axis ${axis}`);
    }
  }
  if (Math.abs(observed.actualCamera.verticalFov - requested.fov) > 0.02) {
    throw new Error("Workbench matrix rendered FOV differs from the requested view");
  }
}

function assertRestoredWorkbenchCameraProof(
  baseline: Pick<WorkbenchObserverJobStatus, "actualCamera" | "ownerCameraId" | "worldIdentity">,
  restored: Record<string, unknown>,
  label: string,
  compareWorldIdentity = true
): void {
  const observed = workbenchCameraProof(restored, label);
  assertCameraMatrixClose(baseline.actualCamera.matrix, observed.actualCamera.matrix);
  if (Math.abs(baseline.actualCamera.verticalFov - observed.actualCamera.verticalFov) > 0.002 ||
      baseline.ownerCameraId !== observed.ownerCameraId ||
      (compareWorldIdentity && baseline.worldIdentity !== observed.worldIdentity)) {
    throw new Error(
      `${label} did not match baseline FOV, camera owner` +
      (compareWorldIdentity ? ", and editor world identity" : "")
    );
  }
}

function assertReplacementWorkbenchCameraProof(
  baseline: Pick<WorkbenchObserverJobStatus, "worldIdentity">,
  restored: Record<string, unknown>,
  expectedWorldIdentity: string,
  label: string
): void {
  const observed = workbenchCameraProof(restored, label);
  if (expectedWorldIdentity === baseline.worldIdentity ||
      observed.worldIdentity !== expectedWorldIdentity) {
    throw new Error(`${label} did not match the replacement editor world identity`);
  }
  // A newly opened editor world owns a different legitimate current camera.
  // workbenchCameraProof above still requires complete finite camera/FOV/owner
  // evidence; comparing those values to the previous world's camera would turn
  // an intentional world switch into a false restoration failure.
}

function assertDeclaredWorkbenchTerminal(
  matrixCase: WorkbenchFaultMatrixCase,
  terminal: FaultMatrixTerminal
): void {
  if (terminal.state !== matrixCase.expectedTerminal.state ||
      terminal.errorCode !== matrixCase.expectedTerminal.errorCode) {
    throw new Error(
      `Workbench matrix case ${matrixCase.id} reached state=${terminal.state} ` +
      `errorCode=${String(terminal.errorCode)}, expected state=${matrixCase.expectedTerminal.state} ` +
      `errorCode=${String(matrixCase.expectedTerminal.errorCode)}`
    );
  }
}

async function pollWorkbenchMatrixTerminal(
  application: Pick<ObserverApplication, "jobStatus">,
  jobId: string,
  deadline: number
): Promise<Record<string, unknown>> {
  const result = await pollUntil<Record<string, unknown>>({
    clock: systemClock,
    sleeper: systemSleeper,
    deadline: deadlineAt(deadline),
    intervalMs: 250,
    probe: async () => {
      const status = await application.jobStatus(undefined, jobId);
      if (typeof status.state !== "string") {
        throw new Error("Workbench matrix status omitted its public state");
      }
      return TERMINAL_STATES.has(status.state) ? status : undefined;
    },
  });
  if (result.kind === "expired") {
    throw new Error("Workbench matrix job did not reach a terminal state before its case deadline");
  }
  return result.value;
}

function requireAction<T>(value: T | undefined, action: string): T {
  if (!value) throw new Error(`Workbench matrix action ${action} has no live implementation`);
  return value;
}

function matrixCaptureInput(input: RunWorkbenchMatrixCaseInput, options: {
  readonly label: string;
  readonly view: ObserverCaptureView;
  readonly managed: boolean;
  readonly expectedWorldRevision?: string;
}): Parameters<WorkbenchMatrixCaseApplication["capture"]>[0] {
  return {
    ...(options.managed ? {
      runId: input.runId,
      captureLabel: options.label,
      purpose: "Workbench observer failure-matrix capture",
    } : {}),
    instanceId: input.instanceId,
    expectedWorldRevision: options.expectedWorldRevision ?? input.expectedWorldRevision,
    idempotencyKey: `${input.runId}-${options.label}`,
    view: options.view,
    settleFrames: 3,
    performancePolicy: "evidence",
    asynchronous: true,
    timeoutMs: remainingWorkbenchMatrixCaptureTimeout(input.caseDeadline),
  };
}

class WorkbenchControlPump {
  private running = false;
  private loop: Promise<void> = Promise.resolve();
  private controller: AbortController | null = null;

  constructor(
    private readonly poll: () => Promise<unknown>,
    private readonly intervalMs = 150
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.loop = (async () => {
      while (this.running) {
        try { await this.poll(); } catch { /* the case deadline owns liveness */ }
        if (!this.running) break;
        try {
          await delay(this.intervalMs, undefined, { signal });
        } catch (error) {
          if (!signal.aborted) throw error;
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.controller?.abort();
    await this.loop;
    this.controller = null;
  }
}

async function releaseWorkbenchBarrier(
  adapter: WorkbenchMatrixCaseAdapter,
  scheduler: WorkbenchMatrixCaseScheduler,
  kind: "release" | "cancel",
  options: {
    readonly afterPublished?: () => void;
    readonly captureDrivesAcknowledgement?: boolean;
  } = {}
): Promise<void> {
  if (options.captureDrivesAcknowledgement) {
    await scheduler.releaseBarrier(kind, options.afterPublished);
    return;
  }
  const pump = new WorkbenchControlPump(() => adapter.ping());
  pump.start();
  try {
    await scheduler.releaseBarrier(kind, options.afterPublished);
  } finally {
    await pump.stop();
  }
}

async function stopWorkbenchControlPump(pump: WorkbenchControlPump | null): Promise<void> {
  if (pump) await pump.stop();
}

/** Named state machine for one declared Workbench fault-matrix row. */
class WorkbenchMatrixCaseExecution {
  private readonly diagnostics: string[] = [];
  private primaryOutcome: Promise<SettledCapture> | null = null;
  private primarySubmitted: Record<string, unknown> | null = null;
  private primaryJobId: string | null = null;
  private phasePump: WorkbenchControlPump | null = null;
  private beforeLeasePump: WorkbenchControlPump | null = null;
  private armPolling = true;
  private publicTerminal: FaultMatrixTerminal | null = null;
  private terminalStatus: Record<string, unknown> | null = null;
  private cancellationStatus: Record<string, unknown> | null = null;
  private exactOwnerVacant = false;
  private currentWorldId: string;
  private currentWorldRevision: string;
  private decoy: MatrixCaseEntry<true>["decoy"] = {
    category: "not_applicable",
    identityUnchanged: null,
  };
  private artifact: MatrixCaseEntry["artifact"] = "not_created";
  private artifactEvidence: MatrixCaseEntry<true>["artifactEvidence"] = {
    validation: "not_created",
    pngSha256: null,
    metadataSha256: null,
    byteCount: null,
    manifestPublished: false,
  };

  constructor(private readonly input: RunWorkbenchMatrixCaseInput) {
    this.currentWorldId = input.expectedWorldId;
    this.currentWorldRevision = input.expectedWorldRevision;
  }

  async run(): Promise<MatrixCaseEntry> {
    this.validateDeclaration();
    await this.armAndObserveFixtureBarrier();
    await this.requirePrimarySubmissionAfterBarrier();
    await this.prepareDeclaredAction();
    await this.releaseDeclaredBarrier();
    await this.confirmDeclaredActionAfterBarrier();
    this.startBeforeLeaseCaptureIfRequired();
    await this.observeDeclaredActionOutcome();

    const terminal = this.requirePublicTerminal();
    assertDeclaredWorkbenchTerminal(this.input.matrixCase, terminal);
    await this.verifyShutdownDecoy();
    await this.retainValidatedArtifact();
    this.verifyCameraDisposition();
    await this.releaseCancelledPrimary();
    await this.proveFreshAcquisition();
    await this.finishFixtureCase();

    if (terminal.state !== "completed") await this.input.actions.discardRun?.();
    return this.buildEntry(terminal);
  }

  private validateDeclaration(): void {
    const { matrixCase, captureView } = this.input;
    if (matrixCase.backend !== "workbench" || matrixCase.view === null ||
        captureView.kind !== matrixCase.view) {
      throw new Error("Workbench matrix dispatcher received a mismatched declaration or capture view");
    }
  }

  private recordPublicTerminal(terminal: FaultMatrixTerminal): FaultMatrixTerminal {
    if (this.publicTerminal &&
        (this.publicTerminal.state !== terminal.state ||
          this.publicTerminal.errorCode !== terminal.errorCode)) {
      throw new Error("Workbench matrix case exposed conflicting public terminal results");
    }
    if (!this.publicTerminal) {
      this.publicTerminal = terminal;
      this.input.onPublicTerminal?.(terminal);
    }
    return this.publicTerminal;
  }

  private requirePublicTerminal(): FaultMatrixTerminal {
    if (!this.publicTerminal) throw new Error("Workbench matrix action produced no public terminal");
    return this.publicTerminal;
  }

  private startPrimaryCapture = (): void => {
    if (this.primaryOutcome) {
      throw new Error("Workbench matrix primary capture started more than once");
    }
    this.primaryOutcome = settledCapture(this.input.application.capture(matrixCaptureInput(this.input, {
      label: "matrix-primary",
      view: this.input.captureView,
      managed: true,
    })));
    void this.primaryOutcome.then((outcome) => {
      if (!outcome.result) return;
      if (!outcome.result.asynchronous) {
        throw new Error("Workbench matrix primary capture unexpectedly completed synchronously");
      }
      this.primarySubmitted = outcome.result.job;
      this.primaryJobId = requiredString(
        outcome.result.job.jobId,
        "Workbench matrix primary job ID"
      );
      if (this.input.matrixCase.injection.phase !== "before_lease" && this.armPolling) {
        this.phasePump = new WorkbenchControlPump(() => this.input.adapter.status(this.primaryJobId!));
        this.phasePump.start();
      }
    }).catch(() => undefined);
  };

  private async armAndObserveFixtureBarrier(): Promise<void> {
    let scheduled: Awaited<ReturnType<WorkbenchMatrixCaseScheduler["arm"]>>;
    try {
      scheduled = await this.input.scheduler.arm(this.input.matrixCase.id, () => {
        if (this.input.matrixCase.injection.phase === "before_lease") {
          this.beforeLeasePump = new WorkbenchControlPump(() => this.input.adapter.ping());
          this.beforeLeasePump.start();
        } else {
          this.startPrimaryCapture();
        }
      });
      this.diagnostics.push(
        `fixture barrier arrived for ${scheduled.case.injection.phase}; ` +
        `disposition=${scheduled.arrived.disposition}`
      );
    } finally {
      this.armPolling = false;
      await stopWorkbenchControlPump(this.beforeLeasePump);
      await stopWorkbenchControlPump(this.phasePump);
    }
  }

  private async requirePrimarySubmissionAfterBarrier(): Promise<void> {
    if (this.input.matrixCase.injection.phase === "before_lease") return;
    const outcome = await this.requirePrimaryOutcome();
    if (outcome.error) throw outcome.error;
    if (!outcome.result?.asynchronous || !this.primaryJobId) {
      throw new Error("Workbench matrix capture did not expose its asynchronous job before phase arrival");
    }
  }

  private async requirePrimaryOutcome(): Promise<SettledCapture> {
    if (!this.primaryOutcome) throw new Error("Workbench matrix primary capture was not started");
    return this.primaryOutcome;
  }

  private async prepareDeclaredAction(): Promise<void> {
    const { application, actions, matrixCase } = this.input;
    const action = matrixCase.injection.action;
    if (action === "cancel_capture") {
      this.cancellationStatus = await application.cancelJob(undefined, this.primaryJobId!);
      this.recordPublicTerminal(canonicalTerminalFromStatus(this.cancellationStatus));
      return;
    }
    if (action === "disable_fixture_handler") {
      requireAction(actions.armHandlerLoss, action)({
        phase: matrixCase.injection.phase,
        jobId: this.primaryJobId,
      });
      return;
    }
    if (action === "submit_competing_capture") {
      const competing = await settledCapture(application.capture(matrixCaptureInput(this.input, {
        label: "matrix-competing",
        view: this.input.captureView,
        managed: false,
      })));
      if (competing.result) {
        throw new Error("Workbench matrix competing capture unexpectedly acquired a second camera lease");
      }
      this.recordPublicTerminal(canonicalTerminalFromError(competing.error));
      return;
    }
    if (action === "replace_fixture_world") {
      await requireAction(actions.replaceFixtureWorld, action)();
    }
  }

  private async confirmDeclaredActionAfterBarrier(): Promise<void> {
    const { actions, matrixCase } = this.input;
    if (matrixCase.injection.action !== "replace_fixture_world") return;
    const replacement = await requireAction(
      actions.confirmFixtureWorldReplacement,
      "replace_fixture_world:confirm"
    )();
    this.currentWorldId = replacement.currentWorldId;
    this.currentWorldRevision = workbenchWorldRevision(replacement.currentWorldId);
  }

  private async releaseDeclaredBarrier(): Promise<void> {
    const { adapter, scheduler, matrixCase } = this.input;
    const action = matrixCase.injection.action;
    const captureDrivesAction = matrixCase.injection.phase === "before_lease" &&
      (action === "disable_fixture_handler" || action === "stop_owned_workbench");
    await releaseWorkbenchBarrier(
      adapter,
      scheduler,
      action === "cancel_capture" ? "cancel" : "release",
      captureDrivesAction
        ? { afterPublished: this.startPrimaryCapture, captureDrivesAcknowledgement: true }
        : {}
    );
    this.diagnostics.push(`fixture acknowledged host action ${action}`);
  }

  private startBeforeLeaseCaptureIfRequired(): void {
    const { phase, action } = this.input.matrixCase.injection;
    if (phase === "before_lease" &&
        action !== "disable_fixture_handler" && action !== "stop_owned_workbench") {
      this.startPrimaryCapture();
    }
  }

  private async observeDeclaredActionOutcome(): Promise<void> {
    const { application, adapter, actions, matrixCase } = this.input;
    const action = matrixCase.injection.action;
    if (action === "cancel_capture") {
      this.terminalStatus = this.cancellationStatus;
      return;
    }
    if (action === "submit_competing_capture") {
      this.terminalStatus = await pollWorkbenchMatrixTerminal(
        application,
        this.primaryJobId!,
        this.input.caseDeadline
      );
      const primaryTerminal = canonicalTerminalFromStatus(this.terminalStatus);
      if (primaryTerminal.state !== "completed" ||
          this.terminalStatus.cameraLeaseHeld === true ||
          this.terminalStatus.restorationConfirmed !== true) {
        throw new Error("Workbench matrix contention changed or stranded the original camera lease");
      }
      await application.readJob(undefined, this.primaryJobId!);
      return;
    }
    if (action === "disable_fixture_handler") {
      await this.observeHandlerLoss();
      return;
    }
    if (action === "replace_fixture_world") {
      await this.observeWorldReplacement();
      return;
    }
    if (action === "write_truncated_artifact" || action === "write_crc_artifact" ||
        action === "write_mismatched_artifact") {
      let observedTerminal: FaultMatrixTerminal | null = null;
      const observed = await pollUntil<true>({
        clock: systemClock,
        sleeper: systemSleeper,
        deadline: deadlineAt(this.input.caseDeadline),
        intervalMs: 250,
        probe: async () => {
          let status: Record<string, unknown>;
          try {
            status = await application.jobStatus(undefined, this.primaryJobId!);
          } catch (error) {
            observedTerminal = canonicalTerminalFromError(error);
            return true;
          }
          if (typeof status.state !== "string") {
            throw new Error("Workbench artifact mutation status omitted its public state");
          }
          if (!TERMINAL_STATES.has(status.state)) return undefined;
          observedTerminal = canonicalTerminalFromStatus(status);
          return true;
        },
      });
      if (observed.kind === "expired" || !observedTerminal) {
        throw new Error(
          "Workbench artifact mutation did not reach a public terminal before its case deadline"
        );
      }
      this.recordPublicTerminal(observedTerminal);
      const mutation = requireAction(actions.artifactMutationResult, action)();
      if (!mutation) throw new Error("Workbench artifact case did not invoke its one-shot mutation hook");
      this.terminalStatus = { ...await adapter.status(this.primaryJobId!) };
      return;
    }
    if (action === "stop_owned_workbench" && matrixCase.cameraDisposition === "restored") {
      await this.observeTerminalOwnerShutdown();
      return;
    }
    if (action === "stop_owned_workbench" &&
        matrixCase.cameraDisposition === "exact_process_exit") {
      await this.observeExactOwnerShutdown();
      return;
    }
    this.terminalStatus = await pollWorkbenchMatrixTerminal(
      application,
      this.primaryJobId!,
      this.input.caseDeadline
    );
    this.recordPublicTerminal(canonicalTerminalFromStatus(this.terminalStatus));
  }

  private async observeHandlerLoss(): Promise<void> {
    const { application, adapter, actions, matrixCase } = this.input;
    if (matrixCase.injection.phase === "before_lease") {
      const outcome = await this.requirePrimaryOutcome();
      if (outcome.result) {
        throw new Error("Workbench before-lease handler-loss capture unexpectedly succeeded");
      }
      this.recordPublicTerminal(canonicalTerminalFromError(outcome.error));
    } else {
      try {
        this.terminalStatus = await application.jobStatus(undefined, this.primaryJobId!);
        throw new Error("Workbench handler loss did not reach the public transport boundary");
      } catch (error) {
        this.recordPublicTerminal(canonicalTerminalFromError(error));
      }
      if (matrixCase.cameraDisposition === "restored") {
        this.terminalStatus = { ...await adapter.status(this.primaryJobId!) };
      }
    }
    const loss = requireAction(actions.handlerLossResult, "disable_fixture_handler:result")();
    const expectedLoss = matrixCase.injection.phase === "before_lease" || matrixCase.view === "pose"
      ? "handler_response_lost"
      : "handler_request_lost";
    if (!loss.faultInjected || loss.category !== expectedLoss) {
      throw new Error(
        "Workbench handler-loss seam was not consumed at the declared boundary: " +
        `expected=${expectedLoss}, observed=${loss.category}`
      );
    }
    this.diagnostics.push(`fixture handler-loss seam consumed at ${loss.category}`);
  }

  private async observeWorldReplacement(): Promise<void> {
    if (this.input.matrixCase.injection.phase === "before_lease") {
      const outcome = await this.requirePrimaryOutcome();
      if (outcome.result) throw new Error("Workbench old-world capture unexpectedly survived replacement");
      this.recordPublicTerminal(canonicalTerminalFromError(outcome.error));
      return;
    }
    this.terminalStatus = await pollWorkbenchMatrixTerminal(
      this.input.application,
      this.primaryJobId!,
      this.input.caseDeadline
    );
    this.recordPublicTerminal(canonicalTerminalFromStatus(this.terminalStatus));
  }

  private async observeTerminalOwnerShutdown(): Promise<void> {
    if (!this.primaryJobId) {
      throw new Error("Workbench terminal owner-shutdown case has no retained primary job");
    }
    requireAction(
      this.input.actions.armTerminalReleaseOwnerShutdown,
      "stop_owned_workbench:terminal-release"
    )(this.primaryJobId);
    this.terminalStatus = await pollWorkbenchMatrixTerminal(
      this.input.application,
      this.primaryJobId,
      this.input.caseDeadline
    );
    this.recordPublicTerminal(canonicalTerminalFromStatus(this.terminalStatus));
    const shutdown = await requireAction(
      this.input.actions.shutdownOwnedWorkbench,
      "stop_owned_workbench"
    )();
    this.exactOwnerVacant = shutdown.exactOwnerVacant;
  }

  private async observeExactOwnerShutdown(): Promise<void> {
    if (this.input.matrixCase.injection.phase === "before_lease") {
      // The capture's discovery Ping can acknowledge the fixture barrier before
      // Submit acquires its activity lease. Let the armed before-submit hook own
      // the shutdown boundary; otherwise the dispatcher can stop Workbench in
      // that gap and collapse the declared WORKBENCH_EXITED result into a
      // generic transport failure.
      const outcome = await this.requirePrimaryOutcome();
      if (outcome.result) throw new Error("Workbench owned-shutdown capture unexpectedly succeeded");
      this.recordPublicTerminal(canonicalTerminalFromError(outcome.error));
      const shutdown = await requireAction(
        this.input.actions.shutdownOwnedWorkbench,
        "stop_owned_workbench"
      )();
      this.exactOwnerVacant = shutdown.exactOwnerVacant;
      return;
    }
    if (this.primaryJobId) {
      requireAction(
        this.input.actions.requireExactOwnerExit,
        "stop_owned_workbench:require-exact-owner-exit"
      )(this.primaryJobId);
    }
    const shutdown = await requireAction(
      this.input.actions.shutdownOwnedWorkbench,
      "stop_owned_workbench"
    )();
    this.exactOwnerVacant = shutdown.exactOwnerVacant;
    if (this.primaryJobId) {
      requireAction(
        this.input.actions.confirmExactOwnerExit,
        "stop_owned_workbench:confirm-exact-owner-exit"
      )(this.primaryJobId, this.exactOwnerVacant);
      this.terminalStatus = await this.input.application.jobStatus(undefined, this.primaryJobId);
      this.recordPublicTerminal(canonicalTerminalFromStatus(this.terminalStatus));
      await this.input.adapter.release(this.primaryJobId);
      return;
    }
    const outcome = await this.requirePrimaryOutcome();
    if (outcome.result) throw new Error("Workbench owned-shutdown capture unexpectedly succeeded");
    this.recordPublicTerminal(canonicalTerminalFromError(outcome.error));
    const repeatedShutdown = await requireAction(
      this.input.actions.shutdownOwnedWorkbench,
      "stop_owned_workbench"
    )();
    this.exactOwnerVacant = repeatedShutdown.exactOwnerVacant;
  }

  private async verifyShutdownDecoy(): Promise<void> {
    if (this.input.matrixCase.injection.action !== "stop_owned_workbench") return;
    const comparison = await requireAction(
      this.input.actions.verifyShutdownDecoy,
      "stop_owned_workbench:decoy"
    )();
    if (comparison) {
      this.decoy = {
        category: comparison.identityUnchanged ? "verified" : "unproven",
        identityUnchanged: comparison.identityUnchanged ? true : null,
      };
    }
  }

  private async retainValidatedArtifact(): Promise<void> {
    const terminal = this.requirePublicTerminal();
    const action = this.input.matrixCase.injection.action;
    if (terminal.state === "completed") {
      if (!this.primaryJobId || !this.primarySubmitted || !this.terminalStatus) {
        throw new Error("Workbench completed matrix case lacks its retained primary capture");
      }
      const retained = await this.input.application.readJob(undefined, this.primaryJobId);
      assertRequestedWorkbenchMatrixView(this.input.captureView, this.terminalStatus);
      if (this.input.captureView.kind === "current") {
        assertRestoredWorkbenchCameraProof(
          this.input.baselineCurrent,
          this.terminalStatus,
          "Workbench matrix completed current capture"
        );
      }
      const pngSha256 = createHash("sha256").update(retained.image).digest("hex");
      const metadataSha256 = operationalBaselineProcedureSha256(retained.metadata);
      if (action === "release_twice") {
        const release = retained.job.handlerRelease as Record<string, unknown> | undefined;
        const replay = release?.idempotentReplay as Record<string, unknown> | undefined;
        if (replay?.attempted !== true || replay.identicalRequest !== true ||
            replay.equivalentAcknowledgement !== true) {
          throw new Error("Workbench terminal release did not prove an identical idempotent replay");
        }
      }
      const finalized = await requireAction(
        this.input.actions.finalizeValidatedCapture,
        `${action}:finalize`
      )({
        submitted: this.primarySubmitted,
        completed: this.terminalStatus,
        image: retained.image,
        metadata: retained.metadata,
      });
      if (!finalized.manifestPublished) {
        throw new Error("Workbench completed matrix capture did not publish its validated manifest last");
      }
      this.artifact = "validated";
      this.artifactEvidence = {
        validation: "validated",
        pngSha256,
        metadataSha256,
        byteCount: retained.image.length,
        manifestPublished: true,
      };
      return;
    }
    if (action === "write_truncated_artifact" || action === "write_crc_artifact" ||
        action === "write_mismatched_artifact") {
      this.artifact = "rejected";
      this.artifactEvidence = {
        validation: "rejected",
        pngSha256: null,
        metadataSha256: null,
        byteCount: null,
        manifestPublished: false,
      };
    }
  }

  private verifyCameraDisposition(): void {
    if (this.input.matrixCase.cameraDisposition !== "restored") return;
    const proof = this.terminalStatus ?? this.cancellationStatus;
    if (!proof || proof.cameraLeaseHeld === true || proof.restorationConfirmed !== true) {
      throw new Error("Workbench matrix case did not prove exact editor camera restoration");
    }
  }

  private async releaseCancelledPrimary(): Promise<void> {
    if (this.input.matrixCase.injection.action === "cancel_capture" && this.primaryJobId) {
      await this.input.adapter.release(this.primaryJobId);
    }
  }

  private async proveFreshAcquisition(): Promise<void> {
    const action = this.input.matrixCase.injection.action;
    const expectsValidatedArtifact = this.requirePublicTerminal().state === "completed";
    if (!((expectsValidatedArtifact && action !== "stop_owned_workbench") ||
        action === "cancel_capture" || action === "submit_competing_capture")) return;

    const followUp = await this.input.application.capture(matrixCaptureInput(this.input, {
      label: "matrix-followup-current",
      view: { kind: "current" },
      managed: false,
      expectedWorldRevision: this.currentWorldRevision,
    }));
    if (!followUp.asynchronous) {
      throw new Error("Workbench matrix follow-up capture unexpectedly completed synchronously");
    }
    const followUpJobId = requiredString(
      followUp.job.jobId,
      "Workbench matrix follow-up job ID"
    );
    const followUpTerminal = await pollWorkbenchMatrixTerminal(
      this.input.application,
      followUpJobId,
      this.input.caseDeadline
    );
    if (followUpTerminal.state !== "completed" ||
        followUpTerminal.cameraLeaseHeld === true ||
        followUpTerminal.restorationConfirmed !== true) {
      throw new Error("Workbench matrix follow-up did not prove a fresh restored camera acquisition");
    }
    if (action === "replace_fixture_world") {
      assertReplacementWorkbenchCameraProof(
        this.input.baselineCurrent,
        followUpTerminal,
        this.currentWorldId,
        "Workbench matrix post-restoration current capture"
      );
    } else {
      assertRestoredWorkbenchCameraProof(
        this.input.baselineCurrent,
        followUpTerminal,
        "Workbench matrix post-restoration current capture"
      );
    }
    await this.input.application.readJob(undefined, followUpJobId);
    await this.input.adapter.release(followUpJobId);
    this.diagnostics.push(action === "replace_fixture_world"
      ? "fresh current-view acquisition proved complete camera evidence in the replacement editor world"
      : "fresh current-view acquisition matched the baseline editor camera after restoration");
  }

  private async finishFixtureCase(): Promise<void> {
    const terminal = this.requirePublicTerminal();
    const { matrixCase } = this.input;
    const action = matrixCase.injection.action;
    if (action === "stop_owned_workbench") {
      if (!this.exactOwnerVacant) {
        throw new Error("Workbench matrix exact-exit case did not prove owner vacancy");
      }
      await this.input.scheduler.finishAfterExactOwnerExit(terminal, this.exactOwnerVacant);
      return;
    }
    if (matrixCase.cameraDisposition === "exact_process_exit") {
      if (!this.primaryJobId) throw new Error("Workbench exact-exit case has no retained adapter job");
      requireAction(
        this.input.actions.requireExactOwnerExit,
        `${action}:require-exact-owner-exit`
      )(this.primaryJobId);
      const shutdown = await requireAction(
        this.input.actions.shutdownOwnedWorkbench,
        action
      )();
      this.exactOwnerVacant = shutdown.exactOwnerVacant;
      requireAction(
        this.input.actions.confirmExactOwnerExit,
        `${action}:confirm-exact-owner-exit`
      )(this.primaryJobId, this.exactOwnerVacant);
      await this.input.adapter.release(this.primaryJobId);
      if (!this.exactOwnerVacant) {
        throw new Error("Workbench matrix exact-exit case did not prove owner vacancy");
      }
      await this.input.scheduler.finishAfterExactOwnerExit(terminal, this.exactOwnerVacant);
      return;
    }
    const terminalPump = new WorkbenchControlPump(() => this.input.adapter.ping());
    terminalPump.start();
    try {
      await this.input.scheduler.finishCase(terminal);
    } finally {
      await terminalPump.stop();
    }
  }

  private buildEntry(terminal: FaultMatrixTerminal): MatrixCaseEntry {
    const finishedAt = Date.now();
    if (finishedAt > this.input.caseDeadline) {
      throw new Error("Workbench matrix case exceeded its absolute deadline");
    }
    const elapsedMs = Math.max(0, finishedAt - this.input.caseStartedAt);
    const { matrixCase } = this.input;
    const action = matrixCase.injection.action;
    return {
      caseId: matrixCase.id,
      schedule: {
        backend: "workbench",
        view: matrixCase.view,
        phase: matrixCase.injection.phase,
        action,
      },
      result: "passed",
      publicTerminal: terminal,
      deadline: { outcome: "completed", elapsedMs, budgetMs: this.input.caseBudgetMs },
      worldRevision: action === "replace_fixture_world" ? "changed" : "unchanged",
      camera: matrixCase.cameraDisposition,
      artifact: this.artifact,
      cleanup: {
        lifecycleVacant: this.exactOwnerVacant,
        endpointVacant: false,
        childVacant: false,
        exactOwnerVacant: this.exactOwnerVacant,
      },
      retainedDiagnostics: this.diagnostics.map((value) => matrixRetainedDiagnostic(value)),
      control: { arrival: "arrived", action: "executed" },
      artifactEvidence: this.artifactEvidence,
      ownerShutdown: this.exactOwnerVacant ? "exact_owner_vacant" : "not_applicable",
      decoy: this.decoy,
      limitations: matrixCase.injection.phase === "before_lease"
        ? [
            "Before-lease evidence authenticates lifecycle, case, and phase through Ping and proves no retained job; the declared view is host-bound, while a later Submit tuple is checked only if it occurs.",
          ]
        : [],
    };
  }
}

/** Execute one declared Workbench row after its immutable arm is published. */
export async function runWorkbenchMatrixCase(
  input: RunWorkbenchMatrixCaseInput
): Promise<MatrixCaseEntry> {
  return new WorkbenchMatrixCaseExecution(input).run();
}

/** The original pilot export now delegates to the complete table dispatcher. */
export async function runWorkbenchCancelBarrierCase(
  input: RunWorkbenchCancelBarrierCaseInput
): Promise<MatrixCaseEntry> {
  if (input.matrixCase.backend !== "workbench") {
    throw new Error("The Workbench cancellation helper requires a Workbench declaration");
  }
  return runWorkbenchMatrixCase({
    ...input,
    matrixCase: input.matrixCase,
    captureView: input.poseView,
    actions: input.actions ?? {},
  });
}
