export const WORKBENCH_EXISTING_READER_TIMEOUT_MS = 5_000;
export const WORKBENCH_EXISTING_READER_CLEANUP_TIMEOUT_MS = 1_000;
export const WORKBENCH_EXISTING_READER_MAX_OUTPUT_BYTES = 1_500_000;
export const WORKBENCH_EXISTING_READER_MAX_ERROR_BYTES = 8_192;

export type ExistingLifecycleWireRead =
  | { readonly kind: "missing" }
  | { readonly kind: "valid"; readonly state: unknown }
  | {
      readonly kind: "malformed";
      readonly path: string;
      readonly rawSha256: string;
      readonly message: string;
    };

export type ExistingSpawnJournalWireRead =
  | { readonly kind: "missing" }
  | {
      readonly kind: "valid";
      readonly generation: string;
      readonly record: unknown;
    }
  | {
      readonly kind: "malformed";
      readonly path: string;
      readonly rawSha256: string;
      readonly message: string;
    };

export interface WorkbenchExistingLmdbWireSnapshot {
  readonly lifecycle: ExistingLifecycleWireRead;
  readonly journal: ExistingSpawnJournalWireRead;
}

export type WorkbenchExistingLmdbWorkerResponse =
  | {
      readonly ok: true;
      readonly snapshot: WorkbenchExistingLmdbWireSnapshot;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };
