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

interface SupervisedChild {
  child: ChildProcess;
  onError: (error: Error) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/**
 * Keeps process listeners alive for the full child lifetime and removes every
 * terminal child from its registry before durable reconciliation runs.
 */
export class ChildSupervisor {
  private readonly children = new Map<string, SupervisedChild>();

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
      if (callbacks.onExit) report(callbacks.onExit({ code, signal }));
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
    if (!current || (expectedChild && current.child !== expectedChild)) return false;
    this.children.delete(key);
    current.child.off("error", current.onError);
    current.child.off("exit", current.onExit);
    return true;
  }

  has(key: string): boolean {
    return this.children.has(key);
  }

  get size(): number {
    return this.children.size;
  }
}
