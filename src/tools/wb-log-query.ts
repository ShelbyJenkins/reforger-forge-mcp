import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeSync,
  createReadStream,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  type Stats,
} from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import {
  parseLogLine,
  referencesAddon,
  type EnfusionLogLevel,
} from "../formats/enfusion-log.js";
import {
  canonicalizeExistingDirectory,
  pathComparisonKey,
  resolveManagedPath,
} from "../foundation/managed-path.js";
import { redactText } from "../foundation/redact.js";
import { defaultWorkbenchHelperManagedRoot } from "../workbench/helper-addon.js";

const DEFAULT_MAX_LINES = 500;
const MAX_FILTER_VALUE_LENGTH = 256;
const MAX_RETURNED_LINE_LENGTH = 4_096;
const LOG_LAYOUTS = [
  ["workbench-helper", "profile", "logs"],
  ["workbench-build", "profile", "logs"],
] as const;

export interface WbLogQueryMatch {
  readonly sourceFile: string;
  readonly lineNumber: number;
  readonly channel: string | null;
  readonly level: EnfusionLogLevel | null;
  readonly matchedAddonIds: readonly string[];
  readonly text: string;
}

export interface WbLogQueryResult {
  readonly matches: readonly WbLogQueryMatch[];
  /** Number of regular .log files considered in the requested directory. */
  readonly fileCount: number;
  /** Number of matches returned; this is bounded by maxLines. */
  readonly matchCount: number;
  /** True when at least one additional matching line was omitted. */
  readonly truncated: boolean;
}

class WbLogQueryError extends Error {
  readonly code = "INVALID_CONFIG";

  constructor(message: string) {
    super(message);
    this.name = "WbLogQueryError";
  }
}

interface LogFile {
  readonly name: string;
  readonly path: string;
}

interface QueryFilters {
  readonly addonIds: readonly string[] | undefined;
  readonly levels: ReadonlySet<EnfusionLogLevel> | undefined;
  readonly channels: ReadonlySet<string> | undefined;
  readonly pattern: string | undefined;
}

function managedRoot(config: Config): string {
  return resolve(config.observer?.managedRoot ?? defaultWorkbenchHelperManagedRoot());
}

function errorMessage(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error), {
    profile: "diagnostic",
    replacement: "[redacted]",
  });
}

function errorResult(error: unknown) {
  const coded = error && typeof error === "object"
    ? error as { code?: unknown }
    : undefined;
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        ok: false,
        code: typeof coded?.code === "string" ? coded.code : "INVALID_CONFIG",
        message: errorMessage(error),
      }, null, 2),
    }],
    isError: true,
  };
}

function assertRegularDirectory(path: string, label: string): string {
  let entry: Stats;
  try {
    entry = lstatSync(path);
  } catch {
    throw new WbLogQueryError(`${label} does not exist or cannot be accessed.`);
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new WbLogQueryError(`${label} must be a non-reparse directory.`);
  }
  try {
    return canonicalizeExistingDirectory(path, label);
  } catch {
    throw new WbLogQueryError(`${label} does not exist or cannot be accessed.`);
  }
}

/**
 * Return only the two Workbench log roots this server creates. Each path is
 * resolved from the managed root under a no-links policy so a junction in the
 * helper/build profile cannot turn this tool into an arbitrary file reader.
 */
function availableLogRoots(config: Config): readonly string[] {
  const root = assertRegularDirectory(managedRoot(config), "Workbench managed root");
  const roots: string[] = [];

  for (const layout of LOG_LAYOUTS) {
    const expected = join(root, ...layout);
    if (!existsSync(expected)) continue;

    let safePath: string;
    try {
      safePath = resolveManagedPath(root, expected, "no-links");
    } catch {
      throw new WbLogQueryError("Workbench managed log root traverses a reparse point.");
    }
    const canonical = assertRegularDirectory(safePath, "Workbench managed log root");
    if (pathComparisonKey(canonical) !== pathComparisonKey(safePath)) {
      throw new WbLogQueryError("Workbench managed log root has an unexpected canonical path.");
    }
    roots.push(canonical);
  }

  return roots;
}

/**
 * A receipt identifies one direct child created by the runner, never an
 * arbitrary descendant of the managed profile's logs directory.
 */
function resolveAttributedLogDirectory(config: Config, requestedPath: string): string {
  const requested = resolve(requestedPath);
  for (const root of availableLogRoots(config)) {
    if (pathComparisonKey(dirname(requested)) !== pathComparisonKey(root)) continue;

    let safePath: string;
    try {
      safePath = resolveManagedPath(root, requested, "no-links");
    } catch {
      throw new WbLogQueryError("logDirectory traverses a reparse point.");
    }
    const canonical = assertRegularDirectory(safePath, "logDirectory");
    if (pathComparisonKey(dirname(canonical)) !== pathComparisonKey(root)) {
      throw new WbLogQueryError("logDirectory must be a direct child of a managed Workbench log root.");
    }
    return canonical;
  }

  throw new WbLogQueryError(
    "logDirectory must be an attributed direct child of a managed Workbench log root."
  );
}

function listLogFiles(logDirectory: string): readonly LogFile[] {
  try {
    return readdirSync(logDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.toLowerCase().endsWith(".log"))
      .map((entry) => ({ name: entry.name, path: join(logDirectory, entry.name) }))
      .filter((file) => {
        try {
          const entry = lstatSync(file.path);
          return entry.isFile() && !entry.isSymbolicLink();
        } catch {
          return false;
        }
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    throw new WbLogQueryError("logDirectory cannot be enumerated.");
  }
}

function openVerifiedLogFile(path: string): number {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new WbLogQueryError("A selected .log file is not a regular file.");
  }

  const descriptor = openSync(path, "r");
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new WbLogQueryError("A selected .log file changed while it was being opened.");
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

async function* readLogLines(path: string): AsyncGenerator<{ readonly line: string; readonly lineNumber: number }> {
  const descriptor = openVerifiedLogFile(path);
  let stream: ReturnType<typeof createReadStream>;
  try {
    stream = createReadStream(path, { fd: descriptor, autoClose: true, encoding: "utf8" });
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of reader) {
      lineNumber += 1;
      yield { line, lineNumber };
    }
  } finally {
    reader.close();
    stream.destroy();
  }
}

function uniqueStrings(values: readonly string[] | undefined): readonly string[] | undefined {
  if (!values || values.length === 0) return undefined;
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function createFilters(input: {
  readonly addonIds?: readonly string[];
  readonly levels?: readonly EnfusionLogLevel[];
  readonly channels?: readonly string[];
  readonly pattern?: string;
}): QueryFilters {
  const addonIds = uniqueStrings(input.addonIds);
  const levels = input.levels && input.levels.length > 0
    ? new Set(input.levels)
    : undefined;
  const channels = input.channels && input.channels.length > 0
    ? new Set(input.channels.map((channel) => channel.toLowerCase()))
    : undefined;
  const patternText = input.pattern?.trim();
  if (!addonIds && !levels && !channels && !patternText) {
    throw new WbLogQueryError(
      "At least one of addonIds, levels, channels, or pattern must be supplied."
    );
  }

  const pattern = patternText?.toLowerCase();
  return { addonIds, levels, channels, pattern };
}

function matchedAddonIds(line: string, addonIds: readonly string[] | undefined): readonly string[] | null {
  if (!addonIds) return [];
  const matches = addonIds.filter((addonId) => referencesAddon(line, addonId));
  return matches.length > 0 ? matches : null;
}

function matchLine(line: string, filters: QueryFilters): {
  readonly parsed: ReturnType<typeof parseLogLine>;
  readonly addonIds: readonly string[];
} | null {
  const parsed = parseLogLine(line);
  const addonIds = matchedAddonIds(line, filters.addonIds);
  if (addonIds === null) return null;
  if (filters.levels && (!parsed || !filters.levels.has(parsed.level))) return null;
  if (filters.channels && (!parsed || !filters.channels.has(parsed.channel.toLowerCase()))) return null;
  if (filters.pattern && !line.toLowerCase().includes(filters.pattern)) return null;
  return { parsed, addonIds };
}

export function registerWbLogQuery(server: McpServer, config: Config): void {
  server.registerTool(
    "wb_log_query",
    {
      description:
        "Filter attributed Workbench build/editor log files by addon reference, normalized severity level, " +
        "channel, and/or a case-insensitive text substring, returning only matching lines instead of " +
        "the full raw log. Timestamped and alignment-padded editor records are recognized.",
      inputSchema: {
        logDirectory: z.string().trim().min(1).describe(
          "An exact managed Workbench log directory, such as one returned by a prior wb_build receipt."
        ),
        addonIds: z.array(z.string().trim().min(1).max(MAX_FILTER_VALUE_LENGTH)).max(16).optional().describe(
          "Return only lines that reference at least one add-on ID by name, $<AddonId>: resource prefix, or addons/<AddonId>/ path."
        ),
        levels: z.array(z.enum(["I", "W", "E"])).max(3).optional().describe(
          "Return records whose normalized Workbench severity is informational (I), warning (W), or error (E)."
        ),
        channels: z.array(z.string().trim().min(1).max(MAX_FILTER_VALUE_LENGTH)).max(16).optional(),
        pattern: z.string().trim().min(1).max(512).optional().describe(
          "Case-insensitive literal substring applied to each line's raw text."
        ),
        maxLines: z.number().int().min(1).max(2_000).default(DEFAULT_MAX_LINES),
      },
    },
    async ({ logDirectory, addonIds, levels, channels, pattern, maxLines = DEFAULT_MAX_LINES }) => {
      try {
        const filters = createFilters({ addonIds, levels, channels, pattern });
        const directory = resolveAttributedLogDirectory(config, logDirectory);
        const files = listLogFiles(directory);
        const matches: WbLogQueryMatch[] = [];
        let truncated = false;

        fileLoop:
        for (const file of files) {
          for await (const { line, lineNumber } of readLogLines(file.path)) {
            const matched = matchLine(line, filters);
            if (!matched) continue;
            if (matches.length >= maxLines) {
              truncated = true;
              break fileLoop;
            }
            matches.push({
              sourceFile: file.name,
              lineNumber,
              channel: matched.parsed?.channel ?? null,
              level: matched.parsed?.level ?? null,
              matchedAddonIds: matched.addonIds,
              text: redactText(line, {
                profile: "diagnostic",
                replacement: "[redacted]",
                maxLength: MAX_RETURNED_LINE_LENGTH,
              }),
            });
          }
        }

        const result: WbLogQueryResult = {
          matches,
          fileCount: files.length,
          matchCount: matches.length,
          truncated,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
