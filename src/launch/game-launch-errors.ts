import { isAbsolute } from "node:path";
import { renderRedactedPublicJson } from "../foundation/public-json.js";
import { redactDiagnostic, redactText } from "../foundation/redact.js";

export const PUBLIC_GAME_LAUNCH_ERROR_TEXT_MAXIMUM = 512;

export type GameLaunchPlanErrorCode =
  | "PROJECT_REQUIRED"
  | "PROJECT_INVALID"
  | "PROJECT_CHANGED"
  | "WORLD_REQUIRED"
  | "WORLD_NOT_FOUND"
  | "WORLD_INVALID"
  | "WORLD_OUTSIDE_PROJECT"
  | "WORLD_GUID_MISMATCH"
  | "WORLD_UNREGISTERED"
  | "WORLD_METADATA_MISSING"
  | "WORLD_METADATA_UNREADABLE"
  | "WORLD_METADATA_OVERSIZE"
  | "WORLD_METADATA_MALFORMED"
  | "WORLD_AMBIGUOUS"
  | "WORLD_SCAN_TRUNCATED"
  | "WORLD_SCAN_UNSTABLE"
  | "WORLD_CHANGED"
  | "WORLD_EVIDENCE_INVALID"
  | "ADDON_DEPENDENCY_MALFORMED"
  | "ADDON_MANIFEST_UNREADABLE"
  | "ADDON_MANIFEST_MALFORMED"
  | "ADDON_MANIFEST_OVERSIZE"
  | "ADDON_ROOT_UNREADABLE"
  | "ADDON_ROOT_CONFLICT"
  | "ADDON_SCAN_TRUNCATED"
  | "ADDON_SCAN_UNSTABLE"
  | "ADDON_DEPENDENCY_MISSING"
  | "ADDON_DEPENDENCY_AMBIGUOUS"
  | "ADDON_TARGET_COLLISION"
  | "ADDON_CHANGED"
  | "ADDON_EVIDENCE_INVALID"
  | "EXECUTABLE_CHANGED"
  | "EXECUTABLE_EVIDENCE_INVALID"
  | "ARGUMENT_CONFLICT";

export type GameWorldRegistrationStatus =
  | "registered"
  | "unregistered"
  | "metadata_unreadable"
  | "metadata_oversize"
  | "metadata_malformed";

export interface GameWorldDiagnosticCandidate {
  readonly path: string;
  readonly status: GameWorldRegistrationStatus;
}

export interface RegisterWorldRemedy {
  readonly kind: "register_world";
  readonly projectPath: string;
  readonly worldPath: string;
}

export type GameLaunchPlanRemedy = RegisterWorldRemedy;

export interface GameLaunchPlanErrorOptions {
  readonly details?: unknown;
  readonly candidates?: readonly GameWorldDiagnosticCandidate[];
  readonly remedy?: GameLaunchPlanRemedy;
  readonly cause?: unknown;
}

const GAME_ERROR_CODES = new Set<GameLaunchPlanErrorCode>([
  "PROJECT_REQUIRED",
  "PROJECT_INVALID",
  "PROJECT_CHANGED",
  "WORLD_REQUIRED",
  "WORLD_NOT_FOUND",
  "WORLD_INVALID",
  "WORLD_OUTSIDE_PROJECT",
  "WORLD_GUID_MISMATCH",
  "WORLD_UNREGISTERED",
  "WORLD_METADATA_MISSING",
  "WORLD_METADATA_UNREADABLE",
  "WORLD_METADATA_OVERSIZE",
  "WORLD_METADATA_MALFORMED",
  "WORLD_AMBIGUOUS",
  "WORLD_SCAN_TRUNCATED",
  "WORLD_SCAN_UNSTABLE",
  "WORLD_CHANGED",
  "WORLD_EVIDENCE_INVALID",
  "ADDON_DEPENDENCY_MALFORMED",
  "ADDON_MANIFEST_UNREADABLE",
  "ADDON_MANIFEST_MALFORMED",
  "ADDON_MANIFEST_OVERSIZE",
  "ADDON_ROOT_UNREADABLE",
  "ADDON_ROOT_CONFLICT",
  "ADDON_SCAN_TRUNCATED",
  "ADDON_SCAN_UNSTABLE",
  "ADDON_DEPENDENCY_MISSING",
  "ADDON_DEPENDENCY_AMBIGUOUS",
  "ADDON_TARGET_COLLISION",
  "ADDON_CHANGED",
  "ADDON_EVIDENCE_INVALID",
  "EXECUTABLE_CHANGED",
  "EXECUTABLE_EVIDENCE_INVALID",
  "ARGUMENT_CONFLICT",
]);

const REGISTRATION_STATUSES = new Set<GameWorldRegistrationStatus>([
  "registered",
  "unregistered",
  "metadata_unreadable",
  "metadata_oversize",
  "metadata_malformed",
]);

const MAXIMUM_CANDIDATES = 16;
const MAXIMUM_CANDIDATE_PATH_LENGTH = 256;
const JSON_FENCE_PREFIX = "\n\n```json\n";
const JSON_FENCE_SUFFIX = "\n```";
const INTERNAL_ERROR = "Game launch error (INTERNAL_ERROR): Game launch planning failed.";

function validCandidate(value: GameWorldDiagnosticCandidate): GameWorldDiagnosticCandidate | null {
  if (!value || typeof value !== "object" ||
      typeof value.path !== "string" || value.path.length === 0 ||
      value.path.length > MAXIMUM_CANDIDATE_PATH_LENGTH || /[\0\r\n]/.test(value.path) ||
      !REGISTRATION_STATUSES.has(value.status)) return null;
  return Object.freeze({ path: value.path, status: value.status });
}

function freezeCandidates(
  values: readonly GameWorldDiagnosticCandidate[] | undefined,
): readonly GameWorldDiagnosticCandidate[] {
  if (values === undefined) return Object.freeze([]);
  const result: GameWorldDiagnosticCandidate[] = [];
  for (const value of values.slice(0, MAXIMUM_CANDIDATES)) {
    const candidate = validCandidate(value);
    if (candidate) result.push(candidate);
  }
  return Object.freeze(result);
}

function freezeRemedy(value: GameLaunchPlanRemedy | undefined): GameLaunchPlanRemedy | undefined {
  if (value === undefined) return undefined;
  if (value.kind !== "register_world" ||
      typeof value.projectPath !== "string" || !isAbsolute(value.projectPath) ||
      typeof value.worldPath !== "string" || !isAbsolute(value.worldPath) ||
      /[\0\r\n]/.test(value.projectPath) || /[\0\r\n]/.test(value.worldPath)) {
    throw new TypeError("Game launch registration remedy is invalid.");
  }
  return Object.freeze({
    kind: "register_world",
    projectPath: value.projectPath,
    worldPath: value.worldPath,
  });
}

/** A trusted planning refusal. Public callers must still use the projector. */
export class GameLaunchPlanError extends Error {
  readonly details: unknown;
  readonly candidates: readonly GameWorldDiagnosticCandidate[];
  readonly remedy: GameLaunchPlanRemedy | undefined;

  constructor(
    public readonly code: GameLaunchPlanErrorCode,
    message: string,
    options: GameLaunchPlanErrorOptions = {},
  ) {
    if (!GAME_ERROR_CODES.has(code)) throw new TypeError("Game launch error code is invalid.");
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GameLaunchPlanError";
    this.details = options.details;
    this.candidates = freezeCandidates(options.candidates);
    this.remedy = freezeRemedy(options.remedy);
  }
}

function registrationRemedyText(remedy: GameLaunchPlanRemedy | undefined): string {
  if (!remedy) return "";
  const project = JSON.stringify(remedy.projectPath);
  const input = JSON.stringify({ action: "register", path: remedy.worldPath });
  return `\nNext action: open project ${project} if needed, then call wb_resources ${input}.`;
}

function header(error: GameLaunchPlanError, maximum: number): string {
  const prefix = `Game launch error (${error.code}): `;
  if (maximum <= prefix.length) return prefix.slice(0, Math.max(0, maximum));
  const diagnostic = redactText(error.message, {
    profile: "diagnostic",
    maxLength: PUBLIC_GAME_LAUNCH_ERROR_TEXT_MAXIMUM,
  }).trim() || "Game launch planning failed.";
  return `${prefix}${diagnostic.slice(0, maximum - prefix.length)}`;
}

function publicDetails(error: GameLaunchPlanError): unknown {
  if (error.candidates.length === 0) return error.details;
  return error.details === undefined
    ? { candidates: error.candidates }
    : { candidates: error.candidates, details: error.details };
}

/**
 * Render one trusted planning error. Unknown values and prototype-free spoofs
 * collapse to a fixed internal refusal; arbitrary caller codes are never used.
 */
export function projectPublicGameLaunchPlanError(error: unknown): string {
  if (!(error instanceof GameLaunchPlanError) || !GAME_ERROR_CODES.has(error.code)) {
    return INTERNAL_ERROR;
  }
  try {
    const remedy = registrationRemedyText(error.remedy);
    if (remedy.length >= PUBLIC_GAME_LAUNCH_ERROR_TEXT_MAXIMUM) return INTERNAL_ERROR;
    const renderedHeader = header(
      error,
      PUBLIC_GAME_LAUNCH_ERROR_TEXT_MAXIMUM - remedy.length,
    );
    const details = publicDetails(error);
    if (details === undefined) return `${renderedHeader}${remedy}`;

    const available = PUBLIC_GAME_LAUNCH_ERROR_TEXT_MAXIMUM -
      renderedHeader.length - remedy.length - JSON_FENCE_PREFIX.length - JSON_FENCE_SUFFIX.length;
    if (available < 2) return `${renderedHeader}${remedy}`;
    const rendered = renderRedactedPublicJson(
      redactDiagnostic(details, { profile: "diagnostic" }),
      {
        maximumDepth: 6,
        maximumBreadth: 24,
        maximumNodes: 128,
        maximumStringLength: 256,
        maximumCharacters: available,
      },
    );
    if (rendered.fallback) return INTERNAL_ERROR;
    if (rendered.text === undefined) return `${renderedHeader}${remedy}`;
    const result = `${renderedHeader}${JSON_FENCE_PREFIX}${rendered.text}${JSON_FENCE_SUFFIX}${remedy}`;
    return result.length <= PUBLIC_GAME_LAUNCH_ERROR_TEXT_MAXIMUM ? result : INTERNAL_ERROR;
  } catch {
    return INTERNAL_ERROR;
  }
}
