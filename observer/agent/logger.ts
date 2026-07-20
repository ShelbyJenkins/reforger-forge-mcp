import { redactDiagnostic, redactText } from "#foundation/redact";

function write(level: string, message: string, fields?: Record<string, unknown>): void {
  const suffix = fields && Object.keys(fields).length > 0
    ? ` ${JSON.stringify(redactDiagnostic(fields, { profile: "diagnostic" }))}`
    : "";
  process.stderr.write(`[reforger-forge-observer]${level ? ` ${level}` : ""}: ${redactText(message, { profile: "diagnostic" })}${suffix}\n`);
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
  return redactDiagnostic(value, { profile: "diagnostic" }) as T;
}
