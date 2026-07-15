import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkbenchClient } from "../../src/workbench/client.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Workbench handler bundle installation", () => {
  it("refreshes every bundled handler, removes stale handlers, and writes a versioned manifest", () => {
    const modRoot = mkdtempSync(join(tmpdir(), "reforger-forge-handler-refresh-"));
    roots.push(modRoot);
    const target = join(modRoot, "Scripts", "WorkbenchGame", "EnfusionMCP");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "EMCP_Stale_Handler.c"), "stale");
    writeFileSync(join(target, "EMCP_WB_Ping.c"), "outdated");

    const client = new WorkbenchClient("127.0.0.1", 1);
    (client as unknown as { installHandlerScripts: (modDir: string) => void })
      .installHandlerScripts(modRoot);

    const bundled = fileURLToPath(
      new URL("../../mod/Scripts/WorkbenchGame/EnfusionMCP/", import.meta.url)
    );
    const bundledFiles = readdirSync(bundled).filter((name) => name.endsWith(".c")).sort();
    const targetFiles = readdirSync(target).filter((name) => name.endsWith(".c")).sort();
    const manifest = JSON.parse(readFileSync(
      join(target, ".reforger-forge-handler-bundle.json"),
      "utf8"
    )) as { version: number; files: string[] };

    expect(existsSync(join(target, "EMCP_Stale_Handler.c"))).toBe(false);
    expect(targetFiles).toEqual(bundledFiles);
    expect(readFileSync(join(target, "EMCP_WB_Ping.c"), "utf8"))
      .toBe(readFileSync(join(bundled, "EMCP_WB_Ping.c"), "utf8"));
    expect(manifest).toEqual({ version: 2, files: bundledFiles });
  });
});
