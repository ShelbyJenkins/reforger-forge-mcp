/** Error reported when an already-acquired machine mutex lease is lost. */
export interface MachineMutexLeaseLoss extends Error {
  readonly code?: string;
}

export interface MachineMutexRequest<T> {
  name: string;
  timeoutMs: number;
  action: () => Promise<T>;
  /**
   * Synchronously revoke the protected action's mutation authority if the
   * already-acquired native lease disappears. Backends may return a structured
   * lease-loss error only when this fence is present; otherwise they must
   * fail-stop the process because the action can continue without exclusion.
   */
  onLeaseLost?: (error: MachineMutexLeaseLoss) => void;
}

/** Machine-wide mutual exclusion independent of process inspection policy. */
export interface MachineMutex {
  withMachineMutex<T>(request: MachineMutexRequest<T>): Promise<T>;
}
