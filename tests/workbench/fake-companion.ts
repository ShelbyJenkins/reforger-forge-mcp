import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  WORKBENCH_HELPER_ADDON_GUID,
  WORKBENCH_HELPER_ADDON_ID,
  WORKBENCH_HELPER_ADDON_VERSION,
  WORKBENCH_HELPER_BUILD_IDENTITY,
  WORKBENCH_HELPER_PROTOCOL_VERSION,
  type WorkbenchCompanionLaunch,
  type WorkbenchCompanionProvider,
} from "../../src/workbench/helper-addon.js";
import type { WorkbenchCompanionLifecycleState } from "../../src/workbench/process-guard.js";

export const FAKE_COMPANION_BUNDLE_DIGEST = "a".repeat(64);

export const WORKBENCH_HELPER_PING_RESPONSE = Object.freeze({
  status: "ok",
  mode: "edit",
  helperAddonId: WORKBENCH_HELPER_ADDON_ID,
  helperAddonGuid: WORKBENCH_HELPER_ADDON_GUID,
  helperAddonVersion: WORKBENCH_HELPER_ADDON_VERSION,
  helperProtocolVersion: WORKBENCH_HELPER_PROTOCOL_VERSION,
  helperBuildIdentity: WORKBENCH_HELPER_BUILD_IDENTITY,
});

export function createFakeCompanionLaunch(root: string): WorkbenchCompanionLaunch {
  const addonSearchRoot = join(root, "managed-helper", "addons");
  const addonDirectory = join(addonSearchRoot, WORKBENCH_HELPER_ADDON_ID);
  const workbenchProfilePath = join(root, "managed-helper", "profile");
  mkdirSync(addonDirectory, { recursive: true });
  mkdirSync(workbenchProfilePath, { recursive: true });
  return {
    addonId: WORKBENCH_HELPER_ADDON_ID,
    addonGuid: WORKBENCH_HELPER_ADDON_GUID,
    addonVersion: WORKBENCH_HELPER_ADDON_VERSION,
    protocolVersion: WORKBENCH_HELPER_PROTOCOL_VERSION,
    buildIdentity: WORKBENCH_HELPER_BUILD_IDENTITY,
    bundleDigest: FAKE_COMPANION_BUNDLE_DIGEST,
    addonDirectory,
    addonSearchRoot,
    workbenchProfilePath,
    reused: false,
  };
}

export function fakeCompanionProvider(
  launch: WorkbenchCompanionLaunch
): WorkbenchCompanionProvider {
  return {
    ensureStaged: () => launch,
    verifyStaged: (candidate) => candidate,
  };
}

export function companionLifecycleState(
  launch: WorkbenchCompanionLaunch
): WorkbenchCompanionLifecycleState {
  return {
    addonId: launch.addonId,
    addonGuid: launch.addonGuid,
    addonDirectory: launch.addonDirectory,
    addonSearchRoot: launch.addonSearchRoot,
    bundleDigest: launch.bundleDigest,
    buildIdentity: launch.buildIdentity,
    profilePath: launch.workbenchProfilePath,
  };
}
