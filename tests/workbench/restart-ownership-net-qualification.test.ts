import { afterEach, describe, expect, it } from "vitest";
import { WORKBENCH_HELPER_PING_RESPONSE } from "./fake-companion.js";
import {
  cleanupRestartOwnershipFixtures, createHarness, createRunningHarness, expectRejectedCode,
  refuseEndpointOwnership, republishLifecycleState, type Harness,
} from "./restart-ownership-fixture.js";

afterEach(cleanupRestartOwnershipFixtures);

function permitManagedNetCalls(
  harness: Harness,
  response: Record<string, unknown> = { status: "ok" },
): void {
  harness.netApiCall.mockImplementation(async (api) =>
    api === "EMCP_WB_Ping" ? WORKBENCH_HELPER_PING_RESPONSE : response);
}

describe("managed NET call qualification", () => {
  it("refuses configured NET API calls before touching an unmanaged endpoint", async () => {
    const harness = createHarness();

    await expectRejectedCode(
      harness.client.call("EMCP_WB_ListEntities", {}, { skipAutoLaunch: true }),
      "CONNECTION_REFUSED",
    );
    expect(harness.netApiCall).not.toHaveBeenCalled();
  });

  it("permits calls only after exact lifecycle, process, endpoint, and companion attestation", async () => {
    const { harness } = await createRunningHarness();
    harness.netApiCall.mockClear();
    permitManagedNetCalls(harness, { status: "ok", count: 0 });

    await expect(harness.client.call("EMCP_WB_ListEntities", {}, { skipAutoLaunch: true }))
      .resolves.toMatchObject({ status: "ok", count: 0 });
    expect(harness.netApiCall.mock.calls.map(([api]) => api)).toEqual([
      "EMCP_WB_Ping",
      "EMCP_WB_ListEntities",
    ]);
  });

  it("recomputes the NET timeout after managed-authority prechecks consume budget", async () => {
    let now = 1_000;
    let requestDeadlineAtMs: number | undefined;
    const { harness } = await createRunningHarness({
      now: () => now,
      requestDeadlineAtMs: () => requestDeadlineAtMs,
    });
    harness.netApiCall.mockClear();
    requestDeadlineAtMs = 1_100;
    harness.netApiCall.mockImplementation(async (api) => {
      if (api === "EMCP_WB_Ping") {
        now = 1_080;
        return WORKBENCH_HELPER_PING_RESPONSE;
      }
      return { status: "ok", count: 0 };
    });

    await expect(harness.client.call("EMCP_WB_ListEntities", {}, {
      timeout: 500,
      skipAutoLaunch: true,
    })).resolves.toMatchObject({ status: "ok", count: 0 });

    const targetCall = harness.netApiCall.mock.calls.find(
      ([api]) => api === "EMCP_WB_ListEntities"
    );
    expect(targetCall?.[2]).toEqual({ timeoutMs: 20 });
  });

  it("shares immutable companion attestation across two consumers of one facade/controller", async () => {
    const { harness } = await createRunningHarness();
    const launchAttestations = harness.verifyStaged.mock.calls.length;
    const toolConsumer = harness.client;
    const observerConsumer = harness.client;
    expect(toolConsumer).toBe(observerConsumer);
    permitManagedNetCalls(harness);

    await toolConsumer.call("EMCP_WB_GetState", {}, { skipAutoLaunch: true });
    await observerConsumer.call("EMCP_WB_ListEntities", {}, { skipAutoLaunch: true });
    expect(harness.verifyStaged.mock.calls.length - launchAttestations).toBe(1);

    await republishLifecycleState(harness);
    await harness.client.call("EMCP_WB_GetState", {}, { skipAutoLaunch: true });
    expect(harness.verifyStaged.mock.calls.length - launchAttestations).toBe(2);
  });

  it("invalidates immutable attestation when the recorded bundle digest changes", async () => {
    const { harness } = await createRunningHarness();
    const launchAttestations = harness.verifyStaged.mock.calls.length;
    permitManagedNetCalls(harness);

    await harness.client.call("EMCP_WB_GetState", {}, { skipAutoLaunch: true });
    expect(harness.verifyStaged.mock.calls.length - launchAttestations).toBe(1);

    await republishLifecycleState(harness, (state) => {
      if (!state.companion) throw new Error("missing running companion state");
      return { companion: { ...state.companion, bundleDigest: "b".repeat(64) } };
    });

    await harness.client.call("EMCP_WB_GetState", {}, { skipAutoLaunch: true });
    expect(harness.verifyStaged.mock.calls.length - launchAttestations).toBe(2);
    expect(harness.verifyStaged.mock.calls.at(-1)?.[0]).toMatchObject({
      bundleDigest: "b".repeat(64),
    });
  });

  it("does not cache a failed process or endpoint qualification", async () => {
    const { harness } = await createRunningHarness();
    const launchAttestations = harness.verifyStaged.mock.calls.length;
    refuseEndpointOwnership(harness, "listener temporarily belongs to another process");

    await expectRejectedCode(
      harness.client.call("EMCP_WB_GetState", {}, { skipAutoLaunch: true }),
      "IDENTITY_UNVERIFIABLE",
    );
    harness.backend.endpointOwnershipResult = null;
    await expect(harness.client.call("EMCP_WB_GetState", {}, { skipAutoLaunch: true }))
      .resolves.toMatchObject({ status: "ok" });

    expect(harness.verifyStaged.mock.calls.length - launchAttestations).toBe(2);
  });
});
