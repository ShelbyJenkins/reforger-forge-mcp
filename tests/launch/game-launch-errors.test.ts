import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GameLaunchPlanError,
  projectPublicGameLaunchPlanError,
  PUBLIC_GAME_LAUNCH_ERROR_TEXT_MAXIMUM,
} from "../../src/launch/game-launch-errors.js";

describe("public game launch planning errors", () => {
  it("retains bounded safe candidate statuses while redacting arbitrary diagnostics", () => {
    const error = new GameLaunchPlanError(
      "WORLD_AMBIGUOUS",
      "Candidate scan at C:\\Users\\private-owner\\Secret token=do-not-leak was ambiguous.",
      {
        details: { token: "details-secret", safe: "safe-control" },
        candidates: [
          { path: "Worlds/Alpha.ent", status: "registered" },
          { path: "Worlds/Beta.ent", status: "unregistered" },
        ],
      },
    );
    const text = projectPublicGameLaunchPlanError(error);

    expect(text).toContain("Game launch error (WORLD_AMBIGUOUS):");
    expect(text).toContain("Worlds/Alpha.ent");
    expect(text).toContain("registered");
    expect(text).toContain("safe-control");
    expect(text).not.toContain("private-owner");
    expect(text).not.toContain("do-not-leak");
    expect(text).not.toContain("details-secret");
    expect(text.length).toBeLessThanOrEqual(PUBLIC_GAME_LAUNCH_ERROR_TEXT_MAXIMUM);
  });

  it("preserves the exact trusted registration workflow inside the total bound", () => {
    const projectPath = resolve("C:/Mods/Example/Example.gproj");
    const worldPath = resolve("C:/Mods/Example/Worlds/Example.ent");
    const text = projectPublicGameLaunchPlanError(new GameLaunchPlanError(
      "WORLD_UNREGISTERED",
      `World is unregistered: ${worldPath}`,
      {
        remedy: { kind: "register_world", projectPath, worldPath },
      },
    ));

    expect(text).toContain("open project");
    expect(text).toContain(JSON.stringify(projectPath));
    expect(text).toContain("wb_resources");
    expect(text).toContain(JSON.stringify({ action: "register", path: worldPath }));
    expect(text.length).toBeLessThanOrEqual(PUBLIC_GAME_LAUNCH_ERROR_TEXT_MAXIMUM);
  });

  it("bounds adversarial diagnostics and candidate collections", () => {
    const candidates = Array.from({ length: 100 }, (_, index) => ({
      path: `Worlds/${String(index).padStart(3, "0")}-${"x".repeat(220)}.ent`,
      status: "registered" as const,
    }));
    const text = projectPublicGameLaunchPlanError(new GameLaunchPlanError(
      "WORLD_AMBIGUOUS",
      "x".repeat(5_000),
      { candidates, details: { nested: { value: "y".repeat(5_000) } } },
    ));
    expect(text.length).toBeLessThanOrEqual(PUBLIC_GAME_LAUNCH_ERROR_TEXT_MAXIMUM);
    expect(text.startsWith("Game launch error (WORLD_AMBIGUOUS):")).toBe(true);
  });

  it("rejects unknown values and caller-supplied code spoofs", () => {
    for (const value of [
      new Error("WORLD_NOT_FOUND token=secret"),
      { name: "GameLaunchPlanError", code: "WORLD_NOT_FOUND", message: "spoof" },
      null,
    ]) {
      expect(projectPublicGameLaunchPlanError(value))
        .toBe("Game launch error (INTERNAL_ERROR): Game launch planning failed.");
    }
  });
});
