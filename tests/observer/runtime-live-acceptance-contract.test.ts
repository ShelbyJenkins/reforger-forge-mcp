import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_OBSERVER_LOOK_AT_FOV,
  DEFAULT_RUNTIME_OBSERVER_LOOK_AT_POSITION,
  DEFAULT_RUNTIME_OBSERVER_LOOK_AT_TARGET,
  DEFAULT_RUNTIME_OBSERVER_POSE_FOV,
  DEFAULT_RUNTIME_OBSERVER_POSE_ORIENTATION,
  DEFAULT_RUNTIME_OBSERVER_POSE_POSITION,
  DEFAULT_RUNTIME_OBSERVER_WORLD,
  LIVE_RUNTIME_OBSERVER_ENVIRONMENT,
  assertCurrentViewReleasedFromDisplaced,
  assertMatrixClose,
  assertLiveRuntimeObserverAuthorized,
  assertRequestedPoseRendered,
  captureMatrix,
  parseQuaternion,
  parseVector3,
  recordRestorationImageSimilarity,
  resolveRuntimeAcceptanceArtifactRoot,
  runtimePoseMatrix,
} from "../../scripts/run-runtime-observer-acceptance.js";

describe("live graphical runtime observer acceptance contract", () => {
  it("requires independent environment and explicit-run confirmations", () => {
    expect(() => assertLiveRuntimeObserverAuthorized(false, {
      [LIVE_RUNTIME_OBSERVER_ENVIRONMENT]: "1",
    })).toThrow(/--confirm-live-run/);
    expect(() => assertLiveRuntimeObserverAuthorized(true, {})).toThrow(
      new RegExp(LIVE_RUNTIME_OBSERVER_ENVIRONMENT)
    );
    expect(() => assertLiveRuntimeObserverAuthorized(true, {
      [LIVE_RUNTIME_OBSERVER_ENVIRONMENT]: "1",
    })).not.toThrow();
  });

  it("parses finite explicit fixture coordinates", () => {
    expect(parseVector3("1.5,-2,30", "fixture")).toEqual([1.5, -2, 30]);
    expect(() => parseVector3("1,2", "fixture")).toThrow(/three comma-separated/);
    expect(() => parseVector3("1,NaN,3", "fixture")).toThrow(/finite/);
    expect(parseQuaternion("0,0,0,1", "pose")).toEqual([0, 0, 0, 1]);
    expect(() => parseQuaternion("0,0,1", "pose")).toThrow(/four comma-separated/);
    expect(() => parseQuaternion("0,0,0,2", "pose")).toThrow(/normalized quaternion/);
  });

  it("defaults to an installed stock fixture outside the current project", () => {
    expect(DEFAULT_RUNTIME_OBSERVER_WORLD).toBe(
      "{96A8AF57260A7392}worlds/MP/MpTest/MpTest.ent"
    );
    expect(DEFAULT_RUNTIME_OBSERVER_POSE_POSITION).toEqual([96, 90, -5]);
    expect(Math.hypot(...DEFAULT_RUNTIME_OBSERVER_POSE_ORIENTATION)).toBeCloseTo(1, 12);
    expect(DEFAULT_RUNTIME_OBSERVER_POSE_FOV).toBe(58);
    expect(DEFAULT_RUNTIME_OBSERVER_LOOK_AT_POSITION).toEqual([64, 121, -40]);
    expect(DEFAULT_RUNTIME_OBSERVER_LOOK_AT_TARGET).toEqual([64, 10, 100]);
    expect(DEFAULT_RUNTIME_OBSERVER_LOOK_AT_FOV).toBe(70);
  });

  it("does not create or accept an explicit worktree artifact root", () => {
    const missing = join(process.cwd(), `.runtime-acceptance-must-not-exist-${randomUUID()}`);
    expect(existsSync(missing)).toBe(false);
    expect(() => resolveRuntimeAcceptanceArtifactRoot(missing)).toThrow(/missing/);
    expect(existsSync(missing)).toBe(false);
    expect(() => resolveRuntimeAcceptanceArtifactRoot(process.cwd())).toThrow(/must not overlap/);
  });

  it("parses the runtime protocol's flat row-major camera matrix", () => {
    const matrix = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      12.5, 34, -7, 1,
    ];
    const baseline = captureMatrix({ actualCamera: { matrix } }, "fixture");
    const restored = captureMatrix({ actualCamera: { matrix: [...matrix] } }, "restored fixture");
    expect(baseline).toEqual(matrix);
    expect(() => assertMatrixClose(baseline, restored, 0.1, "restoration")).not.toThrow();
    restored[12] += 0.2;
    expect(() => assertMatrixClose(baseline, restored, 0.1, "restoration")).toThrow(
      /matrix\[12\]/
    );
    expect(() => captureMatrix({ actualCamera: { matrix: [[1, 0, 0]] } }, "fixture"))
      .toThrow(/flat row-major 4x4/);
  });

  it("uses Enfusion's row-basis quaternion matrix for a non-identity pose", () => {
    const view = {
      kind: "pose" as const,
      position: [96, 90, -5] as [number, number, number],
      orientation: [
        0.3063401817273692,
        -0.14012450476798344,
        0.0456440842650991,
        0.9404453380151182,
      ] as [number, number, number, number],
      fov: 58,
    };
    const matrix = runtimePoseMatrix(view);
    const expectedEnfusionMatrix = [
      0.9565634814702558, 0, 0.29152410863855416, 0,
      -0.1717030650203267, 0.808144621261686, 0.563400682097947, 0,
      -0.23559364036435493, -0.5889841009108874, 0.7730416324455396, 0,
      96, 90, -5, 1,
    ];
    for (let index = 0; index < expectedEnfusionMatrix.length; index += 1) {
      expect(matrix[index]).toBeCloseTo(expectedEnfusionMatrix[index], 10);
    }
    const aimDelta = [64 - 96, 10 - 90, 100 - (-5)];
    const aimDistance = Math.hypot(...aimDelta);
    for (let axis = 0; axis < 3; axis += 1) {
      expect(matrix[8 + axis]).toBeCloseTo(aimDelta[axis] / aimDistance, 10);
    }
    const metadata = {
      requestedView: view,
      actualCamera: { matrix: expectedEnfusionMatrix },
      actualFov: 58,
    };
    expect(assertRequestedPoseRendered(metadata, view)).toEqual(expectedEnfusionMatrix);
    expect(() => assertRequestedPoseRendered(
      { ...metadata, actualFov: 59 },
      view
    )).toThrow(/rendered FOV/);
    const drifted = [...expectedEnfusionMatrix];
    drifted[4] = 0.1;
    expect(() => assertRequestedPoseRendered(
      { ...metadata, actualCamera: { matrix: drifted } },
      view
    )).toThrow(/rendered matrix/);
  });

  it("allows natural current-camera motion but rejects a camera left displaced", () => {
    const displaced = captureMatrix({ actualCamera: { matrix: [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      64, 121, -40, 1,
    ] } }, "displaced fixture");
    const movingCurrent = captureMatrix({ actualCamera: { matrix: [
      0, 0, -1, 0,
      0, 1, 0, 0,
      1, 0, 0, 0,
      127.2, 200, -100, 1,
    ] } }, "moving current fixture");
    expect(assertCurrentViewReleasedFromDisplaced(displaced, movingCurrent)).toBeGreaterThan(5);
    const stillDisplaced = [...displaced] as typeof displaced;
    stillDisplaced[12] += 0.2;
    expect(() => assertCurrentViewReleasedFromDisplaced(displaced, stillDisplaced)).toThrow(
      /remains at the displaced position/
    );
  });

  it("records initial/post image similarity without making natural rotation a failure", () => {
    const comparison = {
      width: 1280,
      height: 720,
      pixelRegion: { x: 0, y: 0, width: 1280, height: 720 },
      comparedPixels: 921_600,
      changedPixels: 700_000,
      changedPixelRatio: 700_000 / 921_600,
      meanAbsoluteError: 34,
      rootMeanSquareError: 49,
      maximumChannelDifference: 255,
      similarityScore: 0.4,
      materiallyDifferent: true,
      materiallySimilar: false,
    };

    expect(recordRestorationImageSimilarity(comparison)).toEqual({
      acceptanceRole: "diagnostic-only",
      reason: expect.stringMatching(/move or rotate naturally/),
      comparison,
    });
  });

  it("uses the public run workflow and exact-owned runtime lifecycle service", () => {
    const source = readFileSync(resolve("scripts/run-runtime-observer-acceptance.ts"), "utf8");
    expect(source).toContain("agentPath: PRIVATE_CHILD_PATH");
    expect(source).toContain("await prepareObserverLaunch(coordinator");
    expect(source).toContain("}, runtimeManager);");
    expect(source).toContain("new OwnedRuntimeManager({");
    expect(source).toContain("executableResolver: () => executable");
    expect(source).toContain("findRuntimeExecutable(options.executablePath)");
    expect(source).toContain("await runtimeManager.start({");
    expect(source.match(/await runtimeManager\.status\(runtimeId\)/g)).toHaveLength(2);
    expect(source).toContain("await runtimeManager.stop({");
    expect(source).toContain("stoppedRuntime.identityVacant !== true");
    expect(source).toContain("vacantRuntime.identityVacant !== true");
    expect(source).toContain('runtimeKind: "listenServer"');
    expect(source).toContain('"-server", worldResource');
    expect(source).toContain("await coordinator.beginRun(");
    expect(source).toContain("await coordinator.instances(");
    expect(source).toContain("await coordinator.capture(");
    expect(source).toContain("await coordinator.finalizeRun(");
    const stopIndex = source.indexOf("await runtimeManager.stop({");
    const revokeIndex = source.indexOf("await coordinator.revokeSession(sessionId)");
    expect(stopIndex).toBeGreaterThan(-1);
    expect(revokeIndex).toBeGreaterThan(stopIndex);
    expect(source).toContain("preserved because exact-process vacancy was not proven");
    expect(source).toContain('imagesReviewed: false');
    expect(source).toContain('outcome: "Unreviewed"');
    expect(source).toContain("resolveRuntimeAcceptanceArtifactRoot(options.artifactRoot)");
    expect(source).toContain("assertExternalRoot(root, label)");
    expect(source).toContain("verifyEvidenceBundle(");
    expect(source).toContain("retainDiagnosticCapture(diagnosticsRoot");
    expect(source).toContain("recordRestorationImageSimilarity(\n      poseRestorationSimilarity");
    expect(source).toContain("recordRestorationImageSimilarity(\n      lookAtRestorationSimilarity");
    expect(source).toContain("restorationImageDiagnosticOnly: true");
    expect(source).not.toContain("if (!poseRestorationSimilarity.materiallySimilar)");
    expect(source).not.toContain("if (!lookAtRestorationSimilarity.materiallySimilar)");
    expect(source).toContain('"explicit-pose"');
    expect(source).toContain('"post-pose-restoration-current"');
    expect(source).toContain('"explicit-look-at"');
    expect(source).toContain('"post-look-at-restoration-current"');
    expect(source).toContain('configurationId: "runtime-observer-acceptance-v2"');
    expect(source).toContain("assertRequestedPoseRendered(pose.metadata, poseView)");
    expect(source).toContain("postPoseDistanceMeters");
    expect(source).toContain("postLookAtDistanceMeters");
    expect(source).toContain('writeFileSync(imagePath, capture.image, { flag: "wx" })');
    expect(source).toContain('diagnostics: removeOwnedScratch(runDirectory, diagnosticsRoot');
    expect(source).not.toMatch(/spawnOwnedRuntime|stopOwnedRuntime|ChildProcess|\.kill\(/);
    expect(source).not.toMatch(/taskkill|Stop-Process|KillProcess|execSync|shell:\s*true/i);
  });

  it("keeps the production observer launcher-neutral", () => {
    const production = [
      "src/observer/coordinator.ts",
      "src/observer/launch.ts",
      "src/observer/setup.ts",
      "src/observer/tools.ts",
    ].map((path) => readFileSync(resolve(path), "utf8")).join("\n");
    expect(production).not.toMatch(/ArmaReforgerSteamDiag|spawnOwnedRuntime|runRuntimeObserverAcceptance/);
  });
});
