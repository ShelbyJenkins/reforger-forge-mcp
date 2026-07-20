export interface PackagedAddonInventoryOptions {
  readonly manifestName: string;
  readonly displayName: string;
  readonly role?: string;
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
