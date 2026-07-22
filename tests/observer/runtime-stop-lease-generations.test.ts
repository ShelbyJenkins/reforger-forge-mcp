import { describe, expect, it } from "vitest";
import {
  claimRuntimeStopReservation,
  releaseRuntimeStopReservation,
  runtimeStopObligations,
} from "../../observer/agent/private-child.js";

describe("observer runtime-stop lease generations", () => {
  it("keeps caller proposals exclusive and rejects delayed stale releases", () => {
    const reservations = new Map<string, string>();
    const sessionId = "session-lease";
    const first = "00000000-0000-4000-8000-000000000001";
    const second = "00000000-0000-4000-8000-000000000002";

    expect(claimRuntimeStopReservation(reservations, sessionId, first)).toEqual({
      reserved: true,
      reservationId: first,
      created: true,
    });
    expect(claimRuntimeStopReservation(reservations, sessionId, first)).toEqual({
      reserved: true,
      reservationId: first,
      created: false,
    });
    expect(claimRuntimeStopReservation(reservations, sessionId, second)).toEqual({
      reserved: false,
      created: false,
    });
    expect(releaseRuntimeStopReservation(reservations, sessionId, second)).toBe(false);
    expect(releaseRuntimeStopReservation(reservations, sessionId, first)).toBe(true);
    expect(claimRuntimeStopReservation(reservations, sessionId, second)).toMatchObject({
      reserved: true,
      reservationId: second,
    });
    expect(releaseRuntimeStopReservation(reservations, sessionId, first)).toBe(false);
    expect(reservations.get(sessionId)).toBe(second);
  });

  it("ignores stale terminal heartbeat IDs while retaining authoritative restoration work", () => {
    const obligations = runtimeStopObligations([
      {
        jobId: "job-terminal",
        state: "completed",
        cameraLease: { everHeld: true, held: false, restorationConfirmed: true },
      },
      {
        jobId: "job-restoring",
        state: "restoring",
        cameraLease: { everHeld: true, held: false, restorationConfirmed: false },
      },
    ], [
      { activeJobId: "job-terminal", cameraLeaseJobId: "job-terminal" },
      { activeJobId: "job-restoring", cameraLeaseJobId: "job-restoring" },
    ], new Set(["job-restoring"]));

    expect(obligations).toEqual({
      activeJobIds: ["job-restoring"],
      cameraLeaseJobIds: ["job-restoring"],
      restorationPendingJobIds: ["job-restoring"],
    });
  });
});

