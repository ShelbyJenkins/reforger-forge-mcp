export type PackedArchiveInspectionErrorCode =
  | "INVALID_OPTIONS"
  | "UNSAFE_TARBALL_PATH"
  | "INVALID_ENTRY_PATH"
  | "INVALID_ENTRY_TYPE"
  | "INVALID_ENTRY_SIZE"
  | "DUPLICATE_ENTRY_PATH"
  | "TEXT_ENTRY_TOO_LARGE"
  | "INVALID_TEXT_ENCODING"
  | "MISSING_TEXT_ENTRY"
  | "ARCHIVE_READ_FAILED";

export class PackedArchiveInspectionError extends Error {
  readonly code: PackedArchiveInspectionErrorCode;
}

export interface PackedArchiveFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface PackedArchiveInspection {
  readonly tarballPath: string;
  readonly packagePrefix: string;
  readonly files: ReadonlyMap<string, PackedArchiveFile>;
  readonly textEntries: ReadonlyMap<string, string>;
}

export interface PackedArchiveInspectionOptions {
  readonly tarballPath: string;
  readonly tarballRoot: string;
  readonly packagePrefix?: string;
  readonly maximumEntryBytes: number;
  readonly textEntries?: readonly string[];
}

export function inspectPackedArchive(
  options: PackedArchiveInspectionOptions
): Promise<PackedArchiveInspection>;

export interface PackedTextEntryOptions extends PackedArchiveInspectionOptions {
  readonly entryPath: string;
}

export function readPackedTextEntry(options: PackedTextEntryOptions): Promise<string>;
