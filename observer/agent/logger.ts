const SECRET_KEY = /token|authorization|credential|secret|nonce/i;
const CONTRACT_BODY_KEY = /^[a-z0-9]*contract(?:body|payload)?$/i;
const BEARER = /Bearer\s+[A-Za-z0-9._~-]+/gi;

function redactValue(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key) || CONTRACT_BODY_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return value.replace(BEARER, "Bearer [REDACTED]");
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactValue(item, name)]));
  }
  return value;
}

function write(level: string, message: string, fields?: Record<string, unknown>): void {
  const suffix = fields && Object.keys(fields).length > 0
    ? ` ${JSON.stringify(redactValue(fields))}`
    : "";
  process.stderr.write(`[reforger-forge-observer]${level ? ` ${level}` : ""}: ${message}${suffix}\n`);
}

export const observerLogger = {
  info: (message: string, fields?: Record<string, unknown>) => write("", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write("WARN", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write("ERROR", message, fields),
  debug: (message: string, fields?: Record<string, unknown>) => {
    if (process.env.REFORGER_FORGE_OBSERVER_DEBUG) write("DEBUG", message, fields);
  },
};

export function redactForDiagnostics<T>(value: T): T {
  return redactValue(value) as T;
}
