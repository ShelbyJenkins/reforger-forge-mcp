export interface PackagedAddonInventoryOptions {
  readonly manifestName: string;
  readonly displayName: string;
  readonly role?: string;
  readonly allowedGeneratedFiles?: ReadonlySet<string>;
}

export interface PackagedAddonManifest {
  readonly manifestVersion: 1;
  readonly role?: string;
  readonly bundleDigest: string;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
}

export function verifyPackagedAddonInventory(
  directory: string,
  options: PackagedAddonInventoryOptions
): PackagedAddonManifest;

export const MAX_SOURCE_MANIFEST_BYTES: number;

export function validateAddonSourceManifest(
  value: unknown,
  options: PackagedAddonInventoryOptions
): PackagedAddonManifest;

export interface PackedArchiveFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface PackedArchiveInventory {
  readonly packagePrefix: string;
  readonly files: ReadonlyMap<string, PackedArchiveFile>;
  readonly textEntries: ReadonlyMap<string, string>;
}

export interface PackedArchiveAddonInventoryOptions extends PackagedAddonInventoryOptions {
  readonly addonRoot: string;
}

export function verifyPackedArchiveAddonInventory(
  archive: PackedArchiveInventory,
  options: PackedArchiveAddonInventoryOptions
): PackagedAddonManifest;
