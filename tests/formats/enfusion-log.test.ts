import { describe, expect, it } from "vitest";
import {
  parseLogLine,
  referencesAddon,
} from "../../src/formats/enfusion-log.js";

describe("Enfusion log parser", () => {
  it("extracts channel, level, message, and original text from padded log lines", () => {
    const line = "SCRIPT       (I): RoadblockRunners outfit: applied playerId=7 team=RED";

    expect(parseLogLine(line)).toEqual({
      channel: "SCRIPT",
      level: "I",
      message: "RoadblockRunners outfit: applied playerId=7 team=RED",
      raw: line,
    });
  });

  it("accepts multiple spaces before the level marker and no space after the colon", () => {
    const line = "RESOURCES    (E):Resources are leaking! count=3 owner=RR_GameMode";

    expect(parseLogLine(line)).toEqual({
      channel: "RESOURCES",
      level: "E",
      message: "Resources are leaking! count=3 owner=RR_GameMode",
      raw: line,
    });
  });

  it("returns null for banner or noise lines without a level marker", () => {
    expect(parseLogLine("Workbench 1.7.0.54 started")).toBeNull();
  });
});

describe("Enfusion log add-on attribution", () => {
  it("matches literal add-on names, resource prefixes, and forward-slash add-on paths", () => {
    expect(referencesAddon(
      "SCRIPT       (I): RoadblockRunners outfit: applied playerId=7 team=RED",
      "RoadblockRunners"
    )).toBe(true);
    expect(referencesAddon(
      'RESOURCES    (W): resource not registered: @"$RoadblockRunners:Configs/Runtime/RR_RuntimeConfig.json"',
      "RoadblockRunners"
    )).toBe(true);
    expect(referencesAddon(
      "ENGINE       (E): failed to load addons/addons-scenarios/RoadblockRunners/Configs/Runtime.conf",
      "RoadblockRunners"
    )).toBe(true);
  });

  it("matches Windows add-on paths and ignores case", () => {
    expect(referencesAddon(
      "ENGINE       (E): failed to load addons\\roadblockrunners\\Configs\\Runtime.conf",
      "RoadblockRunners"
    )).toBe(true);
  });

  it("does not treat an add-on ID as an internal script prefix or a longer name", () => {
    expect(referencesAddon(
      "ENGINE       (E): Assertion failed: owner != null entity=RR_GameMode",
      "RR"
    )).toBe(false);
    expect(referencesAddon(
      "SCRIPT       (E): SedanDeluxe subsystem failure",
      "Sedan"
    )).toBe(false);
  });

  it("handles comma-delimited messages safely", () => {
    expect(referencesAddon(
      "SCRIPT       (W): roadblockrunners, failed to load config, retrying",
      "RoadblockRunners"
    )).toBe(true);
  });
});
