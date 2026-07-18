import { describe, it } from "vitest";
import {
  LIVE_RUNTIME_OBSERVER_ENVIRONMENT,
  LIVE_RUNTIME_OBSERVER_TEST_CONFIRMATION,
  parseQuaternion,
  parseVector3,
  runRuntimeObserverAcceptance,
  type RuntimeObserverMarkerExpectation,
} from "../../../scripts/run-runtime-observer-acceptance.js";

const liveAuthorized =
  process.env[LIVE_RUNTIME_OBSERVER_ENVIRONMENT] === "1" &&
  process.env[LIVE_RUNTIME_OBSERVER_TEST_CONFIRMATION] === "1";

function markerFromEnvironment(): RuntimeObserverMarkerExpectation | undefined {
  const raw = process.env.RFO_RUNTIME_OBSERVER_MARKER_RGB;
  if (!raw) return undefined;
  const color = parseVector3(raw, "Marker RGB");
  if (color.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new Error("RFO_RUNTIME_OBSERVER_MARKER_RGB channels must be integers from 0 through 255");
  }
  const rawRoi = process.env.RFO_RUNTIME_OBSERVER_MARKER_ROI;
  if (!rawRoi) return { color: color as [number, number, number] };
  const roi = rawRoi.split(",").map((item) => Number(item.trim()));
  if (roi.length !== 4 || roi.some((value) => !Number.isFinite(value))) {
    throw new Error("RFO_RUNTIME_OBSERVER_MARKER_ROI must contain x,y,width,height");
  }
  return {
    color: color as [number, number, number],
    roi: { x: roi[0], y: roi[1], width: roi[2], height: roi[3] },
  };
}

describe.runIf(liveAuthorized)("live graphical runtime observer screenshot acceptance", () => {
  it("captures, restores, and finalizes a real runtime evidence run", async () => {
    const worldResource = process.env.RFO_RUNTIME_OBSERVER_WORLD;
    const launchArguments = process.env.RFO_RUNTIME_OBSERVER_LAUNCH_ARGUMENTS_JSON
      ? JSON.parse(process.env.RFO_RUNTIME_OBSERVER_LAUNCH_ARGUMENTS_JSON) as unknown
      : [];
    if (!Array.isArray(launchArguments) || !launchArguments.every((value) => typeof value === "string")) {
      throw new Error("RFO_RUNTIME_OBSERVER_LAUNCH_ARGUMENTS_JSON must be a JSON string array");
    }
    await runRuntimeObserverAcceptance({
      confirmed: true,
      environment: process.env,
      worldResource,
      addonDirectory: process.env.RFO_RUNTIME_OBSERVER_ADDON_DIR,
      executablePath: process.env.RFO_RUNTIME_OBSERVER_EXECUTABLE,
      artifactRoot: process.env.RFO_RUNTIME_OBSERVER_ARTIFACT_ROOT,
      timeoutMs: process.env.RFO_RUNTIME_OBSERVER_TIMEOUT_MS
        ? Number(process.env.RFO_RUNTIME_OBSERVER_TIMEOUT_MS)
        : undefined,
      launchArguments,
      posePosition: process.env.RFO_RUNTIME_OBSERVER_POSE_POSITION
        ? parseVector3(process.env.RFO_RUNTIME_OBSERVER_POSE_POSITION, "Pose position")
        : undefined,
      poseOrientation: process.env.RFO_RUNTIME_OBSERVER_POSE_ORIENTATION
        ? parseQuaternion(process.env.RFO_RUNTIME_OBSERVER_POSE_ORIENTATION, "Pose orientation")
        : undefined,
      poseFov: process.env.RFO_RUNTIME_OBSERVER_POSE_FOV
        ? Number(process.env.RFO_RUNTIME_OBSERVER_POSE_FOV)
        : undefined,
      lookAtPosition: process.env.RFO_RUNTIME_OBSERVER_LOOK_AT_POSITION
        ? parseVector3(process.env.RFO_RUNTIME_OBSERVER_LOOK_AT_POSITION, "Look-at position")
        : undefined,
      lookAtTarget: process.env.RFO_RUNTIME_OBSERVER_LOOK_AT_TARGET
        ? parseVector3(process.env.RFO_RUNTIME_OBSERVER_LOOK_AT_TARGET, "Look-at target")
        : undefined,
      lookAtFov: process.env.RFO_RUNTIME_OBSERVER_LOOK_AT_FOV
        ? Number(process.env.RFO_RUNTIME_OBSERVER_LOOK_AT_FOV)
        : undefined,
      marker: markerFromEnvironment(),
    });
  }, 960_000);
});
