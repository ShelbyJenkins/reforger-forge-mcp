import type { ExactProcessIdentity } from "./identity.js";

export interface ExactProcessInspection {
  identity: ExactProcessIdentity;
  ownerArgumentMatched: boolean | null;
}

export type ExactProcessTerminationResult =
  | { kind: "terminated" | "already_exited" }
  | {
      kind: "refused";
      reason:
        | "access_denied"
        | "pid_reused"
        | "executable_mismatch"
        | "creation_time_mismatch"
        | "command_line_unverifiable"
        | "token_mismatch"
        | "timeout"
        | "helper_failure";
      message: string;
    };

export type ExactOwnedProcessIdentity = ExactProcessIdentity & {
  ownerTokenArgument: string;
  launchedAtMs: number;
};

/** Shared exact-process inspection and termination surface. */
export interface ExactProcessBackend {
  readonly platform: "win32" | "test";
  inspectCurrentProcess(pid: number): Promise<ExactProcessIdentity & { userSid: string }>;
  inspectProcess(
    pid: number,
    expectedOwnerTokenArgument?: string
  ): Promise<ExactProcessInspection | null>;
  verifyAndTerminate(
    expected: ExactOwnedProcessIdentity,
    timeoutMs: number
  ): Promise<ExactProcessTerminationResult>;
}
