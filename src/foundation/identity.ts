/**
 * Exact operating-system identity for a process.
 *
 * A PID is not sufficient because it can be reused. On Windows, creationTime
 * is the exact decimal FILETIME captured from an opened process handle.
 */
export interface ExactProcessIdentity {
  pid: number;
  executablePath: string;
  creationTime: string;
}
