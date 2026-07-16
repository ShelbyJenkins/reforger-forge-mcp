#!/usr/bin/env node
import {
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  extname,
  join,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

export const LIVE_RUN_ENVIRONMENT = "RFO_RUN_AI_STRESS_OBSERVER_ACCEPTANCE";
export const AI_STRESS_TEST_CASE = "RR_TEST_AIStress_MaxPlayers_CompletesRedOrBlueWin";
export const ACTIVE_ENTRY_MARKER = "RR AIStressAutotest: all 48 bots completed ACTIVE entry simultaneously";
export const LIVE_RUNNER_PATTERN = /RoadblockRunners Observer: focus actorId=-[1-9][0-9]* source=runner position=/;
export const OBSERVER_ADDON_GUID = "7F3A91C2E40B6D58";
export const LOADED_ADDON_IDS = [
  "02412E2D8D82234A",
  "5614E481506D2979",
  "64C912EF952E1075",
  "64B73652C12170E6",
  "6988FB4E68CB9E51",
  "6952EA6D8FE33A93",
  "69543D1775299C32",
  "61B84088181A8FA4",
  "62B4A8E40D31F94B",
  "698B2BDEB6268D21",
  "69AF6B47AD1FF6F0",
  "5CA8F34E77DD532C",
  "5E389BB9F58B79A6",
  "629B2BA37EFFD577",
  "5ABD0CB57F7E9EB1",
  "5AB301290317994A",
] as const;

export const BLOCKING_PROCESS_NAMES = new Set([
  "armareforger",
  "armareforgerdiag",
  "armareforgersteam",
  "armareforgersteamdiag",
  "armareforgerserver",
  "armareforgerserverdiag",
  "armareforgerserversteam",
  "armareforgerserversteamdiag",
  "armareforgerworkbench",
  "armareforgerworkbenchdiag",
  "armareforgerworkbenchsteam",
  "armareforgerworkbenchsteamdiag",
]);

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_BYTES = 64 * 1024 * 1024;
const MAX_PNG_PIXELS = 32_000_000;
const TERMINAL_JOB_STATES = new Set(["completed", "failed", "cancelled"]);
const SHARED_LAUNCH_LOCK = join(tmpdir(), "reforger-forge-mcp-workbench.launch.lock");
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const ROADBLOCK_ROOT = resolve(REPOSITORY_ROOT, "..", "addons", "RoadblockRunners");

interface ProcessRow {
  Id?: unknown;
  ProcessName?: unknown;
}

interface BlockingProcess {
  id: number;
  processName: string;
}

interface MarkerMatch {
  sourcePath: string;
  line: string;
  observedAt: string;
}

export interface RuntimeMarkerEvidence {
  activeEntry: MarkerMatch | null;
  liveRunner: MarkerMatch | null;
}

export interface PngMaterialEvidence {
  width: number;
  height: number;
  channels: 3 | 4;
  byteCount: number;
  sha256: string;
  sampledPixels: number;
  quantizedColorCount: number;
  nonBlackRatio: number;
  luminanceMinimum: number;
  luminanceMaximum: number;
  luminanceStandardDeviation: number;
  materiallyVaried: boolean;
}

interface ObserverCaptureResult {
  asynchronous: boolean;
  job: Record<string, unknown>;
  image?: Buffer;
  metadata?: Record<string, unknown>;
}

interface ObserverCoordinatorLike {
  ensureStarted(): Promise<Record<string, unknown>>;
  ensureSetup(): Promise<Record<string, unknown>>;
  prepareLaunch(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  instances(input: Record<string, unknown>): Promise<{
    instances: Array<Record<string, unknown>>;
    compatibleCount: number;
    waitedMs: number;
    timedOut: boolean;
  }>;
  capture(input: Record<string, unknown>): Promise<ObserverCaptureResult>;
  jobStatus(sessionId: string, jobId: string): Promise<Record<string, unknown>>;
  cancelJob(sessionId: string, jobId: string): Promise<Record<string, unknown>>;
  revokeSession(sessionId: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

interface ObserverCoordinatorConstructor {
  new (options: Record<string, unknown>): ObserverCoordinatorLike;
}

export interface AcceptanceOptions {
  confirmed: boolean;
  gameExecutable: string;
  baseGameAddons: string;
  workshopAddons: string[];
  artifactRoot: string;
  timeoutSeconds: number;
  captureTimeoutSeconds: number;
  visible: boolean;
  environment?: NodeJS.ProcessEnv;
}

interface LaunchLock {
  descriptor: number;
  path: string;
  token: string;
}

interface RetainedCapture {
  label: string;
  imagePath: string;
  metadataPath: string;
  jobPath: string;
  job: Record<string, unknown>;
  metadata: Record<string, unknown>;
  png: PngMaterialEvidence;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is not an object`);
  return value;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return result;
}

function redactEvidenceText(value: string): string {
  return value
    .replace(/((?:session|control)?token|authorization|credential|secret|(?:launch|instance)nonce)(["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',}\]]+/gi, "$1$2[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]");
}

export function redactEvidenceForRetention(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactEvidenceText(value);
  if (value === null || typeof value !== "object") return value;
  if (Buffer.isBuffer(value)) return `[binary ${value.length} bytes]`;
  if (depth >= 16 || seen.has(value)) return "[REDACTED_RECURSION]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 1_024).map((entry) => redactEvidenceForRetention(entry, depth + 1, seen));
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 1_024)) {
    result[key] = /(token|authorization|credential|secret|nonce)/i.test(key)
      ? "[REDACTED]"
      : redactEvidenceForRetention(entry, depth + 1, seen);
  }
  return result;
}

function atomicWriteJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(redactEvidenceForRetention(value), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function canonicalFile(path: string, label: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`${label} is missing: ${absolute}`);
  const entry = lstatSync(absolute);
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`${label} must be a regular non-symlink file: ${absolute}`);
  return realpathSync.native(absolute);
}

function canonicalDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`${label} is missing: ${absolute}`);
  const entry = lstatSync(absolute);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`${label} must be a non-symlink directory: ${absolute}`);
  const canonical = realpathSync.native(absolute);
  if (canonical.includes(",")) throw new Error(`${label} cannot contain a comma because Enfusion uses comma-delimited addon roots`);
  return canonical;
}

function ensureArtifactRoot(path: string): string {
  const absolute = resolve(path);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  return canonicalDirectory(absolute, "Acceptance artifact root");
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Acceptance run was cancelled"));
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolvePromise();
    }, milliseconds);
    const aborted = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      rejectPromise(signal?.reason ?? new Error("Acceptance run was cancelled"));
    };
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function remainingMilliseconds(deadline: number, label: string): number {
  const remaining = deadline - Date.now();
  if (remaining < 1_000) throw new Error(`${label} exceeded the overall acceptance deadline`);
  return remaining;
}

export function assertLiveRunAuthorized(confirmed: boolean, environment: NodeJS.ProcessEnv = process.env): void {
  if (!confirmed || environment[LIVE_RUN_ENVIRONMENT] !== "1") {
    throw new Error(
      `Live engine launch is disabled. Set ${LIVE_RUN_ENVIRONMENT}=1 and pass --confirm-live-run after reviewing the exact-owned process and disposable-path safeguards.`
    );
  }
}

export function findBlockingProcesses(rows: ProcessRow[]): BlockingProcess[] {
  return rows.flatMap((row) => {
    const processName = typeof row.ProcessName === "string" ? row.ProcessName : "";
    const id = typeof row.Id === "number" ? row.Id : Number(row.Id);
    return BLOCKING_PROCESS_NAMES.has(processName.toLowerCase()) && Number.isSafeInteger(id) && id > 0
      ? [{ id, processName }]
      : [];
  }).sort((left, right) => left.id - right.id);
}

export function inspectBlockingProcesses(): BlockingProcess[] {
  if (process.platform !== "win32") throw new Error("The real-engine AI-stress observer harness is Windows-only");
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$items = @(Get-Process -ErrorAction Stop | Select-Object -Property Id,ProcessName)",
    "[Console]::Out.Write((ConvertTo-Json -InputObject $items -Compress))",
  ].join("; ");
  const inspection = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (inspection.error || inspection.status !== 0) {
    throw new Error(`Cannot prove that Arma Reforger and Workbench are absent; process inspection failed. No game was launched.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspection.stdout || "[]");
  } catch {
    throw new Error("Cannot prove that Arma Reforger and Workbench are absent; process inspection returned invalid data. No game was launched.");
  }
  return findBlockingProcesses(Array.isArray(parsed) ? parsed : [parsed]);
}

export function assertNoBlockingProcesses(blocking = inspectBlockingProcesses()): void {
  if (blocking.length === 0) return;
  const summary = blocking.map((entry) => `${entry.processName}:${entry.id}`).join(", ");
  throw new Error(`Refusing to start the isolated observer acceptance run while an Arma Reforger or Workbench process exists: ${summary}`);
}

function processIdIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function acquireSharedLaunchLock(timeoutMs = 15_000): Promise<LaunchLock> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const descriptor = openSync(SHARED_LAUNCH_LOCK, "wx+", 0o600);
      const token = randomUUID();
      const record = Buffer.from(JSON.stringify({ pid: process.pid, createdAtMs: Date.now(), token }), "utf8");
      writeSync(descriptor, record);
      fsyncSync(descriptor);
      return { descriptor, path: SHARED_LAUNCH_LOCK, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const info = statSync(SHARED_LAUNCH_LOCK);
        if (Date.now() - info.mtimeMs > 120_000) {
          const record = JSON.parse(readFileSync(SHARED_LAUNCH_LOCK, "utf8")) as { pid?: unknown };
          const holder = Number(record.pid);
          if (Number.isSafeInteger(holder) && holder > 0 && !processIdIsAlive(holder)) {
            unlinkSync(SHARED_LAUNCH_LOCK);
            continue;
          }
        }
      } catch {
        // An active FileShare.None PowerShell holder is intentionally unreadable.
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the machine-wide Reforger/Workbench launch lock at ${SHARED_LAUNCH_LOCK}. No game was launched.`);
      }
      await delay(100);
    }
  }
}

function releaseSharedLaunchLock(lock: LaunchLock | null): void {
  if (!lock) return;
  closeSync(lock.descriptor);
  try {
    const entry = lstatSync(lock.path);
    if (entry.isSymbolicLink() || !entry.isFile()) return;
    const value = JSON.parse(readFileSync(lock.path, "utf8")) as { token?: unknown };
    if (value.token === lock.token) unlinkSync(lock.path);
  } catch {
    // Fail closed: never delete a path whose exact ownership cannot be verified.
  }
}

export function updateRuntimeMarkers(
  evidence: RuntimeMarkerEvidence,
  text: string,
  sourcePath: string,
  observedAt = new Date().toISOString()
): RuntimeMarkerEvidence {
  const next = { ...evidence };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!next.activeEntry && line.includes(ACTIVE_ENTRY_MARKER)) {
      next.activeEntry = { sourcePath, line: line.slice(0, 4_096), observedAt };
    }
    if (!next.liveRunner && LIVE_RUNNER_PATTERN.test(line)) {
      next.liveRunner = { sourcePath, line: line.slice(0, 4_096), observedAt };
    }
  }
  return next;
}

function listFiles(root: string, predicate: (path: string) => boolean, limit = 128): string[] {
  const files: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > 10 || files.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) break;
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile() && predicate(path)) files.push(path);
    }
  };
  visit(root, 0);
  return files;
}

function readFileTail(path: string, maximumBytes = 4 * 1024 * 1024): string {
  const size = statSync(path).size;
  const length = Math.min(size, maximumBytes);
  if (length <= 0) return "";
  const descriptor = openSync(path, "r");
  try {
    const bytes = Buffer.allocUnsafe(length);
    const count = readSync(descriptor, bytes, 0, length, size - length);
    return bytes.subarray(0, count).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

async function waitForRuntimeMarkers(
  profilePath: string,
  processHandle: ChildProcess,
  deadline: number,
  signal: AbortSignal
): Promise<RuntimeMarkerEvidence> {
  let evidence: RuntimeMarkerEvidence = { activeEntry: null, liveRunner: null };
  while (!evidence.activeEntry || !evidence.liveRunner) {
    assertOwnedProcessRunning(processHandle, "while waiting for AI-live log evidence");
    for (const path of listFiles(profilePath, (candidate) => extname(candidate).toLowerCase() === ".log")) {
      try {
        evidence = updateRuntimeMarkers(evidence, readFileTail(path), path);
      } catch {
        // Logs may be rotated between enumeration and the bounded tail read.
      }
      if (evidence.activeEntry && evidence.liveRunner) return evidence;
    }
    await delay(Math.min(1_000, remainingMilliseconds(deadline, "AI-live marker wait")), signal);
  }
  return evidence;
}

function crcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = crcTable();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left: number, above: number, upperLeft: number): number {
  const candidate = left + above - upperLeft;
  const leftDistance = Math.abs(candidate - left);
  const aboveDistance = Math.abs(candidate - above);
  const diagonalDistance = Math.abs(candidate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= diagonalDistance) return left;
  return aboveDistance <= diagonalDistance ? above : upperLeft;
}

export function analyzePngMaterial(png: Buffer): PngMaterialEvidence {
  if (png.length < 45 || png.length > MAX_PNG_BYTES || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Retained capture is not a bounded PNG");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels: 3 | 4 | 0 = 0;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;
  let dataEnded = false;
  const compressed: Buffer[] = [];
  while (offset < png.length) {
    if (offset + 12 > png.length) throw new Error("PNG chunk header is truncated");
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > png.length) throw new Error("PNG chunk exceeds file bounds");
    const body = png.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = png.readUInt32BE(offset + 8 + length);
    if (crc32(Buffer.concat([Buffer.from(type, "ascii"), body])) !== expectedCrc) throw new Error(`PNG ${type} CRC is invalid`);
    if (type === "IHDR") {
      if (sawHeader || offset !== 8 || length !== 13) throw new Error("PNG IHDR placement is invalid");
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const pixels = width * height;
      if (!Number.isSafeInteger(pixels) || width < 64 || height < 64 || pixels > MAX_PNG_PIXELS) {
        throw new Error(`PNG dimensions are outside the live screenshot bounds: ${width}x${height}`);
      }
      if (body[8] !== 8 || ![2, 6].includes(body[9]) || body[10] !== 0 || body[11] !== 0 || body[12] !== 0) {
        throw new Error("PNG encoding is outside the supported RGB/RGBA non-interlaced subset");
      }
      channels = body[9] === 6 ? 4 : 3;
      sawHeader = true;
    } else if (type === "IDAT") {
      if (!sawHeader || dataEnded) throw new Error("PNG IDAT placement is invalid");
      sawData = true;
      compressed.push(body);
    } else if (type === "IEND") {
      if (length !== 0 || end !== png.length) throw new Error("PNG IEND or trailing data is invalid");
      sawEnd = true;
    } else {
      if (sawData) dataEnded = true;
      if (/^[A-Z]/.test(type)) throw new Error(`Unexpected critical PNG chunk ${type}`);
    }
    offset = end;
  }
  if (!sawHeader || !sawData || !sawEnd || channels === 0) throw new Error("PNG is missing required chunks");
  const stride = width * channels;
  const expectedDecoded = height * (stride + 1);
  let filtered: Buffer;
  try {
    filtered = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedDecoded + 1 });
  } catch {
    throw new Error("PNG compressed image data is invalid or exceeds its decoded budget");
  }
  if (filtered.length !== expectedDecoded) throw new Error("PNG decoded image length is invalid");
  const pixels = Buffer.allocUnsafe(width * height * channels);
  for (let row = 0; row < height; row += 1) {
    const filterOffset = row * (stride + 1);
    const filter = filtered[filterOffset];
    if (filter > 4) throw new Error(`PNG row ${row} uses invalid filter ${filter}`);
    const outputOffset = row * stride;
    for (let column = 0; column < stride; column += 1) {
      const raw = filtered[filterOffset + 1 + column];
      const left = column >= channels ? pixels[outputOffset + column - channels] : 0;
      const above = row > 0 ? pixels[outputOffset + column - stride] : 0;
      const upperLeft = row > 0 && column >= channels ? pixels[outputOffset + column - stride - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = Math.floor((left + above) / 2);
      else if (filter === 4) predictor = paeth(left, above, upperLeft);
      pixels[outputOffset + column] = (raw + predictor) & 0xff;
    }
  }

  const pixelCount = width * height;
  const sampleStep = Math.max(1, Math.floor(pixelCount / 100_000));
  const colors = new Set<number>();
  let sampledPixels = 0;
  let nonBlack = 0;
  let luminanceMinimum = 255;
  let luminanceMaximum = 0;
  let luminanceMean = 0;
  let luminanceM2 = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += sampleStep) {
    const offset = pixel * channels;
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    sampledPixels += 1;
    if (Math.max(red, green, blue) > 8) nonBlack += 1;
    luminanceMinimum = Math.min(luminanceMinimum, luminance);
    luminanceMaximum = Math.max(luminanceMaximum, luminance);
    const delta = luminance - luminanceMean;
    luminanceMean += delta / sampledPixels;
    luminanceM2 += delta * (luminance - luminanceMean);
    if (colors.size < 4_096) colors.add(((red >> 3) << 10) | ((green >> 3) << 5) | (blue >> 3));
  }
  const standardDeviation = Math.sqrt(luminanceM2 / Math.max(1, sampledPixels - 1));
  const nonBlackRatio = nonBlack / sampledPixels;
  const materiallyVaried = sampledPixels >= 1_000 && colors.size >= 16 && nonBlackRatio >= 0.01 &&
    luminanceMaximum - luminanceMinimum >= 10 && standardDeviation >= 2.5;
  return {
    width,
    height,
    channels,
    byteCount: png.length,
    sha256: createHash("sha256").update(png).digest("hex"),
    sampledPixels,
    quantizedColorCount: colors.size,
    nonBlackRatio: Number(nonBlackRatio.toFixed(6)),
    luminanceMinimum: Number(luminanceMinimum.toFixed(3)),
    luminanceMaximum: Number(luminanceMaximum.toFixed(3)),
    luminanceStandardDeviation: Number(standardDeviation.toFixed(3)),
    materiallyVaried,
  };
}

export function buildAiStressLaunchArguments(input: {
  projectFile: string;
  addonDirectories: string[];
  profilePath: string;
  engineSettingsPath: string;
}): string[] {
  return [
    "-gproj", input.projectFile,
    "-addonsDir", input.addonDirectories.join(","),
    "-addons", LOADED_ADDON_IDS.join(","),
    "-autotest", AI_STRESS_TEST_CASE,
    "-scrDefine", "RR_AI_STRESS_AUTOTEST",
    "-profile", input.profilePath,
    "-cfg", input.engineSettingsPath,
    "-logLevel", "debug",
    "-noFocus",
    "-forceUpdate",
    "-noThrow",
    "-disableCrashReporter",
    "-VMErrorMode", "fatal",
    "-noSound",
    "-noSplash",
  ];
}

export function launchArgumentsContainAddon(argumentsArray: string[], addonGuid: string): boolean {
  for (let index = 0; index < argumentsArray.length - 1; index += 1) {
    if (argumentsArray[index].toLowerCase() !== "-addons") continue;
    if (argumentsArray[index + 1].split(",").map((value) => value.trim()).includes(addonGuid)) return true;
  }
  return false;
}

function assertOwnedProcessRunning(processHandle: ChildProcess, context: string): void {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    throw new Error(`Exact owned diagnostic-game PID ${processHandle.pid ?? "unknown"} exited ${context} (code=${processHandle.exitCode ?? "none"}, signal=${processHandle.signalCode ?? "none"})`);
  }
}

function startOwnedGame(
  executable: string,
  argumentsArray: string[],
  cwd: string,
  visible: boolean,
  stdoutPath: string,
  stderrPath: string
): ChildProcess {
  const stdout = createWriteStream(stdoutPath, { fd: openSync(stdoutPath, "wx", 0o600), autoClose: true });
  const stderr = createWriteStream(stderrPath, { fd: openSync(stderrPath, "wx", 0o600), autoClose: true });
  const child = spawn(executable, argumentsArray, {
    cwd,
    windowsHide: !visible,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);
  return child;
}

async function waitForOwnedGameSpawn(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("Exact owned diagnostic game did not report a successful spawn within 15 seconds")), 15_000);
    child.once("spawn", () => {
      clearTimeout(timer);
      resolvePromise();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
  if (!child.pid || child.pid <= 0) throw new Error("Diagnostic game spawn returned no attributable PID");
}

async function stopOwnedProcessAndConfirm(processHandle: ChildProcess, timeoutMs = 15_000): Promise<void> {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
  const exited = new Promise<void>((resolvePromise) => processHandle.once("exit", () => resolvePromise()));
  if (!processHandle.kill()) {
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
    throw new Error(`Could not terminate exact owned diagnostic-game PID ${processHandle.pid ?? "unknown"}`);
  }
  await Promise.race([
    exited,
    delay(timeoutMs).then(() => {
      throw new Error(`Exact owned diagnostic-game PID ${processHandle.pid ?? "unknown"} did not exit within ${timeoutMs}ms`);
    }),
  ]);
}

export function compatibleRenderer(
  instance: Record<string, unknown>,
  sessionId: string,
  processId: number,
  instanceId?: string
): boolean {
  const capabilities = Array.isArray(instance.capabilities) ? instance.capabilities : [];
  return instance.sessionId === sessionId &&
    (!instanceId || instance.instanceId === instanceId) &&
    // The public Enfusion System API does not expose the current OS PID. A
    // runtime may therefore omit processId (the protocol field is optional).
    // When it can report one it must match exactly; otherwise the harness
    // binds registration through the exclusive profile contract/session,
    // launch attestation, empty-process preflight, and live direct child.
    (instance.processId === undefined || instance.processId === processId) &&
    instance.runtimeKind === "testRunner" &&
    instance.headless === false &&
    instance.stale !== true &&
    instance.transportHealthy !== false &&
    typeof instance.worldId === "string" && instance.worldId.length > 0 &&
    Number.isSafeInteger(instance.worldEpoch) && Number(instance.worldEpoch) > 0 &&
    ["render.capture", "camera.runtime", "world.query"].every((capability) => capabilities.includes(capability));
}

async function waitForRenderer(
  coordinator: ObserverCoordinatorLike,
  sessionId: string,
  processHandle: ChildProcess,
  deadline: number,
  signal: AbortSignal,
  expectedInstanceId?: string
): Promise<Record<string, unknown>> {
  const processId = processHandle.pid!;
  for (;;) {
    assertOwnedProcessRunning(processHandle, "before observer registration/capability proof");
    const waitMs = Math.min(5_000, remainingMilliseconds(deadline, "Observer registration wait"));
    const inventory = await coordinator.instances({
      sessionId,
      requiredCapabilities: ["render.capture", "camera.runtime", "world.query"],
      renderersOnly: true,
      waitMs,
      signal,
    });
    const sessionInstances = inventory.instances.filter((instance) => instance.sessionId === sessionId);
    const wrongProcess = sessionInstances.find((instance) =>
      instance.stale !== true && instance.transportHealthy !== false &&
      instance.processId !== undefined && instance.processId !== processId
    );
    if (wrongProcess) throw new Error("Observer session registered a runtime claiming a different diagnostic-game PID");
    const compatible = inventory.instances.filter((instance) => compatibleRenderer(instance, sessionId, processId, expectedInstanceId));
    if (compatible.length === 1) return compatible[0];
    if (compatible.length > 1) throw new Error("Observer session reported multiple compatible renderers for one exact-owned launch");
  }
}

function jobIdFromError(error: unknown): string | null {
  if (!isRecord(error)) return null;
  const details = isRecord(error.details) ? error.details : null;
  const job = details && isRecord(details.job) ? details.job : null;
  return job && typeof job.jobId === "string" ? job.jobId : null;
}

function assertCompletedCapture(
  result: ObserverCaptureResult,
  expectedInstanceId: string,
  expectedWorldEpoch: number
): asserts result is ObserverCaptureResult & { image: Buffer; metadata: Record<string, unknown> } {
  if (result.asynchronous || !Buffer.isBuffer(result.image) || !isRecord(result.metadata)) {
    throw new Error("Observer coordinator did not return a synchronous validated image result");
  }
  if (result.job.state !== "completed" || result.job.instanceId !== expectedInstanceId || result.job.worldEpoch !== expectedWorldEpoch) {
    throw new Error("Observer capture completion identity does not match the proven renderer/world generation");
  }
}

async function captureAndRetain(input: {
  coordinator: ObserverCoordinatorLike;
  sessionId: string;
  instanceId: string;
  worldEpoch: number;
  runId: string;
  label: string;
  view: Record<string, unknown>;
  evidenceDirectory: string;
  captureTimeoutMs: number;
  deadline: number;
  signal: AbortSignal;
  trackedJobs: Set<string>;
  requireMaterialVariation: boolean;
}): Promise<RetainedCapture> {
  let result: ObserverCaptureResult;
  try {
    result = await input.coordinator.capture({
      sessionId: input.sessionId,
      instanceId: input.instanceId,
      idempotencyKey: `${input.runId}-${input.label}`.slice(0, 128),
      view: input.view,
      settleFrames: 2,
      performancePolicy: "evidence",
      asynchronous: false,
      timeoutMs: Math.min(input.captureTimeoutMs, remainingMilliseconds(input.deadline, `${input.label} capture`)),
      signal: input.signal,
    });
  } catch (error) {
    const jobId = jobIdFromError(error);
    if (jobId) input.trackedJobs.add(jobId);
    throw error;
  }
  const jobId = typeof result.job.jobId === "string" ? result.job.jobId : null;
  if (jobId) input.trackedJobs.add(jobId);
  assertCompletedCapture(result, input.instanceId, input.worldEpoch);
  const pngEvidence = analyzePngMaterial(result.image);
  if (input.requireMaterialVariation && !pngEvidence.materiallyVaried) {
    throw new Error(`${input.label} PNG is structurally valid but not materially nonblank/color-varied`);
  }
  if (typeof result.metadata.contentSha256 === "string" && result.metadata.contentSha256 !== pngEvidence.sha256) {
    throw new Error(`${input.label} retained PNG hash does not match observer metadata`);
  }
  const imagePath = join(input.evidenceDirectory, `${input.label}.png`);
  const metadataPath = join(input.evidenceDirectory, `${input.label}.metadata.json`);
  const jobPath = join(input.evidenceDirectory, `${input.label}.job.json`);
  writeFileSync(imagePath, result.image, { flag: "wx", mode: 0o600 });
  atomicWriteJson(metadataPath, result.metadata);
  atomicWriteJson(jobPath, result.job);
  return { label: input.label, imagePath, metadataPath, jobPath, job: result.job, metadata: result.metadata, png: pngEvidence };
}

function matrixFromCapture(capture: RetainedCapture): number[] {
  const actualCamera = isRecord(capture.metadata.actualCamera) ? capture.metadata.actualCamera : null;
  const matrix = actualCamera && Array.isArray(actualCamera.matrix) ? actualCamera.matrix.map(Number) : [];
  if (matrix.length !== 16 || matrix.some((value) => !Number.isFinite(value))) {
    throw new Error("AI-live current capture did not provide a finite baseline camera matrix for the pose/restoration proof");
  }
  return matrix;
}

function fovFromCapture(capture: RetainedCapture): number {
  const raw = Number(capture.metadata.actualFov);
  return Number.isFinite(raw) ? Math.min(120, Math.max(10, raw)) : 60;
}

function assertPoseRestoration(capture: RetainedCapture, position: number[], fov: number): void {
  const lease = asRecord(capture.job.cameraLease, "Pose job camera lease");
  if (lease.everHeld !== true || lease.held !== false || lease.restorationConfirmed !== true) {
    throw new Error("Pose capture did not prove an acquired camera lease followed by exact restoration");
  }
  const actualCamera = asRecord(capture.metadata.actualCamera, "Pose actual camera");
  const matrix = Array.isArray(actualCamera.matrix) ? actualCamera.matrix.map(Number) : [];
  if (matrix.length !== 16 || matrix.some((value) => !Number.isFinite(value))) throw new Error("Pose capture is missing actual transform evidence");
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(matrix[12 + axis] - position[axis]) > 0.01) throw new Error("Pose capture actual position differs from the requested baseline position");
  }
  if (!Number.isFinite(Number(capture.metadata.actualFov)) || Math.abs(Number(capture.metadata.actualFov) - fov) > 0.1) {
    throw new Error("Pose capture actual FOV differs from the bounded requested FOV");
  }
}

function assertCurrentNeverLeased(capture: RetainedCapture): void {
  const lease = asRecord(capture.job.cameraLease, `${capture.label} camera lease`);
  if (lease.everHeld !== false || lease.held !== false) throw new Error(`${capture.label} unexpectedly acquired an observer camera lease`);
}

async function cancelOutstandingJobs(
  coordinator: ObserverCoordinatorLike,
  sessionId: string,
  jobIds: Set<string>,
  processHandle: ChildProcess | null
): Promise<Array<Record<string, unknown>>> {
  const records: Array<Record<string, unknown>> = [];
  const deadline = Date.now() + 20_000;
  for (const jobId of jobIds) {
    let job: Record<string, unknown>;
    try {
      job = await coordinator.jobStatus(sessionId, jobId);
    } catch {
      continue;
    }
    if (!TERMINAL_JOB_STATES.has(String(job.state))) {
      try { job = await coordinator.cancelJob(sessionId, jobId); } catch { /* continue bounded polling */ }
      while (!TERMINAL_JOB_STATES.has(String(job.state)) && Date.now() < deadline &&
        processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
        await delay(200);
        try { job = await coordinator.jobStatus(sessionId, jobId); } catch { break; }
      }
    }
    records.push(job);
  }
  return records;
}

export function isExpectedObserverSourceCacheWarning(line: string): boolean {
  return /RESOURCES\s+\(W\):\s+ResourceDB:\s+could not open the cache file\s+['"][^'"\r\n]*[\\/]ReforgerForgeObserver[\\/]resourceDatabase\.rdb['"]\s*$/i.test(line);
}

function diagnosticsFailures(profilePath: string): Array<{ path: string; lineNumber: number; line: string }> {
  const failures: Array<{ path: string; lineNumber: number; line: string }> = [];
  const fatal = /(assertion\s+failed|resources?\s+are\s+leaking!|\bout\s+of\s+memory\b|unhandled\s+exception|access[_ ]violation|SteamAPI_Init failed|Could not initialize platform services|Unable to initialize the game)/i;
  let scannedBytes = 0;
  for (const path of listFiles(profilePath, (candidate) => extname(candidate).toLowerCase() === ".log")) {
    let descriptor: number;
    let size: number;
    try {
      size = statSync(path).size;
      if (size > 256 * 1024 * 1024 || scannedBytes + size > 512 * 1024 * 1024) {
        failures.push({ path, lineNumber: 0, line: "Diagnostic log volume exceeded the bounded acceptance scan budget" });
        return failures;
      }
      descriptor = openSync(path, "r");
    } catch { continue; }
    scannedBytes += size;
    let lineNumber = 0;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let carry = "";
    try {
      for (;;) {
        const count = readSync(descriptor, buffer, 0, buffer.length, null);
        if (count <= 0) break;
        const lines = `${carry}${buffer.subarray(0, count).toString("utf8")}`.split(/\r?\n/);
        carry = lines.pop() ?? "";
        if (carry.length > 64 * 1024) carry = carry.slice(-64 * 1024);
        for (const line of lines) {
          lineNumber += 1;
          const ownedDiagnostic = /\((?:E|W)\):/.test(line) && /(RoadblockRunners|\$RoadblockRunners:|Scripts[/\\]Game[/\\]RR_|\bRR\s|ReforgerForgeObserver|RFO_Observer)/i.test(line);
          if ((fatal.test(line) || ownedDiagnostic) && !isExpectedObserverSourceCacheWarning(line)) {
            failures.push({ path, lineNumber, line: line.trim().slice(0, 4_096) });
          }
          if (failures.length >= 100) return failures;
        }
      }
      if (carry) {
        lineNumber += 1;
        const ownedDiagnostic = /\((?:E|W)\):/.test(carry) && /(RoadblockRunners|\$RoadblockRunners:|Scripts[/\\]Game[/\\]RR_|\bRR\s|ReforgerForgeObserver|RFO_Observer)/i.test(carry);
        if ((fatal.test(carry) || ownedDiagnostic) && !isExpectedObserverSourceCacheWarning(carry)) {
          failures.push({ path, lineNumber, line: carry.trim().slice(0, 4_096) });
        }
      }
    } finally {
      closeSync(descriptor);
    }
  }
  return failures;
}

function crashArtifacts(profilePath: string): string[] {
  return listFiles(profilePath, (path) => [".dmp", ".mdmp"].includes(extname(path).toLowerCase()) || /^crash.*\.log$/i.test(basename(path)));
}

function parseCli(argumentsArray: string[], environment: NodeJS.ProcessEnv): AcceptanceOptions {
  const values = new Map<string, string[]>();
  const valueOptions = new Set([
    "--game-exe",
    "--base-game-addons",
    "--workshop-addons",
    "--artifact-root",
    "--timeout-seconds",
    "--capture-timeout-seconds",
  ]);
  let confirmed = false;
  let visible = false;
  for (let index = 0; index < argumentsArray.length; index += 1) {
    const argument = argumentsArray[index];
    if (argument === "--confirm-live-run") { confirmed = true; continue; }
    if (argument === "--visible") { visible = true; continue; }
    if (!valueOptions.has(argument)) throw new Error(`Unexpected argument: ${argument}`);
    const value = argumentsArray[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    index += 1;
    values.set(argument, [...(values.get(argument) ?? []), value]);
  }
  assertLiveRunAuthorized(confirmed, environment);
  const one = (name: string, fallback?: string): string => {
    const entries = values.get(name) ?? [];
    if (entries.length > 1) throw new Error(`${name} may be supplied only once`);
    const value = entries[0] ?? fallback;
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const gameExecutable = one("--game-exe", environment.RFO_ENGINE_EXECUTABLE);
  const baseGameAddons = one("--base-game-addons", environment.RFO_BASE_GAME_ADDONS ?? join(dirname(gameExecutable), "addons"));
  const environmentWorkshop = (environment.RFO_WORKSHOP_ADDONS ?? "").split(delimiter).filter(Boolean);
  const workshopAddons = values.get("--workshop-addons") ?? environmentWorkshop;
  if (workshopAddons.length === 0) throw new Error("At least one --workshop-addons directory (or RFO_WORKSHOP_ADDONS) is required");
  return {
    confirmed,
    gameExecutable,
    baseGameAddons,
    workshopAddons,
    artifactRoot: one("--artifact-root", environment.RFO_OBSERVER_ACCEPTANCE_ARTIFACT_ROOT ?? join(tmpdir(), "ReforgerForgeObserver", "AIStressAcceptance")),
    timeoutSeconds: boundedInteger(one("--timeout-seconds", environment.RFO_OBSERVER_ACCEPTANCE_TIMEOUT_SECONDS ?? "600"), 600, 120, 1_800, "Acceptance timeout"),
    captureTimeoutSeconds: boundedInteger(one("--capture-timeout-seconds", environment.RFO_OBSERVER_CAPTURE_TIMEOUT_SECONDS ?? "45"), 45, 10, 180, "Capture timeout"),
    visible,
    environment,
  };
}

export async function runObserverAiStressAcceptance(options: AcceptanceOptions): Promise<{ summaryPath: string; summary: Record<string, unknown> }> {
  const environment = options.environment ?? process.env;
  assertLiveRunAuthorized(options.confirmed, environment);

  const compiledCoordinator = canonicalFile(join(REPOSITORY_ROOT, "dist", "observer", "coordinator.js"), "Compiled Phase H coordinator");
  const privateChild = canonicalFile(join(REPOSITORY_ROOT, "dist", "observer", "agent", "private-child.js"), "Compiled private observer child");
  const gameExecutable = canonicalFile(options.gameExecutable, "Diagnostic game executable");
  if (basename(gameExecutable).toLowerCase() !== "armareforgersteamdiag.exe") {
    throw new Error("The acceptance harness requires the directly owned ArmaReforgerSteamDiag.exe executable");
  }
  const roadblockRoot = canonicalDirectory(ROADBLOCK_ROOT, "Roadblock Runners addon root");
  const projectFile = canonicalFile(join(roadblockRoot, "RoadblockRunners.gproj"), "Roadblock Runners project");
  const projectAddonsRoot = canonicalDirectory(dirname(roadblockRoot), "Project addons root");
  const baseGameAddons = canonicalDirectory(options.baseGameAddons, "Base-game addons root");
  const workshopAddons = options.workshopAddons.map((path, index) => canonicalDirectory(path, `Workshop addons root ${index + 1}`));
  const engineSettingsTemplate = canonicalFile(join(roadblockRoot, "tools", "ai_stress_borderless_engine_settings.conf"), "AI-stress engine settings template");
  const artifactRoot = ensureArtifactRoot(options.artifactRoot);
  const timeoutSeconds = boundedInteger(options.timeoutSeconds, 600, 120, 1_800, "Acceptance timeout");
  const captureTimeoutSeconds = boundedInteger(options.captureTimeoutSeconds, 45, 10, 180, "Capture timeout");

  let launchLock: LaunchLock | null = null;
  let coordinator: ObserverCoordinatorLike | null = null;
  let gameProcess: ChildProcess | null = null;
  let sessionId: string | null = null;
  let deadlineTimer: NodeJS.Timeout | null = null;
  let summaryPath = "";
  const trackedJobs = new Set<string>();
  const cleanupErrors: string[] = [];
  let failure: unknown = null;
  let summary: Record<string, unknown> = {};

  launchLock = await acquireSharedLaunchLock();
  try {
    assertNoBlockingProcesses();
    const runId = `${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID().replace(/-/g, "")}`;
    const runDirectory = join(artifactRoot, runId);
    const managedRoot = join(runDirectory, "observer-managed");
    const profileRoot = join(runDirectory, "profiles");
    const profilePath = join(profileRoot, "game");
    const evidenceDirectory = join(runDirectory, "evidence");
    for (const directory of [runDirectory, managedRoot, profileRoot, profilePath, evidenceDirectory]) mkdirSync(directory, { recursive: true, mode: 0o700 });
    summaryPath = join(evidenceDirectory, "summary.json");
    const engineSettingsPath = join(evidenceDirectory, "AIStressEngineSettings.conf");
    copyFileSync(engineSettingsTemplate, engineSettingsPath);
    const startedAt = new Date().toISOString();
    const deadline = Date.now() + timeoutSeconds * 1_000;
    const controller = new AbortController();
    deadlineTimer = setTimeout(() => controller.abort(new Error(`Acceptance run exceeded ${timeoutSeconds}s`)), timeoutSeconds * 1_000);
    const coordinatorModule = await import(pathToFileURL(compiledCoordinator).href) as { ObserverCoordinator?: ObserverCoordinatorConstructor };
    if (typeof coordinatorModule.ObserverCoordinator !== "function") throw new Error("Compiled Phase H coordinator export is unavailable");
    coordinator = new coordinatorModule.ObserverCoordinator({
      agentPath: privateChild,
      managedRoot,
      profileRoot,
      projectPath: projectAddonsRoot,
      startupTimeoutMs: 15_000,
      requestTimeoutMs: 45_000,
      defaultCaptureTimeoutMs: captureTimeoutSeconds * 1_000,
      maxInlineImageBytes: MAX_PNG_BYTES,
      retentionIntervalMs: 60_000,
      retentionMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
      retentionMaxBytes: 2 * 1024 * 1024 * 1024,
    });
    summary = {
      version: 1,
      status: "running",
      purpose: "Observer screenshot acceptance at the proven Roadblock Runners 24v24 ACTIVE-entry gate; not a full AI-match qualification",
      runId,
      startedAt,
      timeoutSeconds,
      captureTimeoutSeconds,
      processOwnership: { kind: "direct-exact-child-only", blockingProcessPreflight: "passed" },
      compiledPhaseH: { coordinatorPath: compiledCoordinator, privateChildPath: privateChild },
      paths: { runDirectory, managedRoot, profileRoot, profilePath, evidenceDirectory },
      testCase: AI_STRESS_TEST_CASE,
      requiredMarkers: { activeEntry: ACTIVE_ENTRY_MARKER, liveRunnerPattern: LIVE_RUNNER_PATTERN.source },
      requiredCapabilities: ["render.capture", "camera.runtime", "world.query"],
    };
    atomicWriteJson(summaryPath, summary);

    try {
      const descriptor = await coordinator.ensureStarted();
      const staging = await coordinator.ensureSetup();
      const addonDirectories = [baseGameAddons, ...workshopAddons, projectAddonsRoot];
      const baseArguments = buildAiStressLaunchArguments({ projectFile, addonDirectories, profilePath, engineSettingsPath });
      const prepared = await coordinator.prepareLaunch({
        runtimeKind: "testRunner",
        arguments: baseArguments,
        profilePath,
        sessionTtlMs: Math.min(24 * 60 * 60 * 1_000, Math.max(20 * 60 * 1_000, (timeoutSeconds + 180) * 1_000)),
        transportPreference: ["rest", "mailbox"],
        forceUpdate: true,
        idempotencyKey: `${runId}-launch`.slice(0, 128),
      });
      const session = asRecord(prepared.session, "Prepared observer session");
      sessionId = typeof session.sessionId === "string" ? session.sessionId : null;
      if (!sessionId) throw new Error("Prepared observer launch returned no session ID");
      const preparedArguments = Array.isArray(prepared.arguments) && prepared.arguments.every((value) => typeof value === "string")
        ? prepared.arguments as string[]
        : null;
      if (!preparedArguments || !launchArgumentsContainAddon(preparedArguments, OBSERVER_ADDON_GUID)) {
        throw new Error("Prepared launch did not include the staged observer addon GUID");
      }
      summary.agent = descriptor;
      summary.staging = staging;
      summary.session = {
        sessionId,
        expiresAt: session.expiresAt,
        bundleDigest: session.bundleDigest,
        contractPath: session.contractPath,
      };
      summary.launch = { executable: gameExecutable, arguments: preparedArguments };
      atomicWriteJson(summaryPath, summary);

      // Recheck immediately before direct spawn. The shared launch lock closes
      // races with repository launchers; this catches an unrelated launcher
      // that ignored the shared lock after our initial preflight.
      assertNoBlockingProcesses();
      gameProcess = startOwnedGame(
        gameExecutable,
        preparedArguments,
        roadblockRoot,
        options.visible,
        join(evidenceDirectory, "owned-process.stdout.log"),
        join(evidenceDirectory, "owned-process.stderr.log")
      );
      await waitForOwnedGameSpawn(gameProcess);
      summary.processOwnership = {
        kind: "direct-exact-child-only",
        blockingProcessPreflight: "passed",
        ownedPid: gameProcess.pid,
        executable: gameExecutable,
      };
      atomicWriteJson(summaryPath, summary);
      process.stdout.write(`Observer AI-stress acceptance started exact-owned PID ${gameProcess.pid}; evidence ${runDirectory}\n`);

      // Prove activation before waiting on gameplay, but do not bind capture
      // to this bootstrap world: the autotest recompiles/recreates its game VM
      // while loading the target world.
      const startupRenderer = await waitForRenderer(coordinator, sessionId, gameProcess, deadline, controller.signal);
      summary.startupRenderer = startupRenderer;
      atomicWriteJson(summaryPath, summary);

      const markers = await waitForRuntimeMarkers(profilePath, gameProcess, deadline, controller.signal);
      const markerPath = join(evidenceDirectory, "runtime-markers.json");
      atomicWriteJson(markerPath, markers);
      writeFileSync(join(evidenceDirectory, "runtime-marker-evidence.log"), [
        markers.activeEntry?.line ?? "",
        markers.liveRunner?.line ?? "",
        "",
      ].join("\n"), { flag: "wx", mode: 0o600 });
      summary.runtimeMarkers = { ...markers, evidencePath: markerPath };

      // Select the renderer only after the marker proves the final AI-live
      // world is active. From this point through all three captures, any world
      // generation change is a hard failure.
      const renderer = await waitForRenderer(coordinator, sessionId, gameProcess, deadline, controller.signal);
      const instanceId = typeof renderer.instanceId === "string" ? renderer.instanceId : "";
      const worldEpoch = Number(renderer.worldEpoch);
      if (!instanceId) throw new Error("Compatible observer renderer omitted its instance ID");
      summary.renderer = renderer;
      summary.processBinding = {
        ownedPid: gameProcess.pid,
        runtimeReportedPid: renderer.processId ?? null,
        proof: renderer.processId === gameProcess.pid
          ? "runtime-reported-exact-pid"
          : "exclusive-profile-session-launch-attestation-and-live-direct-child",
      };
      atomicWriteJson(summaryPath, summary);

      const revalidated = await waitForRenderer(coordinator, sessionId, gameProcess, deadline, controller.signal, instanceId);
      if (revalidated.worldId !== renderer.worldId || revalidated.worldEpoch !== worldEpoch) {
        throw new Error("Renderer world generation changed after the AI-live gate and before screenshot capture");
      }

      const commonCapture = {
        coordinator,
        sessionId,
        instanceId,
        worldEpoch,
        runId,
        evidenceDirectory,
        captureTimeoutMs: captureTimeoutSeconds * 1_000,
        deadline,
        signal: controller.signal,
        trackedJobs,
      };
      const aiLive = await captureAndRetain({
        ...commonCapture,
        label: "ai-live-current",
        view: { kind: "current" },
        requireMaterialVariation: true,
      });
      assertCurrentNeverLeased(aiLive);

      const baselineMatrix = matrixFromCapture(aiLive);
      const baselinePosition = baselineMatrix.slice(12, 15);
      if (baselinePosition.some((value) => !Number.isFinite(value)) || Math.hypot(...baselinePosition) > 100_000) {
        throw new Error("AI-live baseline camera position is outside the observer session capture bounds");
      }
      const boundedFov = fovFromCapture(aiLive);
      const pose = await captureAndRetain({
        ...commonCapture,
        label: "pose-restoration",
        view: { kind: "pose", position: baselinePosition, orientation: [0, 0, 0, 1], fov: boundedFov },
        requireMaterialVariation: false,
      });
      assertPoseRestoration(pose, baselinePosition, boundedFov);

      const postPoseRenderer = await waitForRenderer(coordinator, sessionId, gameProcess, deadline, controller.signal, instanceId);
      if (postPoseRenderer.worldId !== renderer.worldId || postPoseRenderer.worldEpoch !== worldEpoch) {
        throw new Error("Renderer world generation changed after the pose restoration transaction");
      }
      const postRestoration = await captureAndRetain({
        ...commonCapture,
        label: "post-restoration-current",
        view: { kind: "current" },
        requireMaterialVariation: true,
      });
      assertCurrentNeverLeased(postRestoration);
      summary.captures = [aiLive, pose, postRestoration].map((capture) => ({
        label: capture.label,
        imagePath: capture.imagePath,
        metadataPath: capture.metadataPath,
        jobPath: capture.jobPath,
        jobId: capture.job.jobId,
        cameraLease: capture.job.cameraLease,
        png: capture.png,
      }));
      summary.poseRequest = { position: baselinePosition, orientation: [0, 0, 0, 1], fov: boundedFov };
      atomicWriteJson(summaryPath, summary);

      const liveDiagnostics = diagnosticsFailures(profilePath);
      if (liveDiagnostics.length > 0) {
        summary.diagnosticFailures = liveDiagnostics;
        throw new Error(`Owned runtime logs contain ${liveDiagnostics.length} fatal or project/observer-owned warning/error line(s)`);
      }

      await stopOwnedProcessAndConfirm(gameProcess);
      const crashes = crashArtifacts(profilePath);
      if (crashes.length > 0) throw new Error(`Owned runtime produced crash artifact(s): ${crashes.join("; ")}`);
      const finalDiagnostics = diagnosticsFailures(profilePath);
      if (finalDiagnostics.length > 0) {
        summary.diagnosticFailures = finalDiagnostics;
        throw new Error(`Owned runtime logs contain ${finalDiagnostics.length} fatal or project/observer-owned warning/error line(s)`);
      }
      const runtimeLogs = listFiles(profilePath, (candidate) => extname(candidate).toLowerCase() === ".log");
      summary.runtimeLogs = runtimeLogs.map((path) => ({ path, bytes: statSync(path).size }));
      summary.crashArtifacts = crashes;
      summary.status = "passed";
      summary.finishedAt = new Date().toISOString();
      summary.processExit = { exitCode: gameProcess.exitCode, signalCode: gameProcess.signalCode, stoppedAfterEvidence: true };
    } finally {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
    }
  } catch (error) {
    failure = error;
    if (summaryPath) {
      summary.status = "failed";
      summary.finishedAt = new Date().toISOString();
      summary.failure = {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
    if (coordinator && sessionId) {
      try {
        summary.cleanupJobs = await cancelOutstandingJobs(coordinator, sessionId, trackedJobs, gameProcess);
      } catch (error) {
        cleanupErrors.push(`job cancellation/restoration wait: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (gameProcess) {
      try { await stopOwnedProcessAndConfirm(gameProcess); }
      catch (error) { cleanupErrors.push(`exact-owned process stop: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (coordinator && sessionId && (!gameProcess || gameProcess.exitCode !== null || gameProcess.signalCode !== null)) {
      try { summary.sessionRevocation = await coordinator.revokeSession(sessionId); }
      catch (error) { cleanupErrors.push(`session revocation: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (coordinator) {
      try { await coordinator.close(); }
      catch (error) { cleanupErrors.push(`coordinator close: ${error instanceof Error ? error.message : String(error)}`); }
    }
    releaseSharedLaunchLock(launchLock);
    if (cleanupErrors.length > 0) {
      summary.cleanupErrors = cleanupErrors;
      if (!failure) failure = new Error(`Acceptance evidence completed but cleanup failed: ${cleanupErrors.join("; ")}`);
      summary.status = "failed";
    }
    if (summaryPath) {
      summary.finishedAt = summary.finishedAt ?? new Date().toISOString();
      summary = asRecord(redactEvidenceForRetention(summary), "Redacted acceptance summary");
      atomicWriteJson(summaryPath, summary);
    }
  }

  if (failure) {
    const error = failure instanceof Error ? failure : new Error(String(failure));
    if (summaryPath) error.message = `${error.message}. Retained summary: ${summaryPath}`;
    throw error;
  }
  return { summaryPath, summary };
}

function usage(): string {
  return `Usage: npm run observer:acceptance:ai-stress -- --confirm-live-run [options]\n\n` +
    `Required opt-in environment: ${LIVE_RUN_ENVIRONMENT}=1\n\n` +
    `Options:\n` +
    `  --game-exe <ArmaReforgerSteamDiag.exe>\n` +
    `  --base-game-addons <directory>\n` +
    `  --workshop-addons <directory>       Repeat for multiple roots\n` +
    `  --artifact-root <directory>\n` +
    `  --timeout-seconds <120..1800>\n` +
    `  --capture-timeout-seconds <10..180>\n` +
    `  --visible                            Do not request a hidden test window\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(usage());
  } else {
    try {
      const result = await runObserverAiStressAcceptance(parseCli(process.argv.slice(2), process.env));
      process.stdout.write(`Observer AI-stress screenshot acceptance passed.\nRFO_OBSERVER_ACCEPTANCE_RESULT=${result.summaryPath}\n`);
    } catch (error) {
      process.stderr.write(`${redactEvidenceText(error instanceof Error ? error.message : String(error))}\n`);
      process.exitCode = 1;
    }
  }
}
