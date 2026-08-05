/** Severity markers emitted by single-line Enfusion Workbench logs. */
export type EnfusionLogLevel = "I" | "W" | "E";

/** A parsed Enfusion log line, retaining its original text for presentation. */
export interface ParsedLogLine {
  readonly channel: string;
  readonly level: EnfusionLogLevel;
  readonly message: string;
  /** The complete original line, unmodified. */
  readonly raw: string;
}

const LOG_LINE_PATTERN = /^(?:(?:\d{2}:){2}\d{2}\.\d{3}\s+)?\s*(\S+?)\s*\(([IWE])\):\s?(.*)$/;

/**
 * Parse the Workbench log-line shapes emitted by build and editor logs:
 * `[HH:mm:ss.SSS] [alignment] <CHANNEL>[alignment](<LEVEL>): <message>`.
 *
 * Banner and noise lines that do not carry a channel/level marker are
 * intentionally returned as `null`.
 */
export function parseLogLine(line: string): ParsedLogLine | null {
  const match = LOG_LINE_PATTERN.exec(line);
  if (!match) return null;

  return {
    channel: match[1],
    level: match[2] as EnfusionLogLevel,
    message: match[3],
    raw: line,
  };
}

/**
 * Whether a line references an add-on by its literal ID, `$<AddonId>:`
 * resource prefix, or an `addons/<AddonId>/` path segment.
 */
export function referencesAddon(line: string, addonId: string): boolean {
  const escaped = addonId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `\\b${escaped}\\b|\\$${escaped}:|(?:^|[\\\\/])addons[\\\\/]${escaped}(?:[\\\\/]|$)`,
    "i"
  );
  return pattern.test(line);
}
