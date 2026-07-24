/**
 * Logger that writes exclusively to stderr — safe for stdio MCP transport.
 * console.log is FORBIDDEN in stdio servers as it corrupts JSON-RPC messages.
 */
let debugEnabled = false;

export function setDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled;
}

export const logger = {
  info: (msg: string, ...args: unknown[]) =>
    console.error(`[reforger-forge] ${msg}`, ...args),
  warn: (msg: string, ...args: unknown[]) =>
    console.error(`[reforger-forge] WARN: ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) =>
    console.error(`[reforger-forge] ERROR: ${msg}`, ...args),
  debug: (msg: string, ...args: unknown[]) => {
    if (debugEnabled)
      console.error(`[reforger-forge] DEBUG: ${msg}`, ...args);
  },
};
