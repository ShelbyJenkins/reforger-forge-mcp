import { describe, expect, it } from "vitest";
import { parseWorkbenchRunnerArguments } from "../../src/workbench/runner.js";

describe("standalone Workbench runner argument contract", () => {
  it("accepts only explicit foreground editor and bounded PC build intents", () => {
    expect(parseWorkbenchRunnerArguments([
      "editor", "--gproj", "Example.gproj", "--foreground",
    ])).toEqual({ kind: "editor", gprojPath: "Example.gproj", foreground: true });
    expect(parseWorkbenchRunnerArguments([
      "build", "--gproj", "Example.gproj", "--platform", "PC",
      "--output", "out", "--timeout-ms", "300000",
    ])).toEqual({
      kind: "build",
      gprojPath: "Example.gproj",
      platform: "PC",
      outputPath: "out",
      timeoutMs: 300_000,
    });
    expect(parseWorkbenchRunnerArguments([
      "check", "--gproj", "C:\\mods\\Example\\Example.gproj",
      "--configuration", "PC", "--timeout-ms", "120000",
    ])).toEqual({
      kind: "check",
      gprojPath: "C:\\mods\\Example\\Example.gproj",
      configuration: "PC",
      timeoutMs: 120_000,
    });
  });

  it("rejects detached, arbitrary-argument, unbounded, and non-PC modes", () => {
    expect(() => parseWorkbenchRunnerArguments([
      "editor", "--gproj", "Example.gproj",
    ])).toThrow(/foreground/i);
    expect(() => parseWorkbenchRunnerArguments([
      "editor", "--gproj", "Example.gproj", "--foreground", "--detached",
    ])).toThrow(/unsupported/i);
    expect(() => parseWorkbenchRunnerArguments([
      "build", "--gproj", "Example.gproj", "--platform", "PC", "--output", "out",
    ])).toThrow(/requires exactly/i);
    expect(() => parseWorkbenchRunnerArguments([
      "build", "--gproj", "Example.gproj", "--platform", "Console",
      "--output", "out", "--timeout-ms", "1000",
    ])).toThrow(/must be PC/i);
    expect(() => parseWorkbenchRunnerArguments([
      "check", "--gproj", "Example.gproj", "--configuration", "PC",
      "--timeout-ms", "120000",
    ])).toThrow(/absolute/i);
    expect(() => parseWorkbenchRunnerArguments([
      "check", "--gproj", "C:\\mods\\Example\\Example.gproj", "--configuration", "UNKNOWN CONFIG",
      "--timeout-ms", "120000",
    ])).toThrow(/configuration identifier/i);
  });
});
