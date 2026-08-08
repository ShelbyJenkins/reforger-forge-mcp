import { join } from "node:path";
import { encodeDurableKey, jsonDurableRecordCodec } from "../foundation/durable-kv.js";
import { LmdbCasStore } from "../foundation/lmdb-cas-store.js";
import { LmdbEnvironment } from "../foundation/lmdb-store.js";
import {
  parseLifecycleState,
  parseWorkbenchSpawnJournalState,
} from "./process-guard.js";
import type { WorkbenchExistingLmdbWorkerResponse } from "./existing-lmdb-reader-protocol.js";

const MAX_LIFECYCLE_STATE_BYTES = 1024 * 1024;
const MAX_SPAWN_JOURNAL_BYTES = 256 * 1024;
const stateDir = process.argv[2];

function boundedMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.slice(0, 4_096) || "Existing-only Workbench LMDB reader failed.";
}

function emit(response: WorkbenchExistingLmdbWorkerResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

if (!stateDir) {
  emit({ ok: false, error: "Existing-only Workbench LMDB reader requires a state directory." });
  process.exitCode = 2;
} else {
  const environment = new LmdbEnvironment(stateDir);
  const corruptDir = join(stateDir, "corrupt");
  const lifecycle = new LmdbCasStore({
    storageRoot: stateDir,
    environment,
    key: encodeDurableKey("workbench", "lifecycle"),
    recordLabel: "lifecycle",
    schema: "workbench-lifecycle-v3",
    maxRecordBytes: MAX_LIFECYCLE_STATE_BYTES,
    corruptArchiveDir: corruptDir,
    codec: jsonDurableRecordCodec((value) => {
      const parsed = parseLifecycleState(value);
      if (!parsed) throw new TypeError("Lifecycle state does not satisfy the strict version-3 schema.");
      return parsed;
    }),
    generationOf: (state) => state.generation,
  });
  const journal = new LmdbCasStore({
    storageRoot: stateDir,
    environment,
    key: encodeDurableKey("workbench", "spawn-journal"),
    recordLabel: "spawn-journal",
    schema: "workbench-spawn-journal-v3",
    maxRecordBytes: MAX_SPAWN_JOURNAL_BYTES,
    corruptArchiveDir: corruptDir,
    codec: jsonDurableRecordCodec(parseWorkbenchSpawnJournalState),
    generationOf: (state) => state.generation,
  });
  try {
    const lifecycleExisting = await lifecycle.inspectExisting({ retainOpen: true });
    const journalExisting = await journal.inspectExisting({ retainOpen: true });
    const lifecycleRead = lifecycleExisting.kind === "missing" || lifecycleExisting.value.kind === "missing"
      ? { kind: "missing" as const }
      : lifecycleExisting.value.kind === "versioned"
        ? { kind: "valid" as const, state: lifecycleExisting.value.value }
        : {
            kind: "malformed" as const,
            path: lifecycleExisting.value.path,
            rawSha256: lifecycleExisting.value.rawSha256,
            message: lifecycleExisting.value.message,
          };
    const journalRead = journalExisting.kind === "missing" || journalExisting.value.kind === "missing"
      ? { kind: "missing" as const }
      : journalExisting.value.kind === "versioned"
        ? {
            kind: "valid" as const,
            generation: journalExisting.value.generation,
            record: journalExisting.value.value.record,
          }
        : {
            kind: "malformed" as const,
            path: journalExisting.value.path,
            rawSha256: journalExisting.value.rawSha256,
            message: journalExisting.value.message,
          };
    emit({ ok: true, snapshot: { lifecycle: lifecycleRead, journal: journalRead } });
  } catch (error) {
    emit({ ok: false, error: boundedMessage(error) });
  } finally {
    await environment.close();
  }
}

