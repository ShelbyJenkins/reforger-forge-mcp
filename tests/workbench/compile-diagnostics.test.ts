import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findWorkbenchCompileFailure,
  formatWorkbenchCompileFailure,
  parseWorkbenchCompileFailure,
} from "../../src/workbench/compile-diagnostics.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function profile(): string {
  const root = mkdtempSync(join(tmpdir(), "reforger-forge-compile-diagnostic-"));
  roots.push(root);
  const path = join(root, "profile");
  mkdirSync(join(path, "logs"), { recursive: true });
  return path;
}

describe("Workbench project compile diagnostics", () => {
  it("prefers the compiler summary after the module marker over preceding dependency noise", () => {
    const parsed = parseWorkbenchCompileFailure([
      "21:45:00.084    SCRIPT    (E): @\"Scripts/Game/Base.c,434\": Can't find class Tuple2",
      "21:45:00.088    SCRIPT    (E): Can't compile \"Game\" script module!",
      "",
      "Scripts/Game/Presentation/RV_BoundaryCurtainComponent.c(587): Operator '-=' not supported",
      "21:45:00.148    SCRIPT    (W): Failed to load",
    ].join("\n"), "C:\\managed\\logs\\current\\script.log");

    expect(parsed).toEqual({
      code: "PROJECT_COMPILE_FAILED",
      module: "Game",
      diagnostics: [
        "Scripts/Game/Presentation/RV_BoundaryCurtainComponent.c(587): Operator '-=' not supported",
      ],
      logPath: "C:\\managed\\logs\\current\\script.log",
    });
  });

  it("falls back to nearby SCRIPT errors when no plain compiler summary is emitted", () => {
    const parsed = parseWorkbenchCompileFailure([
      "10:00:00.001    SCRIPT    (E): @\"Scripts/Game/Broken.c,12\": Syntax error",
      "10:00:00.002    SCRIPT    (E): Can't compile \"Game\" script module!",
      "10:00:00.003    SCRIPT    (W): Failed to load",
    ].join("\n"), "script.log");

    expect(parsed?.diagnostics).toEqual([
      "@\"Scripts/Game/Broken.c,12\": Syntax error",
    ]);
  });

  it("attributes the failure to the exact launch owner instead of the newest unrelated log", () => {
    const profilePath = profile();
    const launchedAtMs = Date.now();
    const ownerArgument = "-reforgerForgeOwnerToken=11111111-1111-4111-8111-111111111111";
    const owned = join(profilePath, "logs", "logs-owned");
    mkdirSync(owned);
    writeFileSync(join(owned, "console.log"), `CLI Params: ${ownerArgument}\n`);
    writeFileSync(join(owned, "script.log"), [
      "12:00:00.001    SCRIPT    (E): Can't compile \"Game\" script module!",
      "",
      "Scripts/Game/Broken.c(7): Expected ';'",
    ].join("\n"));

    const unrelated = join(profilePath, "logs", "logs-unrelated-newer");
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, "console.log"),
      "CLI Params: -reforgerForgeOwnerToken aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n");
    writeFileSync(join(unrelated, "script.log"), [
      "12:00:01.001    SCRIPT    (E): Can't compile \"Game\" script module!",
      "",
      "Scripts/Game/Wrong.c(99): Wrong launch",
    ].join("\n"));

    expect(findWorkbenchCompileFailure({ profilePath, launchedAtMs, ownerArgument }))
      .toMatchObject({
        code: "PROJECT_COMPILE_FAILED",
        module: "Game",
        diagnostics: ["Scripts/Game/Broken.c(7): Expected ';'"],
        logPath: join(owned, "script.log"),
      });
  });

  it("does not attribute a compiler failure when the private launch token is absent", () => {
    const profilePath = profile();
    const logDirectory = join(profilePath, "logs", "logs-unowned");
    mkdirSync(logDirectory);
    writeFileSync(join(logDirectory, "console.log"), "CLI Params: no owner token\n");
    writeFileSync(join(logDirectory, "script.log"),
      "12:00:00.001 SCRIPT (E): Can't compile \"Game\" script module!\n");

    expect(findWorkbenchCompileFailure({
      profilePath,
      launchedAtMs: Date.now(),
      ownerArgument: "-reforgerForgeOwnerToken=11111111-1111-4111-8111-111111111111",
    })).toBeNull();
  });

  it("preserves the compile diagnostic while naming one exact wb_check call", () => {
    const failure = {
      code: "PROJECT_COMPILE_FAILED" as const,
      module: "Game",
      diagnostics: ["Scripts/Game/Broken.c(7): Expected ';'"],
      logPath: "C:\\managed\\logs\\script.log",
    };
    const gprojPath = "C:\\mods\\quoted \\\"project\\\"\\Example.gproj";
    const original = formatWorkbenchCompileFailure(failure);
    const rendered = formatWorkbenchCompileFailure(failure, gprojPath);

    expect(rendered.startsWith(original)).toBe(true);
    expect(rendered).toContain("call wb_check with");
    expect(rendered).toContain(JSON.stringify({ gprojPath }));
    expect(rendered.match(/wb_check/g)).toHaveLength(1);
  });
});
