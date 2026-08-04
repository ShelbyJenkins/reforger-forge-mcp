import {
  assertWorldRevision,
  worldRevisionKind,
  type WorldRevision,
} from "./world-revision.js";
import { CaptureError, type CaptureBackendKind, type CaptureInstance } from "./capture-contract.js";

const TARGET_PREFIX = "ct1.";
const MAX_TARGET_LENGTH = 8_192;
const MAX_IDENTIFIER_LENGTH = 96;

export interface CaptureTargetBinding {
  backend: CaptureBackendKind;
  sessionId?: string;
  instanceId: string;
  expectedWorldRevision: WorldRevision;
}

function boundedIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new CaptureError("INVALID_REQUEST", `${label} in capture target is invalid`);
  }
  return value;
}

function validateBinding(input: Record<string, unknown>): CaptureTargetBinding {
  const keys = Object.keys(input).sort();
  const backend = input.backend;
  if (backend !== "runtime" && backend !== "workbench") {
    throw new CaptureError("INVALID_REQUEST", "Capture target backend is invalid");
  }
  const expectedKeys = backend === "runtime"
    ? ["backend", "expectedWorldRevision", "instanceId", "sessionId"]
    : ["backend", "expectedWorldRevision", "instanceId"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new CaptureError("INVALID_REQUEST", "Capture target contains missing or unsupported fields");
  }
  const instanceId = boundedIdentifier(input.instanceId, "instanceId");
  let revision: WorldRevision;
  try {
    revision = assertWorldRevision(input.expectedWorldRevision, "capture target world revision");
  } catch {
    throw new CaptureError("INVALID_REQUEST", "Capture target world revision is malformed");
  }
  if (worldRevisionKind(revision) !== backend) {
    throw new CaptureError("INVALID_REQUEST", "Capture target backend does not match its world revision");
  }
  if (backend === "runtime") {
    return {
      backend,
      sessionId: boundedIdentifier(input.sessionId, "sessionId"),
      instanceId,
      expectedWorldRevision: revision,
    };
  }
  return { backend, instanceId, expectedWorldRevision: revision };
}

export function encodeCaptureTarget(
  input: CaptureTargetBinding | Pick<CaptureInstance, "backend" | "sessionId" | "instanceId" | "worldRevision">,
): string {
  const binding = validateBinding({
    backend: input.backend,
    ...(input.backend === "runtime" ? { sessionId: input.sessionId } : {}),
    instanceId: input.instanceId,
    expectedWorldRevision: "expectedWorldRevision" in input
      ? input.expectedWorldRevision
      : input.worldRevision,
  });
  const encoded = Buffer.from(JSON.stringify(binding), "utf8").toString("base64url");
  const target = `${TARGET_PREFIX}${encoded}`;
  if (target.length > MAX_TARGET_LENGTH) {
    throw new CaptureError("INVALID_REQUEST", "Capture target exceeds the supported length");
  }
  return target;
}

export function decodeCaptureTarget(target: unknown): CaptureTargetBinding {
  if (typeof target !== "string" || target.length <= TARGET_PREFIX.length ||
      target.length > MAX_TARGET_LENGTH || !target.startsWith(TARGET_PREFIX)) {
    throw new CaptureError("INVALID_REQUEST", "Capture target version or length is invalid");
  }
  const encoded = target.slice(TARGET_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new CaptureError("INVALID_REQUEST", "Capture target payload is not canonical base64url");
  }
  let decoded: unknown;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new Error("non-canonical base64url");
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CaptureError("INVALID_REQUEST", "Capture target payload is malformed");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new CaptureError("INVALID_REQUEST", "Capture target payload must be an object");
  }
  return validateBinding(decoded as Record<string, unknown>);
}
