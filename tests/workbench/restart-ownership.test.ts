import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { WorkbenchClient, WorkbenchError } from "../../src/workbench/client.js";

const config: Config = {
  workbenchPath: "C:\\Arma Reforger Tools",
  projectPath: "C:\\mods",
  gamePath: "C:\\Arma Reforger",
  dataDir: "C:\\data",
  patternsDir: "C:\\patterns",
  workbenchHost: "127.0.0.1",
  workbenchPort: 5775,
  workbenchNoThrow: true,
};

class FakeChild extends EventEmitter {
  readonly pid: number;
  exitCode: number | null = null;
  killed = false;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill = vi.fn((): boolean => {
    this.killed = true;
    this.exitCode = 0;
    this.emit("exit", 0, null);
    return true;
  });

  unref(): void {}
}

function installOwnedProcess(
  client: WorkbenchClient,
  process: FakeChild,
  gprojPath: string
): void {
  (client as unknown as { ownedWorkbench: unknown }).ownedWorkbench = {
    process: process as unknown as ChildProcess,
    pid: process.pid,
    gprojPath,
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("test server did not receive a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe("owner-scoped Workbench restart", () => {
  it("fails closed when this client did not launch Workbench", async () => {
    const client = new WorkbenchClient("127.0.0.1", 5775, config);

    await expect(client.restartOwnedWorkbench()).rejects.toMatchObject({
      code: "LAUNCH_FAILED",
    });
    await expect(client.restartOwnedWorkbench()).rejects.toThrow(
      /does not own the running Workbench process/
    );
  });

  it("kills only its recorded child, retains the gproj, and owns the replacement", async () => {
    const client = new WorkbenchClient("127.0.0.1", 5775, config);
    const original = new FakeChild(12001);
    const replacement = new FakeChild(12002);
    const gprojPath = "C:\\mods\\RoadblockRunners\\RoadblockRunners.gproj";
    installOwnedProcess(client, original, gprojPath);

    const waitForPortRelease = vi.fn().mockResolvedValue(undefined);
    (client as unknown as { waitForPortRelease: () => Promise<void> }).waitForPortRelease =
      waitForPortRelease;

    const launchWorkbench = vi.fn(async (
      retained?: string,
      requireVacantPort?: boolean,
      forceNoThrow?: boolean
    ) => {
      expect(retained).toBe(gprojPath);
      expect(requireVacantPort).toBe(true);
      expect(forceNoThrow).toBe(true);
      installOwnedProcess(client, replacement, gprojPath);
    });
    (client as unknown as {
      launchWorkbench: (
        gprojPath?: string,
        requireVacantPort?: boolean,
        forceNoThrow?: boolean
      ) => Promise<void>;
    }).launchWorkbench = launchWorkbench;

    const result = await client.restartOwnedWorkbench();

    expect(original.kill).toHaveBeenCalledOnce();
    expect(replacement.kill).not.toHaveBeenCalled();
    expect(waitForPortRelease).toHaveBeenCalledOnce();
    expect(launchWorkbench).toHaveBeenCalledOnce();
    expect(result).toEqual({
      previousPid: 12001,
      pid: 12002,
      gprojPath,
    });
  });

  it("deduplicates concurrent restart requests", async () => {
    const client = new WorkbenchClient("127.0.0.1", 5775, config);
    const original = new FakeChild(13001);
    const replacement = new FakeChild(13002);
    installOwnedProcess(client, original, "C:\\mods\\Example\\Example.gproj");
    (client as unknown as { waitForPortRelease: () => Promise<void> }).waitForPortRelease =
      vi.fn().mockResolvedValue(undefined);

    let releaseLaunch: (() => void) | undefined;
    const launchWorkbench = vi.fn(() => new Promise<void>((resolve) => {
      releaseLaunch = () => {
        installOwnedProcess(client, replacement, "C:\\mods\\Example\\Example.gproj");
        resolve();
      };
    }));
    (client as unknown as { launchWorkbench: () => Promise<void> }).launchWorkbench = launchWorkbench;

    const first = client.restartOwnedWorkbench();
    const second = client.restartOwnedWorkbench();
    await vi.waitFor(() => expect(releaseLaunch).toBeTypeOf("function"));
    releaseLaunch?.();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(original.kill).toHaveBeenCalledOnce();
    expect(launchWorkbench).toHaveBeenCalledOnce();
  });

  it("contains no executable-name-wide termination fallback", () => {
    const source = readFileSync(
      new URL("../../src/workbench/client.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toContain("taskkill /IM");
    expect(source).not.toContain("execSync(`taskkill");
  });

  it("launch-failure cleanup terminates only the exact spawned child and clears ownership", async () => {
    const client = new WorkbenchClient("127.0.0.1", 5775, config);
    const spawned = new FakeChild(14001);
    installOwnedProcess(client, spawned, "C:\\mods\\Example\\Example.gproj");
    const owned = (client as unknown as { ownedWorkbench: unknown }).ownedWorkbench;

    await expect((client as unknown as {
      terminateSpawnedChild: (launch: unknown) => Promise<void>;
    }).terminateSpawnedChild(owned)).resolves.toBeUndefined();

    expect(spawned.kill).toHaveBeenCalledOnce();
    expect((client as unknown as { ownedWorkbench: unknown }).ownedWorkbench).toBeNull();
  });

  it("waits until the NET API port is actually released", async () => {
    const server = createServer((socket) => socket.destroy());
    const port = await listen(server);
    const client = new WorkbenchClient("127.0.0.1", port, {
      ...config,
      workbenchPort: port,
    });

    let settled = false;
    const waiting = (client as unknown as { waitForPortRelease: () => Promise<void> })
      .waitForPortRelease()
      .then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);

    await close(server);
    await expect(waiting).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it("refuses a replacement launch if another process occupies the port", async () => {
    const server = createServer((socket) => socket.destroy());
    const port = await listen(server);
    const client = new WorkbenchClient("127.0.0.1", port, {
      ...config,
      workbenchPort: port,
    });

    try {
      await expect((client as unknown as {
        launchWorkbench: (
          gprojPath?: string,
          requireVacantPort?: boolean,
          forceNoThrow?: boolean
        ) => Promise<void>;
      }).launchWorkbench(undefined, true, true)).rejects.toThrow(/already occupied/);
    } finally {
      await close(server);
    }
  });

  it("uses a launch failure rather than a generic error type", async () => {
    const client = new WorkbenchClient("127.0.0.1", 5775, config);
    try {
      await client.restartOwnedWorkbench();
      throw new Error("expected restart refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkbenchError);
      expect((error as WorkbenchError).code).toBe("LAUNCH_FAILED");
    }
  });
});
