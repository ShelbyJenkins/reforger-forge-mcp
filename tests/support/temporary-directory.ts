import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export interface TemporaryDirectoryOptions {
  readonly prefix?: string;
}

const DEFAULT_PREFIX = "rfo-test-";

function validatePrefix(prefix: string): string {
  if (
    prefix.length === 0 ||
    prefix === "." ||
    prefix === ".." ||
    prefix.includes("\0") ||
    /[\\/:]/u.test(prefix) ||
    basename(prefix) !== prefix
  ) {
    throw new RangeError("Temporary-directory prefix must be a non-empty name prefix.");
  }
  return prefix;
}

/** Run a test-scoped callback with a unique real directory and clean it up. */
export async function withTemporaryDirectory<T>(
  run: (path: string) => Promise<T> | T,
  options: TemporaryDirectoryOptions = {},
): Promise<T> {
  const prefix = validatePrefix(options.prefix ?? DEFAULT_PREFIX);
  const path = await mkdtemp(join(tmpdir(), prefix));

  let value: T | undefined;
  let bodyError: unknown;
  let bodyFailed = false;
  try {
    value = await run(path);
  } catch (error) {
    bodyFailed = true;
    bodyError = error;
  }

  try {
    await rm(path, { recursive: true, force: true });
  } catch (cleanupError) {
    if (bodyFailed) {
      throw new AggregateError(
        [bodyError, cleanupError],
        "Temporary-directory cleanup failed after the test callback failed.",
      );
    }
    throw cleanupError;
  }

  if (bodyFailed) throw bodyError;
  return value as T;
}
