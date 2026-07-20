import { pathComparisonKey } from "../foundation/managed-path.js";
import type { WorkbenchCompanionLaunch } from "./helper-addon.js";
import type { CanonicalProjectIdentity as ProjectIdentity } from "./project-identity.js";
import type {
  ExpectedStateVersion,
  LifecycleStateDraft,
  McpOwnerIdentity,
  WorkbenchCompanionLifecycleState,
  WorkbenchIdentity,
  WorkbenchLifecycleSession,
  WorkbenchLifecycleStateV3,
  WorkbenchProcessGuard,
} from "./process-guard.js";

/** The deliberately small project identity persisted in lifecycle JSON v3. */
export type WorkbenchLifecycleTarget = NonNullable<WorkbenchLifecycleStateV3["target"]>;

export class WorkbenchSessionStateError extends Error {
  constructor(
    message: string,
    public readonly code: "STALE_RESERVATION"
  ) {
    super(message);
    this.name = "WorkbenchSessionStateError";
  }
}

export function toLifecycleTarget(project: ProjectIdentity): WorkbenchLifecycleTarget {
  return Object.freeze({
    path: project.displayPath,
    comparisonKey: project.comparisonKey,
  });
}

export function expectedStateVersion(state: WorkbenchLifecycleStateV3): ExpectedStateVersion {
  return Object.freeze({
    generation: state.generation,
    leaseId: state.mcpOwner?.leaseId ?? null,
  });
}

/** Copy a v3 state into a transition draft without changing its wire format. */
export function lifecycleStateDraft(
  state: WorkbenchLifecycleStateV3,
  overrides: Partial<LifecycleStateDraft> = {}
): LifecycleStateDraft {
  return {
    phase: overrides.phase ?? state.phase,
    endpoint: overrides.endpoint ?? state.endpoint,
    target: overrides.target === undefined ? state.target : overrides.target,
    mcpOwner: overrides.mcpOwner === undefined ? state.mcpOwner : overrides.mcpOwner,
    workbench: overrides.workbench === undefined ? state.workbench : overrides.workbench,
    companion: overrides.companion === undefined ? state.companion : overrides.companion,
    operation: overrides.operation === undefined ? state.operation : overrides.operation,
  };
}

export function toCompanionLifecycleState(
  companion: WorkbenchCompanionLaunch
): WorkbenchCompanionLifecycleState {
  return Object.freeze({
    addonId: companion.addonId,
    addonGuid: companion.addonGuid,
    addonDirectory: companion.addonDirectory,
    addonSearchRoot: companion.addonSearchRoot,
    bundleDigest: companion.bundleDigest,
    buildIdentity: companion.buildIdentity,
    profilePath: companion.workbenchProfilePath,
  });
}

function samePath(left: string, right: string): boolean {
  return pathComparisonKey(left) === pathComparisonKey(right);
}

export function sameLifecycleOwner(
  left: McpOwnerIdentity | null,
  right: McpOwnerIdentity | null
): boolean {
  if (!left || !right) return left === right;
  return left.pid === right.pid &&
    samePath(left.executablePath, right.executablePath) &&
    left.creationTime === right.creationTime &&
    left.userSid === right.userSid &&
    left.instanceId === right.instanceId &&
    left.leaseId === right.leaseId;
}

export function sameWorkbenchIdentity(
  left: WorkbenchIdentity | null,
  right: WorkbenchIdentity | null
): boolean {
  if (!left || !right) return left === right;
  return left.pid === right.pid &&
    samePath(left.executablePath, right.executablePath) &&
    left.creationTime === right.creationTime &&
    left.ownerTokenArgument === right.ownerTokenArgument &&
    left.launchedAtMs === right.launchedAtMs;
}

export function sameLifecycleTarget(
  left: WorkbenchLifecycleTarget | null,
  right: WorkbenchLifecycleTarget | null
): boolean {
  if (!left || !right) return left === right;
  return left.comparisonKey === right.comparisonKey && samePath(left.path, right.path);
}

export function sameCompanionLifecycleState(
  left: WorkbenchCompanionLifecycleState | null,
  right: WorkbenchCompanionLifecycleState | null
): boolean {
  if (!left || !right) return left === right;
  return left.addonId === right.addonId &&
    left.addonGuid === right.addonGuid &&
    samePath(left.addonDirectory, right.addonDirectory) &&
    samePath(left.addonSearchRoot, right.addonSearchRoot) &&
    left.bundleDigest === right.bundleDigest &&
    left.buildIdentity === right.buildIdentity &&
    samePath(left.profilePath, right.profilePath);
}

/** Compare every field that grants authority to publish after unlocked work. */
export function sameLifecycleAuthority(
  left: WorkbenchLifecycleStateV3,
  right: WorkbenchLifecycleStateV3
): boolean {
  return left.generation === right.generation &&
    left.phase === right.phase &&
    left.endpoint.host === right.endpoint.host &&
    left.endpoint.port === right.endpoint.port &&
    sameLifecycleTarget(left.target, right.target) &&
    sameLifecycleOwner(left.mcpOwner, right.mcpOwner) &&
    sameWorkbenchIdentity(left.workbench, right.workbench) &&
    sameCompanionLifecycleState(left.companion, right.companion) &&
    left.operation?.kind === right.operation?.kind &&
    left.operation?.operationId === right.operation?.operationId;
}

export async function requireReservedLifecycle(
  session: Pick<WorkbenchLifecycleSession, "readState">,
  expected: WorkbenchLifecycleStateV3
): Promise<WorkbenchLifecycleStateV3> {
  const read = await session.readState();
  if (read.kind !== "valid" ||
      read.state.generation !== expected.generation ||
      !sameLifecycleOwner(read.state.mcpOwner, expected.mcpOwner) ||
      !sameWorkbenchIdentity(read.state.workbench, expected.workbench)) {
    throw new WorkbenchSessionStateError(
      "Lifecycle generation or exact owner changed while the machine mutex was released; " +
        "the stale mutation was refused and durable recovery evidence was preserved.",
      "STALE_RESERVATION"
    );
  }
  return read.state;
}

export function transitionReservedLifecycle(
  guard: WorkbenchProcessGuard,
  expected: WorkbenchLifecycleStateV3,
  overrides: Partial<LifecycleStateDraft>
): Promise<WorkbenchLifecycleStateV3> {
  return guard.withLifecycleLock(async (session) => {
    const current = await requireReservedLifecycle(session, expected);
    return session.transition(
      expectedStateVersion(current),
      lifecycleStateDraft(current, overrides)
    );
  });
}

export function vacateReservedLifecycle(
  guard: WorkbenchProcessGuard,
  expected: WorkbenchLifecycleStateV3,
  overrides: Partial<Pick<LifecycleStateDraft, "endpoint" | "target" | "companion">> = {}
): Promise<WorkbenchLifecycleStateV3> {
  return guard.withLifecycleLock(async (session) => {
    const current = await requireReservedLifecycle(session, expected);
    return session.transitionToVacant(expectedStateVersion(current), overrides);
  });
}
