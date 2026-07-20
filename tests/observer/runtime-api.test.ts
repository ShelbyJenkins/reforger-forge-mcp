import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createObserverApplication } from "../../observer/agent/application.js";
import { probeAgentLease } from "../../observer/agent/control-api.js";
import { requestObserverControl } from "../../observer/agent/control-client.js";
import { observerAddonSource } from "../support/observer-fixtures.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

async function post(url: string, body: unknown, token?: string) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

describe("observer runtime HTTP API", () => {
  it("binds ephemerally to loopback and isolates runtime from control credentials", async () => {
    await withTemporaryDirectory(async (root) => {
    const profileRoot = join(root, "profiles");
    mkdirSync(profileRoot, { recursive: true });
    const agent = createObserverApplication({ root: join(root, "managed"), profileRoot, sourceDirectory: observerAddonSource, enableControlHttp: true });
    const descriptor = await agent.server.start();
    try {
    expect(descriptor.host).toBe("127.0.0.1");
    expect(descriptor.port).toBeGreaterThan(0);
    const base = `http://${descriptor.host}:${descriptor.port}`;
    expect(await (await fetch(`${base}/v1/health`)).json()).toMatchObject({ healthy: true });

    const prepared = await agent.control.prepareLaunch({
      runtimeKind: "client",
      arguments: ["-client"],
      profilePath: join(profileRoot, "run-1"),
      sessionTtlMs: 60_000,
      transportPreference: ["rest"],
      forceUpdate: false,
    });
    const contract = JSON.parse(readFileSync(prepared.session.contractPath, "utf8"));
    expect(await probeAgentLease(contract)).toBe("same");
    expect(await probeAgentLease({ ...contract, agent: { ...contract.agent, instanceId: "different-agent" } })).toBe("different");
    const registration = {
      protocolVersion: "1.0",
      addonVersion: "0.1.0",
      bundleDigest: contract.bundleDigest,
      buildIdentity: contract.buildIdentity,
      agentInstanceId: contract.agent.instanceId,
      sessionId: contract.sessionId,
      launchNonce: contract.launchNonce,
      instanceId: "runtime-1",
      instanceNonce: "runtime_nonce_1234567890123456789012345",
      processId: 100,
      runtimeKind: "client",
      capabilities: ["render.capture", "transport.rest"],
      selectedTransport: "rest",
      headless: false,
      worldId: "world-1",
      worldEpoch: 1,
      registeredAt: new Date().toISOString(),
    };
    expect((await post(`${base}/v1/runtime/register`, registration, "wrong-token")).status).toBe(401);
    expect((await post(`${base}/v1/runtime/register`, registration, contract.sessionToken)).status).toBe(200);
    expect((await fetch(`${base}/v1/control/instances`, { headers: { authorization: `Bearer ${contract.sessionToken}` } })).status).toBe(401);
    const controlResponse = await fetch(`${base}/v1/control/instances`, { headers: { authorization: `Bearer ${descriptor.controlToken}` } });
    expect(controlResponse.status).toBe(200);
    expect(await controlResponse.json()).toMatchObject({ instances: [{ instanceId: "runtime-1" }] });

    const preparedThroughLiveAgent = await requestObserverControl<{
      session: { contractPath: string };
    }>(descriptor, "/v1/control/prepare-launch", {
      method: "POST",
      body: {
        runtimeKind: "client",
        arguments: ["-client"],
        profilePath: join(profileRoot, "run-2"),
        sessionTtlMs: 60_000,
        transportPreference: ["rest"],
        forceUpdate: false,
      },
    });
    expect(readFileSync(preparedThroughLiveAgent.session.contractPath, "utf8")).toContain("sessionToken");

      await agent.server.close();
      await expect(agent.control.prepareLaunch({
      runtimeKind: "client",
      arguments: ["-client"],
      profilePath: join(profileRoot, "run-3"),
      sessionTtlMs: 60_000,
      transportPreference: ["rest"],
      forceUpdate: false,
      })).rejects.toMatchObject({ code: "TRANSPORT_UNAVAILABLE" });
    } finally {
      await agent.server.close();
    }
    });
  });

  it("is single-use and refuses to restart after closing", async () => {
    await withTemporaryDirectory(async (root) => {
      const agent = createObserverApplication({ root: join(root, "managed"), sourceDirectory: observerAddonSource });
      await agent.server.start();
      await agent.server.close();
      await expect(agent.server.start()).rejects.toThrow("cannot restart after closing");
    }, { prefix: "rfo-agent-single-use-" });
  });

  it("enforces the body limit before JSON parsing", async () => {
    await withTemporaryDirectory(async (root) => {
    const agent = createObserverApplication({ root: join(root, "managed"), sourceDirectory: observerAddonSource, maxBodyBytes: 64 });
    const descriptor = await agent.server.start();
    try {
      const response = await post(`http://${descriptor.host}:${descriptor.port}/v1/runtime/register`, { padding: "x".repeat(200) });
      expect(response.status).toBe(413);
    } finally {
      await agent.server.close();
    }
    });
  });
});
