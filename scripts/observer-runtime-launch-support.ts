// Shared, side-effect-light helpers used by both the legacy runtime
// positive-path acceptance script (scripts/run-runtime-observer-acceptance.ts)
// and the Phase 2 fault-matrix runner (scripts/observer-runtime-failure-matrix.ts).
// Kept in its own module so neither of those two scripts needs to import the
// other: run-runtime-observer-acceptance.ts's CLI delegates to the matrix
// runner, so a shared-helper import cycle between them would otherwise leave
// top-level constants like REPOSITORY_ROOT read before initialization.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { loadConfig } from "../src/config.js";
import type { ObserverCaptureView } from "../src/observer/application.js";
import { inspectBlockingProcesses, type PngComparisonEvidence } from "./observer-live-acceptance-support.js";

export type Vector3 = [number, number, number];
export type Quaternion = [number, number, number, number];
export type RuntimeCameraMatrix = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

export const LIVE_RUNTIME_OBSERVER_ENVIRONMENT =
  "RFO_RUN_LIVE_RUNTIME_OBSERVER_ACCEPTANCE";
export const LIVE_RUNTIME_OBSERVER_TEST_CONFIRMATION =
  "RFO_CONFIRM_LIVE_RUNTIME_OBSERVER_ACCEPTANCE";
export const DEFAULT_RUNTIME_OBSERVER_WORLD =
  "{96A8AF57260A7392}worlds/MP/MpTest/MpTest.ent";
export const DEFAULT_RUNTIME_OBSERVER_POSE_POSITION: Vector3 = [96, 90, -5];
export const DEFAULT_RUNTIME_OBSERVER_POSE_ORIENTATION: Quaternion = [
  0.3063401817273692,
  -0.14012450476798344,
  0.0456440842650991,
  0.9404453380151182,
];
export const DEFAULT_RUNTIME_OBSERVER_POSE_FOV = 58;
export const DEFAULT_RUNTIME_OBSERVER_LOOK_AT_POSITION: Vector3 = [64, 121, -40];
export const DEFAULT_RUNTIME_OBSERVER_LOOK_AT_TARGET: Vector3 = [64, 10, 100];
export const DEFAULT_RUNTIME_OBSERVER_LOOK_AT_FOV = 70;

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RUNTIME_OPERATIONAL_BASELINE_SOURCES = [
  "dist/observer/agent/private-child.js",
  "observer/addon/.reforger-forge-observer-source.json",
  "observer/addon/addon.gproj",
  "observer/agent/private-child.ts",
  "observer/agent/application.ts",
  "observer/agent/application-operations.ts",
  "observer/agent/evidence-bundle-service.ts",
  "package-lock.json",
  "package.json",
  "scripts/windows/workbench-lifecycle.ps1",
  "scripts/observer-runtime-launch-support.ts",
  "scripts/observer-fault-matrix-support.ts",
  "observer/protocol/fault-matrix.ts",
  "src/foundation/redact.ts",
  "src/foundation/time.ts",
  "src/observer/public-contract.ts",
  "src/observer/application.ts",
  "src/observer/capture-service.ts",
  "src/observer/evidence-run-service.ts",
  "src/observer/launch.ts",
  "src/observer/owned-runtime-manager.ts",
  "src/workbench/child-supervisor.ts",
  "src/workbench/process-guard.ts",
] as const;
export const OBSERVER_OPERATIONAL_BASELINE_SOURCE_CLOSURES = [
  { path: "dist/observer/agent/**/*.js", directory: "dist/observer/agent", extension: ".js" },
  { path: "dist/observer/protocol/**/*.js", directory: "dist/observer/protocol", extension: ".js" },
  { path: "observer/addon/**/*.c", directory: "observer/addon", extension: ".c" },
  { path: "observer/agent/**/*.ts", directory: "observer/agent", extension: ".ts" },
  { path: "observer/protocol/**/*.ts", directory: "observer/protocol", extension: ".ts" },
  { path: "src/**/*.ts", directory: "src", extension: ".ts" },
] as const;
export const PRIVATE_CHILD_PATH = join(
  REPOSITORY_ROOT,
  "dist",
  "observer",
  "agent",
  "private-child.js"
);
export const OBSERVER_SOURCE_PATH = join(REPOSITORY_ROOT, "observer", "addon");
export const RUNTIME_FIXTURE_SOURCE_EXTENSIONS = [
  ".c", ".conf", ".ent", ".gproj", ".json", ".layer", ".layout", ".meta",
] as const;

export interface AddonFixture {
  addonDirectory: string;
  addonSearchRoot: string;
  addonId: string;
  addonGuid: string;
  gprojPath: string;
}

export interface RuntimeRestorationImageDiagnostic {
  acceptanceRole: "diagnostic-only";
  reason: string;
  comparison: PngComparisonEvidence;
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

export function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function comparisonPath(path: string): string {
  const resolved = resolve(path);
  return resolved.toLowerCase();
}

export function contained(root: string, candidate: string): boolean {
  const rel = relative(comparisonPath(root), comparisonPath(candidate));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function canonicalDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`${label} is missing: ${absolute}`);
  const entry = lstatSync(absolute);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory: ${absolute}`);
  }
  return realpathSync.native(absolute);
}

export function canonicalFile(path: string, label: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`${label} is missing: ${absolute}`);
  const entry = lstatSync(absolute);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink file: ${absolute}`);
  }
  return realpathSync.native(absolute);
}

function assertExternalRoot(path: string, label: string): void {
  const repository = realpathSync.native(REPOSITORY_ROOT);
  if (contained(repository, path) || contained(path, repository)) {
    throw new Error(`${label} must not overlap the repository`);
  }
}

export function resolveRuntimeAcceptanceArtifactRoot(explicit?: string): string {
  const label = "Runtime observer acceptance artifact root";
  if (explicit) {
    // Explicit roots must already exist. Do not create an unchecked path and
    // only then discover that it overlaps a worktree.
    const root = canonicalDirectory(explicit, label);
    assertExternalRoot(root, label);
    return root;
  }
  const defaultRoot = join(tmpdir(), "reforger-forge-runtime-observer-acceptance");
  mkdirSync(defaultRoot, { recursive: true });
  const root = canonicalDirectory(defaultRoot, label);
  assertExternalRoot(root, label);
  return root;
}

export function boundedText(value: string, label: string, maximum = 32_768): string {
  const result = value.trim();
  if (!result || result.length > maximum || /[\0\r\n]/.test(result)) {
    throw new Error(`${label} is empty, too long, or contains a control character`);
  }
  return result;
}

export function assertLiveRuntimeObserverAuthorized(
  confirmed: boolean,
  environment: NodeJS.ProcessEnv = process.env
): void {
  if (!confirmed) {
    throw new Error("Live runtime observer acceptance requires --confirm-live-run");
  }
  if (environment[LIVE_RUNTIME_OBSERVER_ENVIRONMENT] !== "1") {
    throw new Error(
      `Live runtime observer acceptance requires ${LIVE_RUNTIME_OBSERVER_ENVIRONMENT}=1`
    );
  }
}

export function assertArmaVacant(stage: string): void {
  const blockers = inspectBlockingProcesses();
  if (blockers.length > 0) {
    throw new Error(
      `${stage} requires all Arma Reforger and Workbench processes to be absent: ` +
      blockers.map((entry) => `${entry.processName} (${entry.id})`).join(", ")
    );
  }
}

function parseGprojValue(source: string, name: "ID" | "GUID"): string | null {
  const quoted = new RegExp(`(?:^|\\s)${name}\\s+\"([^\"]+)\"`, "m").exec(source)?.[1];
  if (quoted) return quoted;
  return new RegExp(`(?:^|\\s)${name}\\s+([^\\s{}]+)`, "m").exec(source)?.[1] ?? null;
}

export function inspectAddonFixture(input: string | undefined): AddonFixture | null {
  if (!input) return null;
  const addonDirectory = canonicalDirectory(input, "Runtime acceptance addon directory");
  const projects = readdirSync(addonDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".gproj"));
  if (projects.length !== 1) {
    throw new Error("Runtime acceptance addon directory must contain exactly one .gproj file");
  }
  const gprojPath = canonicalFile(join(addonDirectory, projects[0].name), "Runtime acceptance .gproj");
  const source = readFileSync(gprojPath, "utf8");
  const addonId = parseGprojValue(source, "ID");
  const addonGuid = parseGprojValue(source, "GUID");
  if (!addonId || !/^[A-Za-z0-9._-]{1,128}$/.test(addonId)) {
    throw new Error("Runtime acceptance .gproj has no bounded addon ID");
  }
  if (!addonGuid || !/^[A-Fa-f0-9]{16}$/.test(addonGuid)) {
    throw new Error("Runtime acceptance .gproj has no 16-hex addon GUID");
  }
  return {
    addonDirectory,
    addonSearchRoot: canonicalDirectory(dirname(addonDirectory), "Runtime acceptance addon search root"),
    addonId,
    addonGuid: addonGuid.toUpperCase(),
    gprojPath,
  };
}

export function findRuntimeExecutable(
  explicit: string | undefined,
  configPath: string
): string {
  const gameRoot = canonicalDirectory(
    loadConfig(["--config", configPath]).gamePath,
    "Arma Reforger game directory"
  );
  if (explicit) return canonicalFile(explicit, "Arma Reforger graphical runtime executable");
  const candidates = [
    join(gameRoot, "ArmaReforgerSteamDiag.exe"),
    join(gameRoot, "ArmaReforgerDiag.exe"),
  ];
  const candidate = candidates.find((path) => existsSync(path));
  if (!candidate) {
    throw new Error(
      "No graphical Diag runtime executable was found; provide --executable explicitly"
    );
  }
  return canonicalFile(candidate, "Arma Reforger graphical Diag executable");
}

export function launchArguments(
  worldResource: string,
  fixture: AddonFixture | null,
  additional: string[] | undefined
): string[] {
  const result = [
    "-window",
    "-screenWidth", "1280",
    "-screenHeight", "720",
    "-noSplash",
    "-noThrow",
    "-disableCrashReporter",
    "-server", worldResource,
  ];
  if (fixture) {
    result.push("-addonsDir", fixture.addonSearchRoot, "-addons", fixture.addonGuid);
  }
  for (const token of additional ?? []) {
    if (typeof token !== "string" || token.length < 1 || token.length > 8_192 || /[\0\r\n]/.test(token)) {
      throw new Error("Additional runtime launch arguments must be bounded argument tokens");
    }
    result.push(token);
  }
  return result;
}

export function captureMatrix(
  metadata: Record<string, unknown>,
  label: string
): RuntimeCameraMatrix {
  const actualCamera = record(metadata.actualCamera, `${label} actual camera`);
  const matrix = actualCamera.matrix;
  if (!Array.isArray(matrix) || matrix.length !== 16 || matrix.some((value) =>
    typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`${label} has no finite flat row-major 4x4 actual camera matrix`);
  }
  return matrix as RuntimeCameraMatrix;
}

export function assertMatrixClose(
  expected: RuntimeCameraMatrix,
  actual: RuntimeCameraMatrix,
  tolerance: number,
  label: string
): void {
  for (let index = 0; index < 16; index += 1) {
    if (Math.abs(expected[index] - actual[index]) > tolerance) {
      throw new Error(
        `${label} differs at matrix[${index}]: ` +
        `${expected[index]} != ${actual[index]}`
      );
    }
  }
}

export function runtimePoseMatrix(
  view: Extract<ObserverCaptureView, { kind: "pose" }>
): RuntimeCameraMatrix {
  let [x, y, z, w] = view.orientation;
  const length = Math.hypot(x, y, z, w);
  if (!Number.isFinite(length) || length < 0.000001) {
    throw new Error("Runtime pose orientation is not a finite non-zero quaternion");
  }
  x /= length;
  y /= length;
  z /= length;
  w /= length;
  // Math3D.QuatToMatrix exposes Enfusion transform basis vectors as rows.
  // That is the transpose of the conventional row-major quaternion matrix.
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    view.position[0], view.position[1], view.position[2], 1,
  ];
}

export function assertRequestedPoseRendered(
  metadata: Record<string, unknown>,
  view: Extract<ObserverCaptureView, { kind: "pose" }>,
  matrixTolerance = 0.05,
  fovTolerance = 0.05
): RuntimeCameraMatrix {
  if (!isDeepStrictEqual(metadata.requestedView, view)) {
    throw new Error("Explicit pose metadata does not preserve the exact requested view");
  }
  const actual = captureMatrix(metadata, "Explicit pose capture");
  assertMatrixClose(runtimePoseMatrix(view), actual, matrixTolerance, "Explicit pose rendered matrix");
  if (typeof metadata.actualFov !== "number" ||
      Math.abs(metadata.actualFov - view.fov) > fovTolerance) {
    throw new Error("Explicit pose rendered FOV differs from the requested FOV");
  }
  return actual;
}

export function assertCurrentViewReleasedFromDisplaced(
  displaced: RuntimeCameraMatrix,
  current: RuntimeCameraMatrix,
  minimumPositionDistance = 5
): number {
  const positionDistance = Math.hypot(
    displaced[12] - current[12],
    displaced[13] - current[13],
    displaced[14] - current[14]
  );
  if (!Number.isFinite(positionDistance) || positionDistance < minimumPositionDistance) {
    throw new Error(
      `Post-restoration current camera remains at the displaced position ` +
      `(distance ${positionDistance.toFixed(3)}m)`
    );
  }
  return positionDistance;
}

export function recordRestorationImageSimilarity(
  comparison: PngComparisonEvidence
): RuntimeRestorationImageDiagnostic {
  return {
    acceptanceRole: "diagnostic-only",
    reason:
      "A live current camera may move or rotate naturally between captures; " +
      "acceptance relies on lease restoration and release from the displaced pose.",
    comparison,
  };
}
