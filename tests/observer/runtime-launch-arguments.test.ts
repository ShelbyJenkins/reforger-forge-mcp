import { describe, expect, it } from "vitest";
import { launchArguments } from "../../scripts/observer-runtime-launch-support.js";

describe("managed graphical runtime launch arguments", () => {
  it("uses the engine's fullscreen default and does not force a window size", () => {
    const result = launchArguments("Worlds/Test.ent", null, undefined);

    expect(result).not.toContain("-window");
    expect(result).not.toContain("-screenWidth");
    expect(result).not.toContain("-screenHeight");
    expect(result).toContain("-server");
  });

  it("preserves an explicit caller opt-in to windowed mode", () => {
    const result = launchArguments("Worlds/Test.ent", null, [
      "-window", "-screenWidth", "1280", "-screenHeight", "720",
    ]);

    expect(result).toContain("-window");
    expect(result.slice(-5)).toEqual([
      "-window", "-screenWidth", "1280", "-screenHeight", "720",
    ]);
  });
});
