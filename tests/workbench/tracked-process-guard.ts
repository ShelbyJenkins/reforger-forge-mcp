import {
  WorkbenchProcessGuard as RealWorkbenchProcessGuard,
  type WorkbenchProcessGuardOptions,
} from "../../src/workbench/process-guard.js";

const activeGuards = new Set<RealWorkbenchProcessGuard>();

/**
 * Test-only `WorkbenchProcessGuard` that self-registers so its LMDB
 * environments can be closed in `afterEach`, before the temp directory that
 * backs them is removed. Windows refuses to delete a directory containing an
 * open memory-mapped file, so any test that exercises lifecycle/spawn-journal
 * reads or writes must close its guard before `rmSync`.
 */
export class WorkbenchProcessGuard extends RealWorkbenchProcessGuard {
  constructor(options?: WorkbenchProcessGuardOptions) {
    super(options);
    activeGuards.add(this);
  }
}

/** Close every tracked guard constructed since the last call, then forget them. */
export async function closeTrackedWorkbenchProcessGuards(): Promise<void> {
  const guards = [...activeGuards];
  activeGuards.clear();
  await Promise.all(guards.map((guard) => guard.close()));
}
