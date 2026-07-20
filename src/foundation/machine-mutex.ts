/** Error reported when an already-acquired machine mutex lease is lost. */
export interface MachineMutexLeaseLoss extends Error {
  readonly code?: string;
}

export interface MachineMutexRequest<T> {
  name: string;
  timeoutMs: number;
  action: () => Promise<T>;
  onLeaseLost?: (error: MachineMutexLeaseLoss) => void;
}

/** Machine-wide mutual exclusion independent of process inspection policy. */
export interface MachineMutex {
  withMachineMutex<T>(request: MachineMutexRequest<T>): Promise<T>;
}
