import { describe, expect, it } from "vitest";
import { convertBmpToPng } from "../../observer/agent/bmp.js";
import {
  ACTIVE_ENTRY_MARKER,
  AI_STRESS_TEST_CASE,
  LIVE_RUN_ENVIRONMENT,
  analyzePngMaterial,
  assertLiveRunAuthorized,
  buildAiStressLaunchArguments,
  compatibleRenderer,
  findBlockingProcesses,
  isExpectedObserverSourceCacheWarning,
  launchArgumentsContainAddon,
  redactEvidenceForRetention,
  updateRuntimeMarkers,
} from "../../scripts/run-observer-ai-stress-acceptance.js";

function bitmap(width: number, height: number, varied: boolean): Buffer {
  const rowStride = Math.floor((24 * width + 31) / 32) * 4;
  const result = Buffer.alloc(54 + rowStride * height);
  result.write("BM", 0, "ascii");
  result.writeUInt32LE(result.length, 2);
  result.writeUInt32LE(54, 10);
  result.writeUInt32LE(40, 14);
  result.writeInt32LE(width, 18);
  result.writeInt32LE(height, 22);
  result.writeUInt16LE(1, 26);
  result.writeUInt16LE(24, 28);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = 54 + y * rowStride + x * 3;
      if (!varied) continue;
      result[offset] = (x * 11 + y * 3) & 0xff;
      result[offset + 1] = (x * 5 + y * 13) & 0xff;
      result[offset + 2] = (x * 17 + y * 7) & 0xff;
    }
  }
  return result;
}

describe("AI-stress observer screenshot acceptance harness", () => {
  it("requires two independent live-launch confirmations", () => {
    expect(() => assertLiveRunAuthorized(false, { [LIVE_RUN_ENVIRONMENT]: "1" })).toThrow(/--confirm-live-run/);
    expect(() => assertLiveRunAuthorized(true, {})).toThrow(new RegExp(LIVE_RUN_ENVIRONMENT));
    expect(() => assertLiveRunAuthorized(true, { [LIVE_RUN_ENVIRONMENT]: "1" })).not.toThrow();
  });

  it("detects every supported Arma/Workbench blocker without broad process matching", () => {
    expect(findBlockingProcesses([
      { Id: 77, ProcessName: "ArmaReforgerSteamDiag" },
      { Id: 88, ProcessName: "ArmaReforgerWorkbenchSteamDiag" },
      { Id: 99, ProcessName: "UnrelatedWorkbenchHelper" },
    ])).toEqual([
      { id: 77, processName: "ArmaReforgerSteamDiag" },
      { id: 88, processName: "ArmaReforgerWorkbenchSteamDiag" },
    ]);
  });

  it("requires both the exact 48-bot gate and a live negative-ID runner focus", () => {
    let evidence = updateRuntimeMarkers(
      { activeEntry: null, liveRunner: null },
      `12:00:00 ${ACTIVE_ENTRY_MARKER}`,
      "console.log"
    );
    expect(evidence.activeEntry?.line).toContain("all 48 bots");
    expect(evidence.liveRunner).toBeNull();
    evidence = updateRuntimeMarkers(
      evidence,
      "RoadblockRunners Observer: focus actorId=-123 source=runner position=<1,2,3>",
      "script.log"
    );
    expect(evidence.liveRunner?.line).toContain("actorId=-123");
  });

  it("builds the reviewed maximum-AI launch without shell quoting", () => {
    const args = buildAiStressLaunchArguments({
      projectFile: "C:\\workspace\\addons\\RoadblockRunners\\RoadblockRunners.gproj",
      addonDirectories: ["C:\\game\\addons", "C:\\workshop", "C:\\workspace\\addons"],
      profilePath: "C:\\temp\\profiles\\game",
      engineSettingsPath: "C:\\temp\\AIStressEngineSettings.conf",
    });
    expect(args[args.indexOf("-autotest") + 1]).toBe(AI_STRESS_TEST_CASE);
    expect(args).toContain("RR_AI_STRESS_AUTOTEST");
    expect(args[args.indexOf("-addonsDir") + 1]).toBe("C:\\game\\addons,C:\\workshop,C:\\workspace\\addons");
    expect(args.some((value) => value.startsWith('"'))).toBe(false);
    expect(launchArgumentsContainAddon(["-addons", "TARGET,7F3A91C2E40B6D58"], "7F3A91C2E40B6D58")).toBe(true);
  });

  it("accepts launch-attested renderers without a PID but rejects a different claimed PID", () => {
    const renderer = {
      sessionId: "s-owned",
      instanceId: "runtime-owned",
      runtimeKind: "testRunner",
      headless: false,
      stale: false,
      transportHealthy: true,
      worldId: "world-owned",
      worldEpoch: 1,
      capabilities: ["render.capture", "camera.runtime", "world.query"],
    };
    expect(compatibleRenderer(renderer, "s-owned", 1234, "runtime-owned")).toBe(true);
    expect(compatibleRenderer({ ...renderer, processId: 1234 }, "s-owned", 1234, "runtime-owned")).toBe(true);
    expect(compatibleRenderer({ ...renderer, processId: 4321 }, "s-owned", 1234, "runtime-owned")).toBe(false);
  });

  it("allows only the exact unpacked observer ResourceDB cache warning", () => {
    const expected = "02:20:25.062 RESOURCES (W): ResourceDB: could not open the cache file 'C:\\staged\\ReforgerForgeObserver/resourceDatabase.rdb'";
    expect(isExpectedObserverSourceCacheWarning(expected)).toBe(true);
    expect(isExpectedObserverSourceCacheWarning(expected.replace("(W)", "(E)"))).toBe(false);
    expect(isExpectedObserverSourceCacheWarning(expected.replace("resourceDatabase.rdb", "Scripts/Game/RFO_ObserverService.c"))).toBe(false);
    expect(isExpectedObserverSourceCacheWarning("SCRIPT (W): RFO_Observer camera restoration warning")).toBe(false);
  });

  it("independently rejects blank screenshots and accepts color-varied PNG evidence", () => {
    const blank = convertBmpToPng(bitmap(64, 64, false)).png;
    const varied = convertBmpToPng(bitmap(64, 64, true)).png;
    expect(analyzePngMaterial(blank)).toMatchObject({ materiallyVaried: false, quantizedColorCount: 1 });
    const evidence = analyzePngMaterial(varied);
    expect(evidence.materiallyVaried).toBe(true);
    expect(evidence.width).toBe(64);
    expect(evidence.height).toBe(64);
    expect(evidence.quantizedColorCount).toBeGreaterThanOrEqual(16);
    expect(evidence.nonBlackRatio).toBeGreaterThan(0.9);
  });

  it("removes credentials and nonces from retained evidence recursively", () => {
    expect(redactEvidenceForRetention({
      sessionId: "session-safe",
      sessionToken: "runtime-secret",
      nested: { instanceNonce: "nonce-secret", message: "Authorization: Bearer abc.def-123" },
    })).toEqual({
      sessionId: "session-safe",
      sessionToken: "[REDACTED]",
      nested: { instanceNonce: "[REDACTED]", message: "Authorization: [REDACTED]" },
    });
  });
});
