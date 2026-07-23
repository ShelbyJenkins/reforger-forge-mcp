import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  OBSERVER_FAULT_MATRIX,
  type FaultMatrixTerminal,
  type WorkbenchFaultMatrixCase,
} from "../observer/protocol/fault-matrix.js";
import {
  deadlineAt,
  pollUntil,
  systemClock,
  systemSleeper,
} from "../src/foundation/time.js";
import type {
  ObserverApplication,
  ObserverCaptureView,
} from "../src/observer/application.js";
import { WorkbenchNetApiClient } from "../src/workbench/net-api-client.js";
import type {
  WorkbenchCameraMatrix,
  WorkbenchObserverJobStatus,
} from "../src/workbench/observer-adapter.js";
import type { WindowsLifecycleBackend } from "../src/workbench/process-guard.js";
import {
  analyzePngMaterial,
  captureStableFailureMatrixSource,
  failureMatrixSourceRevision,
  matrixRetainedDiagnostic,
  operationalBaselineDirectoryIdentity,
  operationalBaselineEnvironment,
  operationalBaselineProcedureSha256,
  operationalBaselineSource,
  waitForOperationalBaselineProcessVacancy,
  type MatrixCaseEntry,
  type OperationalBaselineEnvironment,
  type OperationalBaselineLaunchArguments,
  type OperationalBaselineMeasurement,
  type OperationalBaselineProcessSample,
  type PngMaterialEvidence,
} from "./observer-live-acceptance-support.js";
import {
  createFaultMatrixRunScaffolding,
  removeOwnedFaultControlRoot,
  type FaultMatrixRunScaffolding,
} from "./observer-fault-matrix-support.js";
import {
  FixtureOnlyWorkbenchNetApiFaultPort,
  compareWorkbenchDecoyIdentity,
  createOneShotWorkbenchPngArtifactHook,
  type WorkbenchDecoyIdentityResult,
  type WorkbenchPngMutation,
  type WorkbenchPngMutationResult,
} from "./observer-workbench-failure-support.js";
import {
  WorkbenchObserverAcceptanceAdapter,
  type WorkbenchObserverBeforeSubmitDeliveryContext,
} from "./workbench-observer-acceptance-adapter.js";
import {
  remainingWorkbenchMatrixCaptureTimeout,
  remainingWorkbenchMatrixStepTimeout,
  runWorkbenchMatrixCase,
  type WorkbenchMatrixCaseActions,
  type WorkbenchMatrixShutdownEvidence,
  type WorkbenchMatrixValidatedCapture,
} from "./workbench-observer-matrix-case.js";
import {
  WORKBENCH_MATRIX_FIXTURE_GUID,
  WORKBENCH_MATRIX_FIXTURE_TEMPLATE_DIR,
  WORKBENCH_OBSERVER_ACCEPTANCE_REPOSITORY_ROOT,
  WorkbenchObserverAcceptanceRuntime,
  workbenchEnvironmentExecutables,
} from "./workbench-observer-acceptance-runtime.js";

export const WORKBENCH_MATRIX_FIXTURE_SOURCES = [
  "tests/fixtures/workbench-observer-failure-matrix-addon/addon.gproj",
  "tests/fixtures/workbench-observer-failure-matrix-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_ObserverMatrixControl.c",
  "tests/fixtures/workbench-observer-failure-matrix-decoy.mjs",
] as const;

export interface WorkbenchLiveRetainedCapture {
  readonly label: string;
  readonly submitted: Record<string, unknown>;
  readonly completed: WorkbenchObserverJobStatus;
  readonly image: Buffer;
  readonly png: PngMaterialEvidence;
}

export interface WorkbenchLiveMatrixCaseServices {
  readonly assertNoArmaOrWorkbench: (deadlineAtMs?: number) => void;
  readonly waitForCaptureCapability: (
    application: ObserverApplication,
    deadline: number
  ) => Promise<Record<string, unknown>>;
  readonly captureAndRetainUnmeasured: (
    application: ObserverApplication,
    view: ObserverCaptureView,
    label: string,
    runId: string,
    instanceId: string,
    expectedWorldId: string,
    deadline: number
  ) => Promise<WorkbenchLiveRetainedCapture>;
  readonly validateFinalizedBundle: (
    finalized: Record<string, unknown>,
    evidenceRoot: string,
    runId: string,
    captures: WorkbenchLiveRetainedCapture[]
  ) => unknown;
  readonly quaternionFromWorkbenchMatrix: (
    matrix: WorkbenchCameraMatrix
  ) => [number, number, number, number];
  readonly readSource: () => ReturnType<typeof operationalBaselineSource>;
}

export interface RunLiveWorkbenchMatrixCaseInput {
  readonly matrixCase: WorkbenchFaultMatrixCase;
  readonly caseDirectory: string;
  readonly timeoutMs: number;
  readonly caseStartedAt: number;
}

/** One fresh native Workbench lifecycle and its aggregate-safe result. */
export interface WorkbenchLiveMatrixCaseOutcome {
  readonly entry: MatrixCaseEntry;
  readonly failure: unknown | null;
  readonly knownSecretValues: readonly string[];
  readonly measurements: readonly OperationalBaselineMeasurement[];
  readonly processCounts: readonly OperationalBaselineProcessSample[];
  readonly launchArguments: OperationalBaselineLaunchArguments;
  readonly environment: OperationalBaselineEnvironment;
  readonly retainForDecoyRecovery: boolean;
}

type WorkbenchDecoyInspection = Awaited<ReturnType<WindowsLifecycleBackend["inspectProcess"]>>;

export interface WorkbenchLiveDecoy {
  readonly child: ChildProcess;
  readonly ownerArgument: string;
  readonly exitSentinel: string;
  readonly before: NonNullable<WorkbenchDecoyInspection>;
  comparison: WorkbenchDecoyIdentityResult | null;
  exited: boolean;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is missing`);
  return value;
}

function workbenchMatrixMutation(
  action: WorkbenchFaultMatrixCase["injection"]["action"]
): WorkbenchPngMutation | null {
  if (action === "write_truncated_artifact") return "truncated";
  if (action === "write_crc_artifact") return "crc_corruption";
  if (action === "write_mismatched_artifact") return "byte_length_mismatch";
  return null;
}

function workbenchMatrixCaptureView(
  view: Exclude<WorkbenchFaultMatrixCase["view"], null>,
  baselineCamera: WorkbenchObserverJobStatus["actualCamera"],
  quaternionFromMatrix: WorkbenchLiveMatrixCaseServices["quaternionFromWorkbenchMatrix"]
): ObserverCaptureView {
  if (view === "current") return { kind: "current" };
  const fov = baselineCamera.verticalFov;
  if (!Number.isFinite(fov) || fov < 1 || fov > 179) {
    throw new Error("Workbench matrix baseline camera FOV is outside the accepted range");
  }
  if (view === "pose") {
    return {
      kind: "pose",
      position: [
        baselineCamera.position[0] + 75,
        baselineCamera.position[1] + 25,
        baselineCamera.position[2] + 50,
      ],
      orientation: quaternionFromMatrix(baselineCamera.matrix),
      fov: fov <= 169 ? fov + 10 : fov - 10,
    };
  }
  const right = baselineCamera.matrix[0];
  const up = baselineCamera.matrix[1];
  const forward = baselineCamera.matrix[2];
  return {
    kind: "lookAt",
    position: [
      baselineCamera.position[0] - right[0] * 90 + up[0] * 35 - forward[0] * 60,
      baselineCamera.position[1] - right[1] * 90 + up[1] * 35 - forward[1] * 60,
      baselineCamera.position[2] - right[2] * 90 + up[2] * 35 - forward[2] * 60,
    ],
    target: [
      baselineCamera.position[0] + forward[0] * 150,
      baselineCamera.position[1] + forward[1] * 150,
      baselineCamera.position[2] + forward[2] * 150,
    ],
    fov: fov <= 164 ? fov + 15 : fov - 15,
  };
}

export function requireWorkbenchReplacementWorldId(
  originalWorldId: string,
  replacementWorldId: unknown
): string {
  const currentWorldId = requiredString(
    replacementWorldId,
    "Replacement Workbench matrix world ID"
  );
  if (currentWorldId === originalWorldId) {
    throw new Error("Opening Matrix B did not change the observed Workbench world identity");
  }
  return currentWorldId;
}

async function inspectWorkbenchDecoy(
  backend: Pick<WindowsLifecycleBackend, "inspectProcess">,
  pid: number,
  ownerArgument: string,
  inspectionDeadlineAtMs: number
): Promise<NonNullable<WorkbenchDecoyInspection>> {
  const result = await pollUntil<NonNullable<WorkbenchDecoyInspection>>({
    clock: systemClock,
    sleeper: systemSleeper,
    deadline: deadlineAt(inspectionDeadlineAtMs),
    intervalMs: 50,
    probe: async () => (await backend.inspectProcess(pid, ownerArgument)) ?? undefined,
  });
  if (result.kind === "expired" || result.value.ownerArgumentMatched !== true) {
    throw new Error("The Workbench shutdown decoy exact identity could not be verified");
  }
  return result.value;
}

export async function launchWorkbenchMatrixDecoy(
  caseDirectory: string,
  backend: Pick<WindowsLifecycleBackend, "inspectProcess">,
  options: {
    readonly onSpawn?: (child: ChildProcess) => void;
    readonly inspectionDeadlineMs?: number;
    readonly deadlineAtMs?: number;
  } = {}
): Promise<WorkbenchLiveDecoy> {
  const ownerArgument = `rfo-decoy-${randomUUID()}`;
  const exitSentinel = resolve(caseDirectory, "decoy-exit.sentinel");
  const decoyPath = resolve(
    WORKBENCH_OBSERVER_ACCEPTANCE_REPOSITORY_ROOT,
    "tests",
    "fixtures",
    "workbench-observer-failure-matrix-decoy.mjs"
  );
  const child = spawn(process.execPath, [
    decoyPath,
    "--owner",
    ownerArgument,
    "--exit-sentinel",
    exitSentinel,
  ], {
    cwd: caseDirectory,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  options.onSpawn?.(child);
  try {
    if (!child.pid) throw new Error("The Workbench shutdown decoy did not expose a spawned PID");
    const inspectionDeadlineAtMs = options.deadlineAtMs ??
      (Date.now() + (options.inspectionDeadlineMs ?? 10_000));
    const before = await inspectWorkbenchDecoy(
      backend,
      child.pid,
      ownerArgument,
      inspectionDeadlineAtMs
    );
    return {
      child,
      ownerArgument,
      exitSentinel,
      before,
      comparison: null,
      exited: false,
    };
  } catch (error) {
    if (!existsSync(exitSentinel)) {
      writeFileSync(exitSentinel, "exit\n", { encoding: "utf8", flag: "wx" });
    }
    const cleanupTimeoutMs = options.deadlineAtMs === undefined
      ? 10_000
      : Math.max(1, Math.min(10_000, Math.floor(options.deadlineAtMs - Date.now())));
    const exited = await waitForChildExit(child, cleanupTimeoutMs);
    if (!exited) {
      throw new AggregateError(
        [error],
        `Workbench decoy qualification failed and sentinel exit could not be proven: ${exitSentinel}`
      );
    }
    throw error;
  }
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return Promise.race([
    new Promise<boolean>((resolveExit) => {
      child.once("exit", () => resolveExit(true));
      child.once("error", () => resolveExit(false));
    }),
    delay(timeoutMs).then(() => false),
  ]);
}

async function waitForWorkbenchDecoyExit(
  decoy: WorkbenchLiveDecoy,
  deadlineAtMs?: number
): Promise<void> {
  const timeoutMs = deadlineAtMs === undefined
    ? 10_000
    : remainingWorkbenchMatrixStepTimeout(deadlineAtMs, 10_000, "decoy sentinel exit");
  const exited = await waitForChildExit(decoy.child, timeoutMs);
  if (!exited) {
    throw new Error("The verified Workbench shutdown decoy did not exit through its sentinel");
  }
  decoy.exited = true;
}

export function workbenchMatrixSourceRevision(): {
  readonly commit: string | null;
  readonly tree: "clean" | "dirty" | "unavailable";
} {
  return failureMatrixSourceRevision(WORKBENCH_OBSERVER_ACCEPTANCE_REPOSITORY_ROOT);
}

export function captureStableWorkbenchMatrixSource(input: {
  readonly readSource: () => ReturnType<typeof operationalBaselineSource>;
  readonly readRevision: () => ReturnType<typeof workbenchMatrixSourceRevision>;
}): {
  readonly source: ReturnType<typeof operationalBaselineSource>;
  readonly sourceRevision: ReturnType<typeof workbenchMatrixSourceRevision>;
  readonly stable: boolean;
} {
  return captureStableFailureMatrixSource(input);
}

export function workbenchFailureDeadlineEvidence(
  startedAt: number,
  failureObservedAt: number,
  budgetMs: number
): MatrixCaseEntry["deadline"] {
  const observedElapsedMs = Math.max(0, failureObservedAt - startedAt);
  const expired = observedElapsedMs >= budgetMs;
  return {
    outcome: expired ? "expired" : "cancelled",
    elapsedMs: Math.min(budgetMs, observedElapsedMs),
    budgetMs,
  };
}

export function failedWorkbenchMatrixEntry(input: {
  readonly matrixCase: WorkbenchFaultMatrixCase;
  readonly publicTerminal: FaultMatrixTerminal | null;
  readonly startedAt: number;
  readonly failureObservedAt?: number;
  readonly budgetMs: number;
  readonly failure: unknown;
  readonly knownSecretValues: readonly string[];
  readonly cleanup: MatrixCaseEntry["cleanup"];
  readonly exactOwnerShutdown: boolean;
  readonly decoy: MatrixCaseEntry<true>["decoy"];
}): MatrixCaseEntry {
  const deadline = workbenchFailureDeadlineEvidence(
    input.startedAt,
    input.failureObservedAt ?? Date.now(),
    input.budgetMs
  );
  return {
    caseId: input.matrixCase.id,
    schedule: {
      backend: "workbench",
      view: input.matrixCase.view,
      phase: input.matrixCase.injection.phase,
      action: input.matrixCase.injection.action,
    },
    result: "failed",
    publicTerminal: input.publicTerminal ?? { state: "failed", errorCode: "INTERNAL_ERROR" },
    deadline,
    worldRevision: "unavailable",
    camera: "unproven",
    artifact: "unproven",
    cleanup: input.cleanup,
    retainedDiagnostics: [matrixRetainedDiagnostic(
      input.failure instanceof Error
        ? `${input.failure.name}: ${input.failure.message}`
        : String(input.failure),
      input.knownSecretValues
    )],
    control: { arrival: "unproven", action: "unproven" },
    artifactEvidence: {
      validation: "unproven",
      pngSha256: null,
      metadataSha256: null,
      byteCount: null,
      manifestPublished: false,
    },
    ownerShutdown: input.exactOwnerShutdown ? "exact_owner_vacant" : "unproven",
    decoy: input.decoy,
    limitations: ["Case execution did not complete every declared evidence check."],
  };
}

/** Named state machine for one fresh native Workbench matrix lifecycle. */
class WorkbenchLiveMatrixCaseExecution {
  private readonly matrixCase: WorkbenchFaultMatrixCase;
  private readonly caseDirectory: string;
  private readonly timeoutMs: number;
  private readonly caseStartedAt: number;
  private readonly caseDeadline: number;
  private readonly mutation: WorkbenchPngMutation | null;
  private readonly runtime: WorkbenchObserverAcceptanceRuntime<WorkbenchObserverAcceptanceAdapter>;
  private readonly faultPort: FixtureOnlyWorkbenchNetApiFaultPort;
  private readonly knownSecretValues: string[];
  private readonly decoyExitSentinel: string;

  private enforceCaseDeadline = true;
  private artifactFaultArmed = false;
  private artifactMutation: WorkbenchPngMutationResult | null = null;
  private faultScaffolding: FaultMatrixRunScaffolding | null = null;
  private runId: string | null = null;
  private runClosed = false;
  private lifecycleGeneration: string | null = null;
  private instanceId: string | null = null;
  private expectedWorldId: string | null = null;
  private captureView: ObserverCaptureView | null = null;
  private baselineCapture: WorkbenchLiveRetainedCapture | null = null;
  private caseEntry: MatrixCaseEntry | null = null;
  private observedPublicTerminal: FaultMatrixTerminal | null = null;
  private failure: unknown = null;
  private failureObservedAt: number | null = null;
  private exactWorkbenchVacant = false;
  private endpointVacant = false;
  private supervisedVacant = false;
  private shutdownPromise: Promise<WorkbenchMatrixShutdownEvidence> | null = null;
  private decoy: WorkbenchLiveDecoy | null = null;
  private unqualifiedDecoyChild: ChildProcess | null = null;
  private decoyEvidence: MatrixCaseEntry<true>["decoy"];

  constructor(
    input: RunLiveWorkbenchMatrixCaseInput,
    private readonly services: WorkbenchLiveMatrixCaseServices
  ) {
    this.matrixCase = input.matrixCase;
    this.caseDirectory = input.caseDirectory;
    this.timeoutMs = input.timeoutMs;
    this.caseStartedAt = input.caseStartedAt;
    this.caseDeadline = input.caseStartedAt + input.timeoutMs;
    this.mutation = workbenchMatrixMutation(input.matrixCase.injection.action);
    this.knownSecretValues = [input.caseDirectory];
    this.decoyExitSentinel = resolve(input.caseDirectory, "decoy-exit.sentinel");
    this.decoyEvidence = {
      category: input.matrixCase.injection.action === "stop_owned_workbench"
        ? "unproven"
        : "not_applicable",
      identityUnchanged: null,
    };

    const mutationHook = this.mutation
      ? createOneShotWorkbenchPngArtifactHook(this.mutation)
      : null;
    this.runtime = new WorkbenchObserverAcceptanceRuntime({
      runDirectory: input.caseDirectory,
      clientIdPrefix: "live-workbench-matrix",
      stageMatrixFixture: true,
      additionalLaunchArguments: ["-plugin=RFO_WorkbenchObserverMatrixPlugin"],
      helperTimeoutMs: () => this.enforceCaseDeadline ? 10_000 : 30_000,
      operationDeadlineAtMs: () => this.enforceCaseDeadline ? this.caseDeadline : undefined,
      lockTimeoutMs: () => this.enforceCaseDeadline
        ? remainingWorkbenchMatrixStepTimeout(this.caseDeadline, 20_000, "lifecycle lock")
        : 20_000,
      launchTimeoutMs: () => Math.min(
        180_000,
        remainingWorkbenchMatrixCaptureTimeout(this.caseDeadline)
      ),
      lifecycleDeadlineAtMs: () => this.enforceCaseDeadline ? this.caseDeadline : undefined,
      requestDeadlineAtMs: () => this.enforceCaseDeadline ? this.caseDeadline : undefined,
      applicationRequestDeadlineAtMs: () =>
        this.enforceCaseDeadline ? this.caseDeadline : undefined,
      createNetApi: ({ host, port, clientId }) => {
        return new FixtureOnlyWorkbenchNetApiFaultPort(
          new WorkbenchNetApiClient(host, port, { clientId })
        );
      },
      createAdapter: (client) => new WorkbenchObserverAcceptanceAdapter(client, {
        handlerTimeoutMs: () => this.enforceCaseDeadline
          ? Math.min(10_000, remainingWorkbenchMatrixCaptureTimeout(this.caseDeadline))
          : 10_000,
        verifyIdempotentReleaseReplay: input.matrixCase.injection.action === "release_twice",
        ...(mutationHook ? {
          beforeArtifactValidation: (context) => {
            if (this.artifactFaultArmed) this.artifactMutation = mutationHook(context);
          },
        } : {}),
      }),
    });
    if (!(this.runtime.netApi instanceof FixtureOnlyWorkbenchNetApiFaultPort)) {
      throw new Error("Workbench matrix composition did not create its fixture fault port");
    }
    this.faultPort = this.runtime.netApi;
    this.runtime.baseline.sampleProcessCounts("rest.beforeLaunch");
  }

  async run(): Promise<WorkbenchLiveMatrixCaseOutcome> {
    try {
      await this.executeCase();
    } catch (error) {
      this.failure = error;
      this.failureObservedAt = Date.now();
    } finally {
      await this.cleanup();
    }
    const entry = this.finalizeCaseEntry();
    return this.recordOutcome(entry);
  }

  private async executeCase(): Promise<void> {
    await this.preflight();
    await this.beginManagedRun();
    await this.launchAndBindFixture();
    await this.openWorldAndCaptureBaseline();
    await this.prepareShutdownDecoy();
    await this.executeMatrixDispatcher();
  }

  private async preflight(): Promise<void> {
    this.services.assertNoArmaOrWorkbench(this.caseDeadline);
    await this.runtime.guard.assertNoWorkbenchProcesses();
    const endpoint = await this.runtime.guard.verifyEndpointVacant({
      host: this.runtime.config.workbenchHost,
      port: this.runtime.config.workbenchPort,
    });
    if (endpoint.kind !== "vacant") {
      throw new Error("The configured loopback Workbench endpoint is not vacant before launch");
    }
  }

  private async beginManagedRun(): Promise<void> {
    const begun = await this.runtime.application.beginRun({
      title: `Workbench observer failure matrix: ${this.matrixCase.id}`,
      caseIds: [this.matrixCase.id],
      procedureRevision: "workbench-failure-matrix-v3",
      idempotencyKey: `workbench-matrix-${randomUUID()}`,
    });
    this.runId = requiredString(begun.runId, "Managed observer matrix run ID");
    this.rememberSecret(this.runId);
  }

  private async launchAndBindFixture(): Promise<void> {
    const { baseline, client, project } = this.runtime;
    await baseline.measure(
      "launch",
      "WorkbenchClient.ensureRunning",
      () => client.ensureRunning(project.projectPath),
      "running_confirmation"
    );
    const lifecycle = await client.lifecycleIdentity();
    this.lifecycleGeneration = lifecycle.generation;
    this.rememberSecret(lifecycle.lifecycleId);
    this.rememberSecret(lifecycle.generation);

    const companion = client.managedCompanionStatus();
    const fixtureProfileRoot = join(companion.roleRoot, "profile", "profile");
    mkdirSync(fixtureProfileRoot, { recursive: true });
    const controlRoot = join(fixtureProfileRoot, "RFOWorkbenchObserverMatrix");
    const fixtureTemplateIdentity = operationalBaselineDirectoryIdentity(
      WORKBENCH_MATRIX_FIXTURE_TEMPLATE_DIR,
      [".c", ".gproj"]
    );
    const fixtureContentIdentity = operationalBaselineProcedureSha256({
      fixture: "workbench-observer-failure-matrix-addon",
      sourceSha256: fixtureTemplateIdentity.sha256,
    });
    const generatedProjectIdentity = operationalBaselineProcedureSha256({
      projectPath: project.projectPath,
      worldResource: project.worldResource,
      alternateWorldResource: project.alternateWorldResource,
    });
    const binding = Object.freeze({
      fixtureId: generatedProjectIdentity,
      lifecycleId: lifecycle.lifecycleId,
      lifecycleGeneration: lifecycle.generation,
    });
    const capability = randomUUID();
    this.rememberSecret(capability);
    this.faultScaffolding = createFaultMatrixRunScaffolding({
      runRoot: fixtureProfileRoot,
      controlRoot,
      matrix: OBSERVER_FAULT_MATRIX,
      caseDeadlineMs: this.timeoutMs,
      bootstrap: {
        schemaVersion: 1,
        runId: this.requireRunId(),
        backend: "workbench",
        capability,
        fixtureContentIdentity,
        generatedProjectIdentity,
        generatedAddonIdentity: WORKBENCH_MATRIX_FIXTURE_GUID,
        binding,
      },
      clock: systemClock,
      sleeper: systemSleeper,
      readLifecycleBinding: () => binding,
    });
  }

  private async openWorldAndCaptureBaseline(): Promise<void> {
    const { application, baseline, client, project } = this.runtime;
    const opened = await client.call<Record<string, unknown>>("EMCP_WB_EditorControl", {
      action: "openResource",
      path: project.worldResource,
    }, {
      skipAutoLaunch: true,
      timeout: Math.min(30_000, remainingWorkbenchMatrixCaptureTimeout(this.caseDeadline)),
    });
    if (opened.status !== "ok" || !String(opened.message ?? "").startsWith("Opened resource:")) {
      throw new Error(
        "The disposable Workbench matrix world did not open through the bounded editor control"
      );
    }
    const selected = await this.services.waitForCaptureCapability(application, this.caseDeadline);
    this.instanceId = requiredString(
      selected.instanceId,
      "Selected Workbench matrix instance ID"
    );
    this.expectedWorldId = requiredString(
      selected.worldId,
      "Selected Workbench matrix world ID"
    );
    this.rememberSecret(this.instanceId);

    this.baselineCapture = await baseline.measure(
      "capture",
      "ObserverApplication.capture(matrix-baseline-current)",
      () => this.services.captureAndRetainUnmeasured(
        application,
        { kind: "current" },
        "matrix-baseline-current",
        this.requireRunId(),
        this.requireInstanceId(),
        this.requireExpectedWorldId(),
        this.caseDeadline
      ),
      "baseline_current"
    );
    const matrixPing = await baseline.measure(
      "managed_call",
      "WorkbenchObserverAdapter.ping(EMCP_WB_ObserverPing)",
      () => this.runtime.adapter.ping(),
      "representative_net_api"
    );
    if (!matrixPing.capabilities.includes("render.capture") ||
        !matrixPing.capabilities.includes("camera.editor") ||
        !matrixPing.restorationApiAvailable) {
      throw new Error(
        "Workbench matrix baseline did not establish capture, editor-camera and restoration capability"
      );
    }
    this.captureView = workbenchMatrixCaptureView(
      this.matrixCase.view!,
      this.baselineCapture.completed.actualCamera,
      this.services.quaternionFromWorkbenchMatrix
    );
    this.artifactFaultArmed = this.mutation !== null;
  }

  private async prepareShutdownDecoy(): Promise<void> {
    if (this.matrixCase.injection.action !== "stop_owned_workbench") return;
    this.decoy = await launchWorkbenchMatrixDecoy(
      this.caseDirectory,
      this.runtime.lifecycleBackend,
      {
        deadlineAtMs: this.caseDeadline,
        onSpawn: (child) => { this.unqualifiedDecoyChild = child; },
      }
    );
    this.unqualifiedDecoyChild = null;
    this.rememberSecret(this.decoy.ownerArgument);
    this.rememberSecret(this.decoy.exitSentinel);

    if (this.matrixCase.injection.phase === "before_lease") {
      this.runtime.adapter.armOneShotBeforeSubmitDelivery(async (context) => {
        this.assertLifecycleBinding(context);
        this.runtime.adapter.requireExactOwnerExit(context.jobId);
        const shutdown = await this.shutdownOwnedWorkbench();
        return { exactOwnerVacant: shutdown.exactOwnerVacant };
      });
    }
  }

  private async executeMatrixDispatcher(): Promise<void> {
    const scaffolding = this.requireFaultScaffolding();
    scaffolding.scheduler.setDeadline(deadlineAt(this.caseDeadline));
    this.caseEntry = await this.runtime.baseline.measure(
      "capture",
      "runWorkbenchMatrixCase",
      () => runWorkbenchMatrixCase({
        application: this.runtime.application,
        adapter: this.runtime.adapter,
        scheduler: scaffolding.scheduler,
        actions: this.createMatrixActions(),
        matrixCase: this.matrixCase,
        runId: this.requireRunId(),
        instanceId: this.requireInstanceId(),
        expectedWorldId: this.requireExpectedWorldId(),
        baselineCurrent: this.requireBaselineCapture().completed,
        captureView: this.requireCaptureView(),
        caseStartedAt: this.caseStartedAt,
        caseDeadline: this.caseDeadline,
        caseBudgetMs: this.timeoutMs,
        onPublicTerminal: (terminal) => { this.observedPublicTerminal = terminal; },
      }),
      "fault_case"
    );
  }

  private createMatrixActions(): WorkbenchMatrixCaseActions {
    return {
      armHandlerLoss: ({ phase, jobId }) => {
        this.faultPort.armOneShotLoss({
          handler: phase === "before_lease"
            ? "EMCP_WB_ObserverPing"
            : phase === "terminal_release"
              ? "EMCP_WB_ObserverRelease"
              : "EMCP_WB_ObserverStatus",
          boundary: phase === "before_lease" || this.matrixCase.view === "pose"
            ? "response"
            : "request",
          ...(jobId ? { matchParams: { jobId } } : {}),
        });
      },
      handlerLossResult: () => this.faultPort.result(),
      requireExactOwnerExit: (jobId) => {
        this.runtime.adapter.requireExactOwnerExit(jobId);
      },
      confirmExactOwnerExit: (jobId, exactOwnerVacant) => {
        this.runtime.adapter.confirmExactOwnerExit(jobId, exactOwnerVacant);
      },
      replaceFixtureWorld: () => this.replaceFixtureWorld(),
      armTerminalReleaseOwnerShutdown: (jobId) => {
        this.armTerminalReleaseOwnerShutdown(jobId);
      },
      shutdownOwnedWorkbench: () => this.shutdownOwnedWorkbench(),
      verifyShutdownDecoy: () => this.verifyAndReleaseDecoy(this.caseDeadline),
      artifactMutationResult: () => this.artifactMutation,
      finalizeValidatedCapture: (capture) => this.finalizeValidatedCapture(capture),
      discardRun: () => this.discardManagedRun(),
    };
  }

  private async replaceFixtureWorld(): Promise<{ readonly currentWorldId: string }> {
    const { application, client, project } = this.runtime;
    if (!project.alternateWorldResource) {
      throw new Error("The disposable matrix project omitted its alternate world");
    }
    const replaced = await client.call<Record<string, unknown>>("EMCP_WB_EditorControl", {
      action: "openResource",
      path: project.alternateWorldResource,
    }, {
      skipAutoLaunch: true,
      timeout: Math.min(30_000, remainingWorkbenchMatrixCaptureTimeout(this.caseDeadline)),
    });
    if (replaced.status !== "ok" || !String(replaced.message ?? "").startsWith("Opened resource:")) {
      throw new Error("The disposable alternate Workbench world did not open");
    }
    const replacement = await this.services.waitForCaptureCapability(
      application,
      this.caseDeadline
    );
    if (requiredString(replacement.instanceId, "Replacement Workbench instance ID") !==
        this.requireInstanceId()) {
      throw new Error("Opening Matrix B changed the exact Workbench lifecycle instance");
    }
    return {
      currentWorldId: requireWorkbenchReplacementWorldId(
        this.requireExpectedWorldId(),
        replacement.worldId
      ),
    };
  }

  private armTerminalReleaseOwnerShutdown(jobId: string): void {
    this.runtime.adapter.armOneShotBeforeRelease(jobId, async (context) => {
      this.assertLifecycleBinding(context, jobId);
      const shutdown = await this.shutdownOwnedWorkbench();
      return { exactOwnerVacant: shutdown.exactOwnerVacant };
    });
  }

  private assertLifecycleBinding(
    context: WorkbenchObserverBeforeSubmitDeliveryContext,
    expectedJobId?: string
  ): void {
    if ((expectedJobId !== undefined && context.jobId !== expectedJobId) ||
        context.instanceId !== this.requireInstanceId() ||
        context.lifecycleGeneration !== this.requireLifecycleGeneration() ||
        context.canonicalTarget.toLowerCase() !==
          this.runtime.project.projectPath.toLowerCase()) {
      throw new Error(
        expectedJobId === undefined
          ? "Before-lease owner-exit hook received a different Workbench lifecycle binding"
          : "Terminal owner-exit hook received a different Workbench lifecycle binding"
      );
    }
  }

  private async finalizeValidatedCapture(
    capture: WorkbenchMatrixValidatedCapture
  ): Promise<{ readonly manifestPublished: boolean }> {
    const baselineCapture = this.requireBaselineCapture();
    const finalizationRunId = this.requireRunId();
    const png = analyzePngMaterial(capture.image);
    if (!png.materiallyVaried || capture.metadata.contentSha256 !== png.sha256 ||
        capture.metadata.bytes !== png.byteCount || capture.metadata.width !== png.width ||
        capture.metadata.height !== png.height) {
      throw new Error("Workbench matrix primary artifact failed independent PNG/metadata validation");
    }
    const completed = {
      ...capture.completed,
      worldIdentity: requiredString(
        capture.completed.worldId ?? this.requireExpectedWorldId(),
        "Workbench matrix completed world identity"
      ),
    } as unknown as WorkbenchObserverJobStatus;
    const primary: WorkbenchLiveRetainedCapture = {
      label: "matrix-primary",
      submitted: capture.submitted,
      completed,
      image: capture.image,
      png,
    };
    const captures = [baselineCapture, primary];
    const finalized = await this.runtime.application.finalizeRun({
      runId: finalizationRunId,
      evidenceRoot: this.runtime.evidenceRoot,
      includeCaptureLabels: captures.map((item) => item.label),
      review: {
        imagesReviewed: false,
        outcome: "Unreviewed",
        summary: "Automation validated PNG integrity and declared Workbench restoration evidence; image content remains unreviewed.",
        limitations: [
          "This automated matrix does not make an editorial-content claim from screenshots.",
        ],
      },
      runtimeConfig: {
        configurationId: "workbench-observer-failure-matrix-v3",
        values: {
          backend: "workbench",
          caseId: this.matrixCase.id,
          settleFrames: 3,
          expectedWorldEpoch: 0,
        },
      },
      releaseManagedArtifacts: true,
    });
    this.services.validateFinalizedBundle(
      finalized,
      this.runtime.evidenceRoot,
      finalizationRunId,
      captures
    );
    this.runClosed = true;
    return { manifestPublished: true };
  }

  private async discardManagedRun(): Promise<void> {
    if (!this.runClosed && this.runId) {
      await this.runtime.application.discardRun(this.runId);
      this.runClosed = true;
    }
  }

  private shutdownOwnedWorkbench(): Promise<WorkbenchMatrixShutdownEvidence> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.performOwnedWorkbenchShutdown();
    }
    return this.shutdownPromise;
  }

  private async performOwnedWorkbenchShutdown(): Promise<WorkbenchMatrixShutdownEvidence> {
    const shutdown = await this.runtime.baseline.measure(
      "shutdown",
      "WorkbenchClient.shutdownOwnedWorkbench",
      () => this.runtime.client.shutdownOwnedWorkbench(),
      "termination",
      (result) => ({ stopped: result.stopped })
    );
    this.exactWorkbenchVacant = shutdown.stopped;
    const endpoint = await this.runtime.guard.verifyEndpointVacant({
      host: this.runtime.config.workbenchHost,
      port: this.runtime.config.workbenchPort,
    });
    this.endpointVacant = endpoint.kind === "vacant";
    if (!this.exactWorkbenchVacant || !this.endpointVacant) {
      throw new Error(
        "Owner-scoped Workbench shutdown did not prove exact process and endpoint vacancy"
      );
    }
    return { exactOwnerVacant: true };
  }

  private async verifyAndReleaseDecoy(
    deadlineAtMs?: number
  ): Promise<WorkbenchDecoyIdentityResult | undefined> {
    if (!this.decoy) return undefined;
    if (!this.decoy.comparison) {
      if (!this.exactWorkbenchVacant || !this.endpointVacant) {
        throw new Error(
          "Decoy identity comparison requires owned Workbench and endpoint vacancy first"
        );
      }
      const pid = this.decoy.child.pid;
      if (!pid) {
        throw new Error("The Workbench shutdown decoy lost its spawned PID before comparison");
      }
      const after = await this.runtime.lifecycleBackend.inspectProcess(
        pid,
        this.decoy.ownerArgument
      );
      this.decoy.comparison = compareWorkbenchDecoyIdentity(this.decoy.before, after);
      this.decoyEvidence = {
        category: this.decoy.comparison.identityUnchanged ? "verified" : "unproven",
        identityUnchanged: this.decoy.comparison.identityUnchanged ? true : null,
      };
      if (!this.decoy.comparison.identityUnchanged) {
        throw new Error(
          `Workbench shutdown decoy identity comparison failed: ${this.decoy.comparison.category}`
        );
      }
    }
    if (!existsSync(this.decoy.exitSentinel)) {
      writeFileSync(this.decoy.exitSentinel, "exit\n", { encoding: "utf8", flag: "wx" });
    }
    if (!this.decoy.exited) await waitForWorkbenchDecoyExit(this.decoy, deadlineAtMs);
    return this.decoy.comparison;
  }

  private async cleanup(): Promise<void> {
    this.enforceCaseDeadline = false;
    await this.attemptCleanup(() => this.discardManagedRun());
    await this.cleanupFaultScaffolding();
    await this.attemptCleanup(() => this.runtime.adapter.restoreAll());
    await this.attemptCleanup(() => this.runtime.baseline.measure(
      "shutdown",
      "ObserverApplication.close",
      () => this.runtime.application.close(),
      "observer_cleanup"
    ));
    await this.ensureOwnedWorkbenchVacancy();
    await this.verifyEndpointVacancy();
    await this.cleanupQualifiedDecoy();
    await this.cleanupUnqualifiedDecoy();
    await this.settleSupervisedChildren();
    this.runtime.baseline.sampleProcessCounts("rest.afterShutdown");
    await this.attemptCleanup(() => this.runtime.close());
  }

  private async cleanupFaultScaffolding(): Promise<void> {
    if (!this.faultScaffolding) return;
    await this.attemptCleanup(() => this.faultScaffolding!.scheduler.finishCase());
    await this.attemptCleanup(() => {
      removeOwnedFaultControlRoot(this.faultScaffolding!.controlRoot);
    });
  }

  private async ensureOwnedWorkbenchVacancy(): Promise<void> {
    if (this.exactWorkbenchVacant) return;
    try {
      const shutdown = await this.runtime.baseline.measure(
        "shutdown",
        "WorkbenchClient.shutdownOwnedWorkbench",
        () => this.runtime.client.shutdownOwnedWorkbench(),
        "termination",
        (result) => ({ stopped: result.stopped })
      );
      this.exactWorkbenchVacant = shutdown.stopped;
    } catch (error) {
      this.rememberFailure(error);
      try {
        const cleanupClient = this.runtime.createRecoveryClient(
          "live-workbench-matrix-recovery"
        );
        const recovery = await cleanupClient.shutdownOwnedWorkbench();
        this.exactWorkbenchVacant = recovery.stopped;
      } catch { /* preserve the first shutdown failure */ }
    }
  }

  private async verifyEndpointVacancy(): Promise<void> {
    await this.attemptCleanup(async () => {
      const endpoint = await this.runtime.guard.verifyEndpointVacant({
        host: this.runtime.config.workbenchHost,
        port: this.runtime.config.workbenchPort,
      });
      this.endpointVacant = endpoint.kind === "vacant";
      if (!this.endpointVacant) {
        this.failure ??= new Error("Workbench matrix cleanup did not prove endpoint vacancy");
      }
    });
  }

  private async cleanupQualifiedDecoy(): Promise<void> {
    if (this.decoy && !this.decoy.exited &&
        this.exactWorkbenchVacant && this.endpointVacant) {
      await this.attemptCleanup(() => this.verifyAndReleaseDecoy());
    }
  }

  private async cleanupUnqualifiedDecoy(): Promise<void> {
    const child = this.unqualifiedDecoyChild;
    if (!child || child.exitCode !== null) return;
    await this.attemptCleanup(async () => {
      if (!existsSync(this.decoyExitSentinel)) {
        writeFileSync(this.decoyExitSentinel, "exit\n", { encoding: "utf8", flag: "wx" });
      }
      if (!await waitForChildExit(child, 10_000)) {
        this.failure ??= new Error(
          "Workbench matrix cleanup could not prove the unqualified decoy exited through its sentinel"
        );
      }
    });
  }

  private async settleSupervisedChildren(): Promise<void> {
    await this.attemptCleanup(async () => {
      const vacancy = await this.runtime.baseline.measure(
        "shutdown",
        "waitForOperationalBaselineProcessVacancy",
        () => waitForOperationalBaselineProcessVacancy(this.runtime.readProcessCounts),
        "supervised_exit_settle",
        (result) => ({ vacant: result.vacant, finalTotal: result.counts.total })
      );
      this.supervisedVacant = vacancy.vacant;
      if (!this.supervisedVacant) {
        this.failure ??= new Error(
          "Workbench matrix cleanup did not prove supervised child vacancy"
        );
      }
    });
  }

  private async attemptCleanup(operation: () => void | Promise<unknown>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.rememberFailure(error);
    }
  }

  private finalizeCaseEntry(): MatrixCaseEntry {
    const cleanup = {
      lifecycleVacant: this.exactWorkbenchVacant,
      endpointVacant: this.endpointVacant,
      childVacant: this.supervisedVacant,
      exactOwnerVacant: this.exactWorkbenchVacant,
    };
    if (!this.exactWorkbenchVacant || !this.endpointVacant || !this.supervisedVacant) {
      this.failure ??= new Error("Workbench matrix case cleanup did not prove complete vacancy");
    }
    if (this.caseEntry) {
      this.caseEntry = {
        ...this.caseEntry,
        result: this.failure ? "failed" : "passed",
        cleanup,
        ownerShutdown: this.matrixCase.cameraDisposition === "exact_process_exit" ||
            this.matrixCase.injection.action === "stop_owned_workbench"
          ? this.exactWorkbenchVacant ? "exact_owner_vacant" : "owner_still_present"
          : "not_applicable",
        decoy: this.decoyEvidence,
        ...(this.failure ? {
          retainedDiagnostics: [
            ...this.caseEntry.retainedDiagnostics,
            matrixRetainedDiagnostic(
              this.failure instanceof Error
                ? `${this.failure.name}: ${this.failure.message}`
                : String(this.failure),
              this.knownSecretValues
            ),
          ],
        } : {}),
      };
      return this.caseEntry;
    }
    const rootFailure = this.failure ?? new Error(
      "Workbench matrix case produced no evidence entry"
    );
    this.caseEntry = failedWorkbenchMatrixEntry({
      matrixCase: this.matrixCase,
      publicTerminal: this.observedPublicTerminal,
      startedAt: this.caseStartedAt,
      failureObservedAt: this.failureObservedAt ?? Date.now(),
      budgetMs: this.timeoutMs,
      failure: rootFailure,
      knownSecretValues: this.knownSecretValues,
      cleanup,
      exactOwnerShutdown: this.exactWorkbenchVacant,
      decoy: this.decoyEvidence,
    });
    this.failure = rootFailure;
    return this.caseEntry;
  }

  private recordOutcome(entry: MatrixCaseEntry): WorkbenchLiveMatrixCaseOutcome {
    const environment = operationalBaselineEnvironment(
      workbenchEnvironmentExecutables(this.runtime.config)
    );
    const recorded = this.runtime.baseline.artifact({
      result: this.failure ? "failed" : "passed",
      environment,
      workload: {
        procedureRevision: "workbench-failure-matrix-v3",
        runtimeKind: "workbench",
        overallTimeoutMs: this.timeoutMs,
        worldResource: "Worlds/ObserverMatrixA.ent",
        fixture: {
          kind: "disposable_workbench_world",
          id: "ObserverMatrixA_B",
          guid: null,
          sourceFileCount: 1,
          sourceSha256: operationalBaselineProcedureSha256({ caseId: this.matrixCase.id }),
        },
        capture: {
          labels: [
            "matrix-baseline-current",
            "matrix-primary",
            "matrix-followup-current",
            "matrix-competing",
          ],
          settleFrames: 3,
          performancePolicy: "evidence",
          asynchronous: true,
          configurationSha256: operationalBaselineProcedureSha256({
            caseId: this.matrixCase.id,
          }),
        },
        launchArguments: this.runtime.launchArguments,
      },
      source: this.services.readSource(),
      limitations: [
        "Per-case native Workbench measurement; aggregate publication applies no timing threshold.",
      ],
      ...(this.failure ? {
        failureName: this.failure instanceof Error
          ? this.failure.name
          : "WorkbenchMatrixCaseError",
      } : {}),
    });
    return {
      entry,
      failure: this.failure,
      knownSecretValues: this.knownSecretValues,
      measurements: recorded.measurements,
      processCounts: recorded.processCounts,
      launchArguments: this.runtime.launchArguments,
      environment,
      retainForDecoyRecovery: Boolean(
        (this.decoy && !this.decoy.exited) ||
        (this.unqualifiedDecoyChild && this.unqualifiedDecoyChild.exitCode === null)
      ),
    };
  }

  private rememberSecret(value: string | null | undefined): void {
    if (value && !this.knownSecretValues.includes(value)) {
      this.knownSecretValues.push(value);
    }
  }

  private rememberFailure(error: unknown): void {
    this.failure ??= error;
  }

  private requireRunId(): string {
    return requiredString(this.runId, "Active Workbench matrix run ID");
  }

  private requireLifecycleGeneration(): string {
    return requiredString(
      this.lifecycleGeneration,
      "Active Workbench lifecycle generation"
    );
  }

  private requireInstanceId(): string {
    return requiredString(this.instanceId, "Active Workbench matrix instance ID");
  }

  private requireExpectedWorldId(): string {
    return requiredString(this.expectedWorldId, "Active Workbench matrix world ID");
  }

  private requireCaptureView(): ObserverCaptureView {
    if (!this.captureView) throw new Error("Workbench matrix capture view is unavailable");
    return this.captureView;
  }

  private requireBaselineCapture(): WorkbenchLiveRetainedCapture {
    if (!this.baselineCapture) {
      throw new Error("Workbench matrix baseline capture is unavailable");
    }
    return this.baselineCapture;
  }

  private requireFaultScaffolding(): FaultMatrixRunScaffolding {
    if (!this.faultScaffolding) {
      throw new Error("Workbench matrix fixture scaffolding is unavailable");
    }
    return this.faultScaffolding;
  }
}

export async function runLiveWorkbenchMatrixCase(
  input: RunLiveWorkbenchMatrixCaseInput,
  services: WorkbenchLiveMatrixCaseServices
): Promise<WorkbenchLiveMatrixCaseOutcome> {
  return new WorkbenchLiveMatrixCaseExecution(input, services).run();
}
