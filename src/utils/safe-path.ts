import { resolve } from "node:path";
import { resolveManagedPath } from "../foundation/managed-path.js";

/**
 * Validate that a user-supplied name is safe for use as a filename.
 * Rejects path traversal, path separators, and OS-reserved characters.
 */
export function validateFilename(name: string): void {
  if (!name || name.trim().length === 0) {
    throw new Error("Filename must not be empty");
  }

  if (name.includes("..")) {
    throw new Error("Filename must not contain '..'");
  }

  if (/[/\\]/.test(name)) {
    throw new Error("Filename must not contain path separators (/ or \\)");
  }

  // Windows reserved characters: < > : " | ? *
  if (/[<>:"|?*]/.test(name)) {
    throw new Error("Filename contains invalid characters");
  }

  // Windows reserved names
  const reserved = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\.|$)/i;
  if (reserved.test(name)) {
    throw new Error(`Filename uses reserved name: ${name}`);
  }
}

/**
 * Validate that a name is a valid Enforce Script identifier.
 * Must start with a letter or underscore, followed by letters, digits, or underscores.
 */
export function validateEnforceIdentifier(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      "Must be a valid Enforce identifier (letters, digits, underscores only, must start with a letter or underscore)"
    );
  }
}

/**
 * Validate that a resolved path stays within the base directory.
 * Combines validateFilename + lexical traversal checking. Project directories
 * are user-owned rather than an adversarial private store, so links inside a
 * project remain intentionally supported here.
 */
export function safePath(basePath: string, ...segments: string[]): string {
  for (const seg of segments) {
    validateFilename(seg);
  }

  const normalizedBase = resolve(basePath);
  const resolved = resolve(normalizedBase, ...segments);

  try {
    return resolveManagedPath(normalizedBase, resolved, "lexical");
  } catch {
    throw new Error("Path traversal not allowed: resolved path is outside project");
  }
}

/**
 * Validate a relative sub-path (which may contain slashes) stays within the base directory.
 * Used by the `project` tool actions for user-supplied relative paths.
 */
export function validateProjectPath(basePath: string, subPath: string): string {
  if (subPath.includes("..")) {
    throw new Error("Path traversal not allowed: '..' segments are blocked");
  }

  const normalizedBase = resolve(basePath);
  const resolved = resolve(normalizedBase, subPath);

  try {
    return resolveManagedPath(normalizedBase, resolved, "lexical");
  } catch {
    throw new Error("Path traversal not allowed: resolved path is outside project");
  }
}
