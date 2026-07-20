import { Socket } from "node:net";
import { decodePascalString, encodeRequest } from "./protocol.js";

export const DEFAULT_WORKBENCH_NET_API_CLIENT_ID = "EnfusionMCP";
export const DEFAULT_WORKBENCH_NET_API_TIMEOUT_MS = 10_000;
export const DEFAULT_WORKBENCH_NET_API_RESPONSE_CAP_BYTES = 10 * 1024 * 1024;

export type WorkbenchNetApiErrorCode =
  | "connection_refused"
  | "timeout"
  | "protocol"
  | "api_error";

/** A transport-only failure. Public facades map this into their own error enums. */
export class WorkbenchNetApiError extends Error {
  constructor(
    message: string,
    public readonly code: WorkbenchNetApiErrorCode,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "WorkbenchNetApiError";
  }
}

export interface WorkbenchNetApiCallOptions {
  /** Complete connect/write/read deadline for this call. */
  timeoutMs?: number;
  /** Per-call response bound. Useful for narrow calls such as companion Ping. */
  responseCapBytes?: number;
}

export interface WorkbenchNetApiPort {
  call<T = Record<string, unknown>>(
    apiFunc: string,
    params?: Record<string, unknown>,
    options?: WorkbenchNetApiCallOptions
  ): Promise<T>;
}

export interface WorkbenchNetApiClientOptions {
  clientId?: string;
  defaultTimeoutMs?: number;
  responseCapBytes?: number;
}

/** Test seam for observing socket cleanup without replacing transport policy. */
export interface WorkbenchNetApiClientDependencies {
  socketFactory?: () => Socket;
}

function requireNonEmpty(value: string, label: string): string {
  if (value.length === 0) {
    throw new TypeError(`${label} must not be empty.`);
  }
  return value;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function requirePort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new RangeError("Workbench NET API port must be an integer from 1 through 65535.");
  }
  return value;
}

function collectOwnerTokenValues(
  value: unknown,
  values: Set<string>,
  seenOrdinary: Set<object>,
  seenSensitive: Set<object>,
  sensitiveContext = false
): void {
  if (typeof value === "string") {
    if (sensitiveContext && value.length > 0) values.add(value);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const seen = sensitiveContext ? seenSensitive : seenOrdinary;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectOwnerTokenValues(entry, values, seenOrdinary, seenSensitive, sensitiveContext);
    }
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    collectOwnerTokenValues(
      entry,
      values,
      seenOrdinary,
      seenSensitive,
      sensitiveContext || /token/i.test(key)
    );
  }
}

function redactOwnerTokens(message: string, params: Record<string, unknown>): string {
  const values = new Set<string>();
  collectOwnerTokenValues(params, values, new Set<object>(), new Set<object>());
  let redacted = message;
  for (const value of [...values].sort((left, right) => right.length - left.length)) {
    redacted = redacted.replaceAll(value, "[redacted]");
  }
  return redacted;
}

/**
 * A fresh-connection Workbench NET API transport.
 *
 * This class owns only socket/framing behavior. Lifecycle retries, auto-launch,
 * readiness qualification, and connection-state caching belong to its callers.
 */
export class WorkbenchNetApiClient implements WorkbenchNetApiPort {
  private readonly clientId: string;
  private readonly defaultTimeoutMs: number;
  private readonly responseCapBytes: number;
  private readonly socketFactory: () => Socket;

  constructor(
    private readonly host: string,
    private readonly port: number,
    options: WorkbenchNetApiClientOptions = {},
    dependencies: WorkbenchNetApiClientDependencies = {}
  ) {
    requireNonEmpty(host, "Workbench NET API host");
    requirePort(port);
    this.clientId = requireNonEmpty(
      options.clientId ?? DEFAULT_WORKBENCH_NET_API_CLIENT_ID,
      "Workbench NET API client ID"
    );
    this.defaultTimeoutMs = requirePositiveInteger(
      options.defaultTimeoutMs ?? DEFAULT_WORKBENCH_NET_API_TIMEOUT_MS,
      "Workbench NET API default timeout"
    );
    this.responseCapBytes = requirePositiveInteger(
      options.responseCapBytes ?? DEFAULT_WORKBENCH_NET_API_RESPONSE_CAP_BYTES,
      "Workbench NET API response cap"
    );
    this.socketFactory = dependencies.socketFactory ?? (() => new Socket());
  }

  async call<T = Record<string, unknown>>(
    apiFunc: string,
    params: Record<string, unknown> = {},
    options: WorkbenchNetApiCallOptions = {}
  ): Promise<T> {
    requireNonEmpty(apiFunc, "Workbench NET API function");
    const timeoutMs = requirePositiveInteger(
      options.timeoutMs ?? this.defaultTimeoutMs,
      "Workbench NET API call timeout"
    );
    const responseCapBytes = requirePositiveInteger(
      options.responseCapBytes ?? this.responseCapBytes,
      "Workbench NET API response cap"
    );

    let request: Buffer;
    try {
      request = encodeRequest(this.clientId, apiFunc, params);
    } catch (error) {
      throw new WorkbenchNetApiError(
        `Could not encode Workbench request for "${apiFunc}".`,
        "protocol",
        { cause: error }
      );
    }

    return new Promise<T>((resolvePromise, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;
      const socket = this.socketFactory();
      let timer: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        socket.removeAllListeners();
      };

      const settle = (completion: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        completion();
      };

      const rejectAndDestroy = (error: WorkbenchNetApiError): void => {
        settle(() => {
          socket.destroy();
          reject(error);
        });
      };

      const decodeAndSettle = (): void => {
        settle(() => {
          try {
            resolvePromise(this.decodeResponse<T>(apiFunc, params, chunks, totalBytes));
          } catch (error) {
            reject(error);
          }
        });
      };

      timer = setTimeout(() => {
        rejectAndDestroy(new WorkbenchNetApiError(
          `Workbench call "${apiFunc}" timed out after ${timeoutMs}ms.`,
          "timeout"
        ));
      }, timeoutMs);

      socket.on("error", (error: NodeJS.ErrnoException) => {
        const connectionRefused = error.code === "ECONNREFUSED";
        rejectAndDestroy(new WorkbenchNetApiError(
          connectionRefused
            ? `Cannot connect to Workbench at ${this.host}:${this.port}.`
            : `Workbench connection to ${this.host}:${this.port} failed.`,
          connectionRefused ? "connection_refused" : "protocol",
          { cause: error }
        ));
      });
      socket.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > responseCapBytes) {
          rejectAndDestroy(new WorkbenchNetApiError(
            `Response for "${apiFunc}" exceeded ${responseCapBytes} bytes.`,
            "protocol"
          ));
          return;
        }
        chunks.push(chunk);
      });
      socket.once("end", decodeAndSettle);
      socket.once("close", decodeAndSettle);

      try {
        socket.connect(this.port, this.host, () => {
          if (!settled) socket.end(request);
        });
      } catch (error) {
        rejectAndDestroy(new WorkbenchNetApiError(
          `Workbench connection to ${this.host}:${this.port} could not be opened.`,
          "protocol",
          { cause: error }
        ));
      }
    });
  }

  private decodeResponse<T>(
    apiFunc: string,
    params: Record<string, unknown>,
    chunks: readonly Buffer[],
    totalBytes: number
  ): T {
    if (totalBytes === 0) {
      throw new WorkbenchNetApiError(
        `Empty response from Workbench for "${apiFunc}".`,
        "protocol"
      );
    }

    const response = Buffer.concat(chunks, totalBytes);
    let status: { value: string; bytesRead: number };
    try {
      status = decodePascalString(response, 0);
    } catch {
      throw new WorkbenchNetApiError(
        `Malformed status in Workbench response for "${apiFunc}".`,
        "protocol"
      );
    }

    if (status.value.length === 0) {
      throw new WorkbenchNetApiError(
        `Empty status in Workbench response for "${apiFunc}".`,
        "protocol"
      );
    }
    if (status.value !== "Ok") {
      const message = redactOwnerTokens(`Workbench error: ${status.value}`, params);
      throw new WorkbenchNetApiError(message, "api_error");
    }
    if (response.length === status.bytesRead) {
      throw new WorkbenchNetApiError(
        `Workbench returned Ok without a payload for "${apiFunc}".`,
        "protocol"
      );
    }

    let payload: { value: string; bytesRead: number };
    try {
      payload = decodePascalString(response, status.bytesRead);
    } catch {
      throw new WorkbenchNetApiError(
        `Malformed payload in Workbench response for "${apiFunc}".`,
        "protocol"
      );
    }
    if (payload.value.length === 0) {
      throw new WorkbenchNetApiError(
        `Workbench returned an empty payload for "${apiFunc}".`,
        "protocol"
      );
    }
    if (status.bytesRead + payload.bytesRead !== response.length) {
      throw new WorkbenchNetApiError(
        `Workbench returned trailing bytes after the payload for "${apiFunc}".`,
        "protocol"
      );
    }

    try {
      return JSON.parse(payload.value) as T;
    } catch {
      throw new WorkbenchNetApiError(
        `Workbench returned malformed JSON for "${apiFunc}".`,
        "protocol"
      );
    }
  }
}
