import {
  pollUntil,
  type Clock,
  type Deadline,
  type PollResult,
  type Sleeper,
} from "../../src/foundation/time.js";

export interface WaitForValueOptions<T> {
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  readonly deadline: Deadline;
  readonly intervalMs: number;
  readonly signal?: AbortSignal;
  readonly probe: () => T | undefined | Promise<T | undefined>;
}

/** Test-facing spelling for the single foundation polling contract. */
export function waitForValue<T>(options: WaitForValueOptions<T>): Promise<PollResult<T>> {
  return pollUntil({
    clock: options.clock,
    sleeper: options.sleeper,
    deadline: options.deadline,
    intervalMs: options.intervalMs,
    signal: options.signal,
    probe: async () => options.probe(),
  });
}
