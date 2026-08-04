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

  it.each(["-window", "-screenWidth", "-screenHeight", "-screenWidth=1280"])(
    "refuses raw display override %s",
    (argument) => {
      expect(() => launchArguments("Worlds/Test.ent", null, [argument]))
        .toThrow(/native fullscreen.*not accepted/i);
    },
  );
});
