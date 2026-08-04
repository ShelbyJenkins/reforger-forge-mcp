import {
  lstatSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  canonicalizeExistingDirectory,
  isPathContained,
} from "../foundation/managed-path.js";
import { WORKBENCH_OWNER_ARG_PREFIX } from "./process-guard.js";

const LOG_CLOCK_SKEW_MS = 5_000;
const MAX_CANDIDATE_DIRECTORIES = 64;
const MAX_OWNER_SCAN_BYTES = 512 * 1024;
const MAX_SCRIPT_LOG_BYTES = 8 * 1024 * 1024;
const MAX_DIAGNOSTICS = 5;
const MAX_DIAGNOSTIC_CHARACTERS = 2_000;

const COMPILE_FAILURE_PATTERN = /Can't compile "([^"]+)" script module!?/;
const TIMESTAMPED_LOG_LINE = /^\d{2}:\d{2}:\d{2}(?:\.\d+)?\s/;

export interface WorkbenchCompileFailure {
  readonly code: "PROJECT_COMPILE_FAILED";
  readonly module: string;
  readonly diagnostics: readonly string[];
  readonly logPath: string;
}

export interface WorkbenchCompileFailureSearch {
  readonly profilePath: string;
  readonly launchedAtMs: number;
  readonly ownerArgument: string;
}

function boundedFilePrefix(path: string, maxBytes: number): string {
  const size = statSync(path).size;
  if (size <= maxBytes) return readFileSync(path, "utf8");
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytesRead = readSync(descriptor, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function boundedFileTail(path: string, maxBytes: number): string {
  const size = statSync(path).size;
  if (size <= maxBytes) return readFileSync(path, "utf8");
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytesRead = readSync(descriptor, buffer, 0, maxBytes, size - maxBytes);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function directRegularLogFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) =>
      entry.isFile() && !entry.isSymbolicLink() && entry.name.toLowerCase().endsWith(".log")
    )
    .map((entry) => join(directory, entry.name));
}

function ownerNeedles(ownerArgument: string): readonly string[] {
  if (!ownerArgument.startsWith(WORKBENCH_OWNER_ARG_PREFIX)) return [];
  const token = ownerArgument.slice(WORKBENCH_OWNER_ARG_PREFIX.length);
  if (token.length === 0) return [];
  return [ownerArgument, `${WORKBENCH_OWNER_ARG_PREFIX.slice(0, -1)} ${token}`];
}

function containsExactOwner(directory: string, needles: readonly string[]): boolean {
  for (const path of directRegularLogFiles(directory)) {
    const text = boundedFilePrefix(path, MAX_OWNER_SCAN_BYTES);
    if (needles.some((needle) => text.includes(needle))) return true;
  }
  return false;
}

function normalizeScriptError(line: string): string {
  const marker = line.match(/\bSCRIPT\s+\(E\):\s*(.*)$/);
  return (marker?.[1] ?? line).trim();
}

/** Parse the compiler's concise summary without confusing earlier dependency noise for the cause. */
export function parseWorkbenchCompileFailure(
  scriptLog: string,
  logPath: string
): WorkbenchCompileFailure | null {
  const lines = scriptLog.split(/\r?\n/);
  const markerIndex = lines.findIndex((line) => COMPILE_FAILURE_PATTERN.test(line));
  if (markerIndex < 0) return null;
  const marker = lines[markerIndex].match(COMPILE_FAILURE_PATTERN);
  if (!marker) return null;

  const diagnostics: string[] = [];
  for (let index = markerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.length === 0 && diagnostics.length === 0) continue;
    if (line.length === 0 || TIMESTAMPED_LOG_LINE.test(line)) break;
    diagnostics.push(line.slice(0, MAX_DIAGNOSTIC_CHARACTERS));
    if (diagnostics.length >= MAX_DIAGNOSTICS) break;
  }

  // Older Workbench builds do not always emit the plain summary after the
  // module marker. In that shape, retain a small nearest-first compiler-error
  // fallback rather than reporting the downstream missing helper API alone.
  if (diagnostics.length === 0) {
    for (let index = markerIndex - 1; index >= 0 && markerIndex - index <= 25; index -= 1) {
      const line = lines[index];
      if (!/\bSCRIPT\s+\(E\):/.test(line)) continue;
      diagnostics.unshift(normalizeScriptError(line).slice(0, MAX_DIAGNOSTIC_CHARACTERS));
      if (diagnostics.length >= MAX_DIAGNOSTICS) break;
    }
  }

  return Object.freeze({
    code: "PROJECT_COMPILE_FAILED",
    module: marker[1],
    diagnostics: Object.freeze(diagnostics),
    logPath,
  });
}

/**
 * Find only the log directory carrying this launch's private owner token, then
 * inspect its script log for a module compilation failure. Any ambiguity or
 * filesystem inconsistency is treated as no diagnosis, never as attribution.
 */
export function findWorkbenchCompileFailure(
  search: WorkbenchCompileFailureSearch
): WorkbenchCompileFailure | null {
  try {
    if (!Number.isFinite(search.launchedAtMs) || search.launchedAtMs <= 0) return null;
    const needles = ownerNeedles(search.ownerArgument);
    if (needles.length === 0) return null;
    const profile = canonicalizeExistingDirectory(search.profilePath, "Workbench helper profile");
    const logRoot = canonicalizeExistingDirectory(join(profile, "logs"), "Workbench helper log root");
    if (!isPathContained(profile, logRoot)) return null;

    const candidates = readdirSync(logRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => {
        const lexicalPath = join(logRoot, entry.name);
        const modifiedAtMs = statSync(lexicalPath).mtimeMs;
        return { lexicalPath, modifiedAtMs };
      })
      .filter((entry) => entry.modifiedAtMs >= search.launchedAtMs - LOG_CLOCK_SKEW_MS)
      .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)
      .slice(0, MAX_CANDIDATE_DIRECTORIES);

    const owned: string[] = [];
    for (const candidate of candidates) {
      const entry = lstatSync(candidate.lexicalPath);
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const canonical = realpathSync.native(candidate.lexicalPath);
      if (!isPathContained(logRoot, canonical)) continue;
      if (containsExactOwner(canonical, needles)) owned.push(canonical);
    }
    if (owned.length !== 1) return null;

    const scriptEntry = readdirSync(owned[0], { withFileTypes: true }).find((entry) =>
      entry.isFile() && !entry.isSymbolicLink() && entry.name.toLowerCase() === "script.log"
    );
    if (!scriptEntry) return null;
    const scriptPath = realpathSync.native(join(owned[0], scriptEntry.name));
    if (!isPathContained(owned[0], scriptPath)) return null;
    return parseWorkbenchCompileFailure(
      boundedFileTail(scriptPath, MAX_SCRIPT_LOG_BYTES),
      scriptPath
    );
  } catch {
    // Readiness diagnosis must never replace the authoritative lifecycle error
    // with a best-effort local log-inspection failure.
    return null;
  }
}

/** Parse compiler evidence only from an already uniquely owner-attributed log directory. */
export function readWorkbenchCompileFailureFromLogDirectory(
  logDirectory: string
): WorkbenchCompileFailure | null {
  try {
    const directory = canonicalizeExistingDirectory(
      logDirectory,
      "attributed Workbench log directory"
    );
    const scriptEntries = readdirSync(directory, { withFileTypes: true }).filter((entry) =>
      entry.isFile() && !entry.isSymbolicLink() && entry.name.toLowerCase() === "script.log"
    );
    if (scriptEntries.length !== 1) return null;
    const scriptPath = realpathSync.native(join(directory, scriptEntries[0].name));
    if (!isPathContained(directory, scriptPath)) return null;
    return parseWorkbenchCompileFailure(
      boundedFileTail(scriptPath, MAX_SCRIPT_LOG_BYTES),
      scriptPath
    );
  } catch {
    return null;
  }
}

export function formatWorkbenchCompileFailure(failure: WorkbenchCompileFailure): string {
  const detail = failure.diagnostics.length > 0
    ? ` First compiler diagnostic: ${failure.diagnostics[0]}`
    : "";
  return `Workbench could not compile the \"${failure.module}\" project script module.${detail} ` +
    `Exact Workbench script log: ${failure.logPath}`;
}
