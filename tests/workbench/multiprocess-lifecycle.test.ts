import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const helperPath = fileURLToPath(
  new URL("../../scripts/windows/workbench-lifecycle.ps1", import.meta.url)
);
const workerPath = fileURLToPath(
  new URL("./fixtures/lifecycle-owner-worker.ts", import.meta.url)
);
const roots: string[] = [];
const children = new Set<ChildProcess>();

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function track(child: ChildProcess): ChildProcess {
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}

function readLine(child: ChildProcess, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child ${child.pid} output.`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolvePromise(buffer.slice(0, newline).trim());
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null): void => {
      cleanup();
      reject(new Error(`Child ${child.pid} exited with code ${code} before responding: ${buffer}`));
    };
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function closed(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolvePromise) => child.once("close", resolvePromise));
}

function encodedPowerShell(source: string): string {
  return Buffer.from(source, "utf16le").toString("base64");
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  await Promise.all([...children].map((child) => closed(child).catch(() => null)));
  children.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.runIf(platform() === "win32")("real multi-process lifecycle ownership", () => {
  it("keeps a second live Node MCP worker out of launch, restart, and shutdown", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "reforger-forge-node-workers-"));
    roots.push(stateRoot);
    const projectRoot = join(stateRoot, "WorkerFixture");
    const gprojPath = join(projectRoot, "WorkerFixture.gproj");
    mkdirSync(projectRoot);
    writeFileSync(gprojPath, "WorkbenchPlugin {}\n", { encoding: "utf8", flag: "wx" });
    const environment = {
      ...process.env,
      RR_STATE_DIR: stateRoot,
      RR_HELPER_PATH: helperPath,
      RR_MUTEX_NAME: `Global\\ReforgerForge.NodeWorkers.${Date.now()}.${process.pid}`,
      RR_GPROJ_PATH: gprojPath,
    };
    const owner = track(spawn(process.execPath, ["--import", "tsx", workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...environment, RR_WORKER_ROLE: "owner" },
    }));
    const ownerMessage = JSON.parse(await readLine(owner)) as {
      result?: { kind: string };
      error?: string;
    };
    expect(ownerMessage.error).toBeUndefined();
    expect(ownerMessage.result?.kind).toBe("claimed");
    expect(owner.exitCode).toBeNull();

    const contender = track(spawn(process.execPath, ["--import", "tsx", workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...environment, RR_WORKER_ROLE: "contender" },
    }));
    const contenderMessage = JSON.parse(await readLine(contender)) as {
      results: Record<string, { kind: string; code: string }>;
    };

    for (const kind of ["launch", "restart", "shutdown"]) {
      expect(contenderMessage.results[kind]).toMatchObject({
        kind: "refused",
        code: "OWNED_BY_OTHER_MCP",
      });
    }
    expect(owner.exitCode).toBeNull();
    expect(contender.exitCode).toBeNull();

    owner.stdin?.end("release\n");
    contender.stdin?.end("release\n");
    await Promise.all([closed(owner), closed(contender)]);
  }, 60_000);

  it("allows only one of two simultaneous contenders into an abandoned global mutex", async () => {
    const mutexName = `Global\\ReforgerForge.AbandonRace.${Date.now()}.${process.pid}`;
    const environment = { ...process.env, RR_MUTEX_NAME: mutexName };
    const ownerScript = [
      "$m=[Threading.Mutex]::new($false,$env:RR_MUTEX_NAME)",
      "$null=$m.WaitOne()",
      "[Console]::Out.WriteLine('ready')",
      "[Console]::Out.Flush()",
      "$null=[Console]::In.ReadLine()",
      "[Environment]::Exit(0)",
    ].join("\n");
    const anchorScript = [
      "$m=[Threading.Mutex]::OpenExisting($env:RR_MUTEX_NAME)",
      "[Console]::Out.WriteLine('anchored')",
      "[Console]::Out.Flush()",
      "$null=[Console]::In.ReadLine()",
      "$m.Dispose()",
    ].join("\n");

    const owner = track(spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShell(ownerScript),
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: environment }));
    expect(await readLine(owner)).toBe("ready");

    const anchor = track(spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShell(anchorScript),
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: environment }));
    expect(await readLine(anchor)).toBe("anchored");

    const contenders = [0, 1].map(() => track(spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", helperPath, "-Mode", "HoldMutex",
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })));
    const acquisitions = contenders.map((child, index) => {
      child.stdin?.write(`${JSON.stringify({ mutexName, timeoutMs: 10_000 })}\n`);
      return readLine(child).then((line) => ({ index, line }));
    });
    let secondResolved = false;

    owner.stdin?.end("abandon\n");
    await closed(owner);
    const first = await Promise.race(acquisitions);
    const secondIndex = first.index === 0 ? 1 : 0;
    acquisitions[secondIndex].then(() => { secondResolved = true; });
    expect(JSON.parse(first.line)).toMatchObject({
      ok: true,
      status: "acquired",
      abandoned: true,
    });
    await delay(250);
    expect(secondResolved).toBe(false);

    contenders[first.index].stdin?.end("release\n");
    await closed(contenders[first.index]);
    const second = await acquisitions[secondIndex];
    expect(JSON.parse(second.line)).toMatchObject({ ok: true, status: "acquired" });
    contenders[secondIndex].stdin?.end("release\n");
    await closed(contenders[secondIndex]);
    anchor.stdin?.end("close\n");
    await closed(anchor);
  }, 60_000);
});
