import { lstatSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

export type WorkbenchObserverArtifactEnvelopeErrorCode =
  | "ARTIFACT_INVALID"
  | "ARTIFACT_TOO_LARGE";

export interface WorkbenchObserverArtifactEnvelopeInput {
  readonly jobId: string;
  readonly profilePath: string;
  readonly artifactLogicalPath: string;
  readonly artifactPath: string;
  readonly artifactBytes: number;
  readonly maxArtifactBytes: number;
}

export type WorkbenchObserverArtifactEnvelopeInspection =
  | {
      readonly ok: true;
      readonly canonicalPath: string;
      readonly info: Stats;
    }
  | {
      readonly ok: false;
      readonly code: WorkbenchObserverArtifactEnvelopeErrorCode;
      readonly message: string;
    };

function normalizePath(value: string): string {
  return resolve(value).toLowerCase();
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function invalid(message: string): WorkbenchObserverArtifactEnvelopeInspection {
  return { ok: false, code: "ARTIFACT_INVALID", message };
}

/**
 * Prove that a handler-reported artifact is the exact bounded regular file for
 * one retained Workbench job. This performs no reads or writes of file content.
 */
export function inspectWorkbenchObserverArtifactEnvelope(
  input: WorkbenchObserverArtifactEnvelopeInput
): WorkbenchObserverArtifactEnvelopeInspection {
  const expectedLogical = `$profile:ReforgerForgeObserver/workbench/${input.jobId}.png`;
  const expectedPhysical = resolve(
    input.profilePath,
    "profile",
    "ReforgerForgeObserver",
    "workbench",
    `${input.jobId}.png`
  );
  if (input.artifactLogicalPath !== expectedLogical || !isAbsolute(input.artifactPath) ||
      basename(input.artifactPath).toLowerCase() !== `${input.jobId.toLowerCase()}.png` ||
      !samePath(input.artifactPath, expectedPhysical)) {
    return invalid("Workbench returned an unexpected generated artifact path");
  }
  const captureDirectory = dirname(input.artifactPath);
  if (basename(captureDirectory).toLowerCase() !== "workbench" ||
      basename(dirname(captureDirectory)).toLowerCase() !== "reforgerforgeobserver") {
    return invalid("Workbench artifact escaped the generated profile capture directory");
  }

  let info: Stats;
  try {
    info = lstatSync(input.artifactPath);
  } catch {
    return invalid("Workbench artifact could not be inspected as a regular file");
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    return invalid("Workbench artifact is not a regular file");
  }
  if (info.size <= 33 || info.size > input.maxArtifactBytes) {
    return {
      ok: false,
      code: "ARTIFACT_TOO_LARGE",
      message: "Workbench artifact is empty or exceeds the reviewed size bound",
    };
  }
  if (input.artifactBytes !== info.size) {
    return invalid("Workbench artifact length changed after stable completion");
  }

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync.native(input.artifactPath);
  } catch {
    return invalid("Workbench artifact could not be canonicalized");
  }
  if (!samePath(canonicalPath, input.artifactPath)) {
    return invalid("Workbench artifact path changed during canonicalization");
  }
  return { ok: true, canonicalPath, info };
}
