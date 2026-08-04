import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createObserverApplication, type CreateObserverApplicationOptions } from "./application.js";
import type { ObserverApplicationOperationName } from "./application-operations.js";
import { errorBody, ObserverError } from "./errors.js";
import { setObserverDebugEnabled } from "./logger.js";

export {
  claimRuntimeStopReservation,
  releaseRuntimeStopReservation,
  runtimeStopObligations,
  uninstallManagedObserver,
} from "./application-operations.js";

const CHILD_PROTOCOL = "rfo-observer-child-v1" as const;

interface ChildRequest {
  protocol: typeof CHILD_PROTOCOL;
  type: "request";
  requestId: string;
  operation: string;
  payload?: unknown;
}

function option(argumentsArray: string[], name: string): string | undefined {
  const index = argumentsArray.indexOf(name);
  return index >= 0 ? argumentsArray[index + 1] : undefined;
}

function optionValues(argumentsArray: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argumentsArray.length; index += 1) {
    if (argumentsArray[index] === name && argumentsArray[index + 1] !== undefined) values.push(argumentsArray[index + 1]);
  }
  return values;
}

function boundedIntegerOption(argumentsArray: string[], name: string, minimum: number, maximum: number): number | undefined {
  const value = option(argumentsArray, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ObserverError("INVALID_REQUEST", `${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function payload(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ObserverError("INVALID_REQUEST", "Private observer operation requires an object payload");
  return value as Record<string, unknown>;
}

function send(message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.connected || !process.send) {
      reject(new ObserverError("TRANSPORT_UNAVAILABLE", "Private observer parent channel is closed", 503));
      return;
    }
    process.send(message, (error) => error ? reject(error) : resolve());
  });
}

const PRIVATE_ALLOWLIST = new Set<ObserverApplicationOperationName>([
  "status", "doctor", "stage", "prepareLaunch", "revoke", "instances",
  "runtimeLifecycleRetain", "runtimeLifecycleRelease", "runtimeStopPreflight",
  "runtimeStopRelease", "runtimeStopComplete", "submitJob", "jobStatus",
  "cancelJob", "readArtifact", "readWorkbenchArtifact", "inspectWorkbenchArtifact",
  "importWorkbenchArtifact", "runBegin", "runStatus", "runReserveCapture",
  "runBindCapture", "runSubmitCapture", "runReviseCaptureAdmission",
  "runCompleteCapture", "runFailCapture", "runFinalize",
  "runDiscard", "assertJobReleaseAllowed", "releaseJob", "releaseWorkbenchArtifact",
  "uninstall", "shutdown",
]);

export async function runPrivateObserverChild(argumentsArray: string[]): Promise<void> {
  if (!process.send || !process.connected) throw new ObserverError("TRANSPORT_UNAVAILABLE", "Private observer agent requires an inherited Node IPC channel", 503);
  setObserverDebugEnabled(argumentsArray.includes("--debug"));
  const options: CreateObserverApplicationOptions = {
    root: option(argumentsArray, "--root"),
    profileRoot: option(argumentsArray, "--profile-root"),
    sourceDirectory: option(argumentsArray, "--source-addon"),
    evidenceRoots: optionValues(argumentsArray, "--evidence-root"),
    supportingLogRoots: optionValues(argumentsArray, "--supporting-log-root"),
    host: "127.0.0.1",
    port: 0,
    enableControlHttp: false,
    retentionIntervalMs: boundedIntegerOption(argumentsArray, "--retention-interval-ms", 1_000, 24 * 60 * 60_000),
    retentionMaxAgeMs: boundedIntegerOption(argumentsArray, "--retention-max-age-ms", 1_000, 5 * 365 * 24 * 60 * 60_000),
    retentionMaxBytes: boundedIntegerOption(argumentsArray, "--retention-max-bytes", 1_024 * 1_024, 64 * 1024 * 1024 * 1024),
    sweepIntervalMs: boundedIntegerOption(argumentsArray, "--sweep-interval-ms", 100, 60_000),
    sessionStore: {
      terminalRetentionMs: boundedIntegerOption(argumentsArray, "--session-terminal-retention-ms", 0, 24 * 60 * 60_000),
    },
  };
  const application = createObserverApplication(options);
  const descriptor = await application.server.start();
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await application.server.close().catch(() => undefined);
    if (process.connected) process.disconnect();
  };

  let requestQueue = Promise.resolve();
  process.on("message", (value: unknown) => {
    requestQueue = requestQueue.then(async () => {
      if (!value || typeof value !== "object") return;
      const request = value as Partial<ChildRequest>;
      if (request.protocol !== CHILD_PROTOCOL || request.type !== "request" ||
          typeof request.requestId !== "string" || request.requestId.length > 96 ||
          typeof request.operation !== "string" || request.operation.length > 64) return;
      try {
        if (!PRIVATE_ALLOWLIST.has(request.operation as ObserverApplicationOperationName)) {
          throw new ObserverError("INVALID_REQUEST", `Unknown private observer operation: ${request.operation}`, 404);
        }
        const result = await application.operations.execute(request.operation as ObserverApplicationOperationName, payload(request.payload));
        await send({ protocol: CHILD_PROTOCOL, type: "response", requestId: request.requestId, ok: true, result });
      } catch (error) {
        await send({ protocol: CHILD_PROTOCOL, type: "response", requestId: request.requestId, ok: false, error: errorBody(error).error }).catch(() => undefined);
      }
      if (request.operation === "shutdown") await close();
    }).catch(() => undefined);
  });

  process.once("disconnect", () => void close());
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  await send({
    protocol: CHILD_PROTOCOL,
    type: "ready",
    childInstanceId: randomUUID(),
    descriptor: {
      protocolVersion: descriptor.protocolVersion,
      agentVersion: descriptor.agentVersion,
      agentInstanceId: descriptor.agentInstanceId,
      host: descriptor.host,
      port: descriptor.port,
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runPrivateObserverChild(process.argv.slice(2)).catch(async (error) => {
    await send({ protocol: CHILD_PROTOCOL, type: "fatal", error: errorBody(error).error }).catch(() => undefined);
    process.exitCode = 1;
  });
}
