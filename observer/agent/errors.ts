import { PROTOCOL_VERSION, publicErrorMessage, type ObserverErrorCode } from "../protocol/index.js";

export class ObserverError extends Error {
  constructor(
    public readonly code: ObserverErrorCode,
    message: string,
    public readonly httpStatus = 400
  ) {
    super(message);
    this.name = "ObserverError";
  }
}

export function asObserverError(error: unknown): ObserverError {
  if (error instanceof ObserverError) return error;
  return new ObserverError("INTERNAL_ERROR", "Observer operation failed", 500);
}

export function errorBody(error: unknown): {
  protocolVersion: typeof PROTOCOL_VERSION;
  error: { code: ObserverErrorCode; message: string };
} {
  const observerError = asObserverError(error);
  return {
    protocolVersion: PROTOCOL_VERSION,
    error: { code: observerError.code, message: publicErrorMessage(observerError.code, observerError.message) },
  };
}
