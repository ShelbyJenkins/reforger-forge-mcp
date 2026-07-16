import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repositoryRoot } from "../helpers.js";

const enabled = process.env.RFO_ENGINE_TESTS === "1" &&
  process.env.RFO_RUN_AI_STRESS_OBSERVER_ACCEPTANCE === "1";
const timeoutSeconds = Number(process.env.RFO_OBSERVER_ACCEPTANCE_TIMEOUT_SECONDS ?? 600);

function appendTail(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString("utf8")}`.slice(-64 * 1024);
}

describe.skipIf(!enabled)("real Enfusion observer AI-stress screenshot acceptance", () => {
  it("uses the exact-owned live harness and retains current, pose/restoration, and post-restore evidence", async () => {
    const executable = process.env.RFO_ENGINE_EXECUTABLE;
    const baseGameAddons = process.env.RFO_BASE_GAME_ADDONS;
    const workshopAddons = process.env.RFO_WORKSHOP_ADDONS;
    expect(executable, "RFO_ENGINE_EXECUTABLE must select ArmaReforgerSteamDiag.exe").toBeTruthy();
    expect(baseGameAddons, "RFO_BASE_GAME_ADDONS must select the base-game addons directory").toBeTruthy();
    expect(workshopAddons, "RFO_WORKSHOP_ADDONS must select at least one dependency root").toBeTruthy();
    expect(existsSync(executable!)).toBe(true);
    expect(existsSync(baseGameAddons!)).toBe(true);
    expect(existsSync(join(repositoryRoot, "dist", "observer", "coordinator.js")), "Run npm run build before the live integration suite").toBe(true);

    const runner = join(repositoryRoot, "scripts", "run-observer-ai-stress-acceptance.ts");
    const tsxCli = join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const child = spawn(process.execPath, [tsxCli, runner, "--confirm-live-run"], {
      cwd: repositoryRoot,
      env: { ...process.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout = appendTail(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = appendTail(stderr, chunk); });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect(exitCode, `Live harness failed.\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
    const match = /RFO_OBSERVER_ACCEPTANCE_RESULT=(.+)\r?$/m.exec(stdout);
    expect(match, `Live harness did not report its retained summary.\nstdout:\n${stdout}`).not.toBeNull();
    const summaryPath = match![1].trim();
    expect(existsSync(summaryPath)).toBe(true);
    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
      status?: unknown;
      captures?: Array<{ label?: unknown; imagePath?: unknown; png?: { materiallyVaried?: unknown }; cameraLease?: Record<string, unknown> }>;
    };
    expect(summary.status).toBe("passed");
    expect(summary.captures?.map((capture) => capture.label)).toEqual([
      "ai-live-current",
      "pose-restoration",
      "post-restoration-current",
    ]);
    for (const capture of summary.captures ?? []) expect(existsSync(String(capture.imagePath))).toBe(true);
    expect(summary.captures?.[0].png?.materiallyVaried).toBe(true);
    expect(summary.captures?.[1].cameraLease).toMatchObject({ everHeld: true, held: false, restorationConfirmed: true });
    expect(summary.captures?.[2].png?.materiallyVaried).toBe(true);
  }, (Math.max(120, timeoutSeconds) + 120) * 1_000);
});
