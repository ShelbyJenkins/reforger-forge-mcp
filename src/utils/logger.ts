/**
 * Logger that writes exclusively to stderr — safe for stdio MCP transport.
 * console.log is FORBIDDEN in stdio servers as it corrupts JSON-RPC messages.
 */
export const logger = {
  info: (msg: string, ...args: unknown[]) =>
    console.error(`[reforger-forge] ${msg}`, ...args),
  warn: (msg: string, ...args: unknown[]) =>
    console.error(`[reforger-forge] WARN: ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) =>
    console.error(`[reforger-forge] ERROR: ${msg}`, ...args),
  debug: (msg: string, ...args: unknown[]) => {
    if (process.env.REFORGER_FORGE_DEBUG || process.env.ENFUSION_MCP_DEBUG)
      console.error(`[reforger-forge] DEBUG: ${msg}`, ...args);
  },
};
