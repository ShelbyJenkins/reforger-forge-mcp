import { z } from "zod";
import { ERROR_CODES, MAX_PROTOCOL_MESSAGE_BYTES, type ObserverErrorCode } from "../protocol/index.js";
import { ObserverError } from "./errors.js";

const descriptorSchema = z.object({
  host: z.enum(["127.0.0.1", "::1"]),
  port: z.number().int().min(1).max(65_535),
  controlHttpEnabled: z.literal(true),
  controlToken: z.string().min(32).max(512),
});

export type ObserverControlDescriptor = z.infer<typeof descriptorSchema>;

export function parseControlDescriptor(value: unknown): ObserverControlDescriptor {
  const parsed = descriptorSchema.safeParse(value);
  if (!parsed.success) {
    throw new ObserverError(
      "INVALID_REQUEST",
      "A live observer-agent descriptor with authenticated control HTTP is required"
    );
  }
  return parsed.data;
}

export async function requestObserverControl<T>(
  descriptorInput: unknown,
  path: `/v1/control/${string}`,
  options: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {}
): Promise<T> {
  const descriptor = parseControlDescriptor(descriptorInput);
  const host = descriptor.host === "::1" ? "[::1]" : descriptor.host;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  timer.unref();
  try {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body && Buffer.byteLength(body) > MAX_PROTOCOL_MESSAGE_BYTES) {
      throw new ObserverError("INVALID_REQUEST", "Observer control request exceeds the protocol body limit", 413);
    }
    const response = await fetch(`http://${host}:${descriptor.port}${path}`, {
      method: options.method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        authorization: `Bearer ${descriptor.controlToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body,
      signal: controller.signal,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_PROTOCOL_MESSAGE_BYTES) {
      throw new ObserverError("TRANSPORT_UNAVAILABLE", "Observer control response exceeds the protocol body limit", 502);
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new ObserverError("TRANSPORT_UNAVAILABLE", "Observer control response is not valid JSON", 502);
    }
    if (!response.ok) {
      const error = value && typeof value === "object" && "error" in value
        ? (value as { error?: { code?: unknown; message?: unknown } }).error
        : undefined;
      const code = typeof error?.code === "string" && (ERROR_CODES as readonly string[]).includes(error.code)
        ? error.code as ObserverErrorCode
        : "TRANSPORT_UNAVAILABLE";
      const message = typeof error?.message === "string" ? error.message : `Observer control request failed with HTTP ${response.status}`;
      throw new ObserverError(code, message, response.status);
    }
    return value as T;
  } catch (error) {
    if (error instanceof ObserverError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ObserverError("TRANSPORT_UNAVAILABLE", "Observer control request timed out", 504);
    }
    throw new ObserverError(
      "TRANSPORT_UNAVAILABLE",
      `Could not reach the live observer agent: ${error instanceof Error ? error.message : String(error)}`,
      503
    );
  } finally {
    clearTimeout(timer);
  }
}
