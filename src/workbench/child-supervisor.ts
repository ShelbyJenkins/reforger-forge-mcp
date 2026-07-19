import type { ChildProcess } from "node:child_process";

export interface SupervisedChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ChildSupervisorCallbacks {
  onError?: (error: Error) => void | Promise<void>;
  onExit?: (exit: SupervisedChildExit) => void | Promise<void>;
  onCallbackError?: (error: unknown) => void;
}

export interface ChildSupervisorOptions {
  /** Total attempts for a failed terminal reconciliation, including the first. */
  reconciliationAttempts?: number;
  reconciliationRetryMs?: number;
}

export interface SupervisedChildCounts {
  /** Children whose terminal event has not yet been observed. */
  active: number;
  /** Terminal children whose durable exit callback is still reconciling. */
  reconciling: number;
  total: number;
}

interface SupervisedChild {
  child: ChildProcess;
  onError: (error: Error) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

interface PendingReconciliation {
  readonly token: object;
  timer: NodeJS.Timeout | null;
}

/**
 * Keeps process listeners alive for the full child lifetime and removes every
 * terminal child from its registry before durable reconciliation runs.
 */
export class ChildSupervisor {
  private readonly children = new Map<string, SupervisedChild>();
  private readonly reconciliations = new Map<string, PendingReconciliation>();
  private readonly reconciliationAttempts: number;
  private readonly reconciliationRetryMs: number;

  constructor(options: ChildSupervisorOptions = {}) {
    this.reconciliationAttempts = options.reconciliationAttempts ?? 3;
    this.reconciliationRetryMs = options.reconciliationRetryMs ?? 100;
    if (!Number.isSafeInteger(this.reconciliationAttempts) || this.reconciliationAttempts < 1 ||
        this.reconciliationAttempts > 100) {
      throw new TypeError("Child reconciliation attempts must be an integer from 1 through 100.");
    }
    if (!Number.isSafeInteger(this.reconciliationRetryMs) || this.reconciliationRetryMs < 0 ||
        this.reconciliationRetryMs > 60_000) {
      throw new TypeError("Child reconciliation retry delay must be an integer from 0 through 60000ms.");
    }
  }

  supervise(key: string, child: ChildProcess, callbacks: ChildSupervisorCallbacks = {}): void {
    this.forget(key);
    const report = (work: void | Promise<void>): void => {
      void Promise.resolve(work).catch((error) => callbacks.onCallbackError?.(error));
    };
    const onError = (error: Error): void => {
      if (this.children.get(key)?.child !== child) return;
      if (callbacks.onError) report(callbacks.onError(error));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const current = this.children.get(key);
      if (!current || current.child !== child) return;
      this.children.delete(key);
      child.off("error", onError);
      child.off("exit", onExit);
      if (callbacks.onExit) {
        this.beginExitReconciliation(key, callbacks, { code, signal });
      }
    };
    this.children.set(key, { child, onError, onExit });
    child.on("error", onError);
    child.on("exit", onExit);
    if (child.exitCode != null || child.signalCode != null) {
      queueMicrotask(() => onExit(child.exitCode ?? null, child.signalCode ?? null));
    }
  }

  forget(key: string, expectedChild?: ChildProcess): boolean {
    const current = this.children.get(key);
    if (!current || (expectedChild && current.child !== expectedChild)) {
      if (!expectedChild) this.cancelReconciliation(key);
      return false;
    }
    this.children.delete(key);
    current.child.off("error", current.onError);
    current.child.off("exit", current.onExit);
    this.cancelReconciliation(key);
    return true;
  }

  has(key: string): boolean {
    return this.children.has(key);
  }

  get size(): number {
    return this.children.size;
  }

  get reconciliationSize(): number {
    return this.reconciliations.size;
  }

  /** Bounded count-only snapshot for diagnostics and controlled acceptance evidence. */
  counts(): SupervisedChildCounts {
    const active = this.children.size;
    const reconciling = this.reconciliations.size;
    return { active, reconciling, total: active + reconciling };
  }

  private beginExitReconciliation(
    key: string,
    callbacks: ChildSupervisorCallbacks,
    exit: SupervisedChildExit
  ): void {
    this.cancelReconciliation(key);
    const pending: PendingReconciliation = { token: {}, timer: null };
    this.reconciliations.set(key, pending);
    void this.runExitReconciliation(key, pending, callbacks, exit, 1);
  }

  private async runExitReconciliation(
    key: string,
    pending: PendingReconciliation,
    callbacks: ChildSupervisorCallbacks,
    exit: SupervisedChildExit,
    attempt: number
  ): Promise<void> {
    if (this.reconciliations.get(key)?.token !== pending.token || !callbacks.onExit) return;
    try {
      await callbacks.onExit(exit);
      if (this.reconciliations.get(key)?.token === pending.token) {
        this.reconciliations.delete(key);
      }
    } catch (error) {
      try { callbacks.onCallbackError?.(error); } catch { /* diagnostics cannot disable retry */ }
      if (this.reconciliations.get(key)?.token !== pending.token) return;
      if (attempt >= this.reconciliationAttempts) {
        this.reconciliations.delete(key);
        return;
      }
      pending.timer = setTimeout(() => {
        pending.timer = null;
        void this.runExitReconciliation(key, pending, callbacks, exit, attempt + 1);
      }, this.reconciliationRetryMs);
      pending.timer.unref?.();
    }
  }

  private cancelReconciliation(key: string): void {
    const pending = this.reconciliations.get(key);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.reconciliations.delete(key);
  }
}
