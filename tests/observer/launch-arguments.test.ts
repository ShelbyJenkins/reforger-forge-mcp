import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ObserverControlApi } from "../../observer/agent/control-api.js";
import { mergeLaunchArguments } from "../../observer/agent/launch-arguments.js";
import { MailboxTransport } from "../../observer/agent/mailbox.js";
import { mergeConfiguredAddonDirectories } from "../../src/observer/tools.js";
import { ADDON_GUID, SESSION_CONTRACT_NAME, SESSION_DIRECTORY_NAME } from "../../observer/protocol/index.js";
import { observerAddonSource } from "../support/observer-fixtures.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

describe("observer launch preparation", () => {
  it("preserves unrelated tokens, merges singleton flags, and does not quote paths", async () => {
    await withTemporaryDirectory((root) => {
    const profile = join(root, "profiles", "run 1");
    const search = join(root, "staged root");
    const addon = join(search, "ReforgerForgeObserver");
    const other = join(root, "other addons");
    mkdirSync(profile, { recursive: true });
    mkdirSync(addon, { recursive: true });
    mkdirSync(other, { recursive: true });
    const result = mergeLaunchArguments({
      arguments: ["-client", "-addonsDir", other, "-addons", "TargetAddon", "-profile", profile, "-someFlag", "value"],
      profilePath: profile,
      addonSearchRoot: search,
      stagedAddonPath: addon,
      logsDirectoryName: "observer-test-session",
      forceUpdate: false,
      noFocus: false,
    });
    expect(result.slice(0, 3)).toEqual(["-client", "-someFlag", "value"]);
    expect(result.filter((value) => value.toLowerCase() === "-addonsdir")).toHaveLength(1);
    expect(result.filter((value) => value.toLowerCase() === "-profile")).toHaveLength(1);
    expect(result.slice(result.indexOf("-logsDir"), result.indexOf("-logsDir") + 2))
      .toEqual(["-logsDir", "observer-test-session"]);
    expect(result).not.toContain("-forceUpdate");
    expect(result).not.toContain("-noFocus");
    expect(result.some((value) => value.startsWith('"'))).toBe(false);
      expect(result[result.indexOf("-addons") + 1].split(",")).toEqual(["TargetAddon", ADDON_GUID]);
    }, { prefix: "rfo space test-" });
  });

  it("refuses a conflicting profile", async () => {
    await withTemporaryDirectory((root) => {
    const profile = join(root, "profiles", "one");
    const otherProfile = join(root, "profiles", "two");
    const search = join(root, "search");
    const addon = join(search, "ReforgerForgeObserver");
    [profile, otherProfile, addon].forEach((path) => mkdirSync(path, { recursive: true }));
    expect(() => mergeLaunchArguments({ arguments: ["-profile", otherProfile], profilePath: profile, addonSearchRoot: search, stagedAddonPath: addon, logsDirectoryName: "observer-test-session", forceUpdate: false, noFocus: false }))
      .toThrowError(expect.objectContaining({ code: "PROFILE_CONFLICT" }));
    });
  });

  it("refuses caller-supplied -logsDir authority, including absolute paths", async () => {
    await withTemporaryDirectory((root) => {
      const profile = join(root, "profiles", "one");
      const search = join(root, "search");
      const addon = join(search, "ReforgerForgeObserver");
      mkdirSync(profile, { recursive: true });
      mkdirSync(addon, { recursive: true });
      expect(() => mergeLaunchArguments({
        arguments: ["-logsDir", join(root, "caller-logs")],
        profilePath: profile,
        addonSearchRoot: search,
        stagedAddonPath: addon,
        logsDirectoryName: "observer-test-session",
        forceUpdate: false,
        noFocus: false,
      })).toThrowError(expect.objectContaining({
        code: "ARGUMENT_CONFLICT",
        message: expect.stringContaining("assigns its own session-specific -logsDir"),
      }));
    }, { prefix: "rfo-logs-dir-conflict-" });
  });

  it("defaults to appending both -forceUpdate and -noFocus when requested", async () => {
    await withTemporaryDirectory((root) => {
      const profile = join(root, "profiles", "run");
      const search = join(root, "staged");
      const addon = join(search, "ReforgerForgeObserver");
      mkdirSync(profile, { recursive: true });
      mkdirSync(addon, { recursive: true });
      const result = mergeLaunchArguments({
        arguments: [],
        profilePath: profile,
        addonSearchRoot: search,
        stagedAddonPath: addon,
        logsDirectoryName: "observer-test-session",
        forceUpdate: true,
        noFocus: true,
      });
      expect(result).toContain("-forceUpdate");
      expect(result).toContain("-noFocus");
    });
  });

  it("dedupes manually supplied -forceUpdate and -noFocus instead of doubling them", async () => {
    await withTemporaryDirectory((root) => {
      const profile = join(root, "profiles", "run");
      const search = join(root, "staged");
      const addon = join(search, "ReforgerForgeObserver");
      mkdirSync(profile, { recursive: true });
      mkdirSync(addon, { recursive: true });
      const result = mergeLaunchArguments({
        arguments: ["-forceUpdate", "-noFocus"],
        profilePath: profile,
        addonSearchRoot: search,
        stagedAddonPath: addon,
        logsDirectoryName: "observer-test-session",
        forceUpdate: false,
        noFocus: false,
      });
      expect(result.filter((value) => value === "-forceUpdate")).toHaveLength(1);
      expect(result.filter((value) => value === "-noFocus")).toHaveLength(1);
    });
  });

  it("keeps configured game and Workshop roots before caller roots and normalizes duplicates once", async () => {
    await withTemporaryDirectory((root) => {
      const profile = join(root, "profiles", "run");
      const gameAddons = join(root, "game-addons");
      const workshopAddons = join(root, "workshop-addons");
      const callerAddons = join(root, "caller-addons");
      const observerRoot = join(root, "staged");
      const observerAddon = join(observerRoot, "ReforgerForgeObserver");
      [profile, gameAddons, workshopAddons, callerAddons, observerAddon]
        .forEach((path) => mkdirSync(path, { recursive: true }));

      const argumentsArray = mergeConfiguredAddonDirectories(
        ["-server", "-addonsDir", `${callerAddons},${workshopAddons}`],
        [gameAddons, workshopAddons, gameAddons],
      );
      expect(argumentsArray).toEqual([
        "-addonsDir", `${gameAddons},${workshopAddons},${gameAddons}`,
        "-server", "-addonsDir", `${callerAddons},${workshopAddons}`,
      ]);

      const merged = mergeLaunchArguments({
        arguments: argumentsArray,
        profilePath: profile,
        addonSearchRoot: observerRoot,
        stagedAddonPath: observerAddon,
        logsDirectoryName: "observer-test-session",
        forceUpdate: false,
        noFocus: false,
      });
      expect(merged[merged.indexOf("-addonsDir") + 1].split(",")).toEqual([
        gameAddons,
        workshopAddons,
        callerAddons,
        observerRoot,
      ]);
    }, { prefix: "rfo-configured-addon-roots-" });
  });

  it("accepts the public caller-token limit plus the internally configured addon pair", async () => {
    await withTemporaryDirectory(async (root) => {
      const profiles = join(root, "profiles");
      const configuredAddons = join(root, "configured-addons");
      mkdirSync(profiles, { recursive: true });
      mkdirSync(configuredAddons, { recursive: true });
      const control = new ObserverControlApi({
        root: join(root, "managed"),
        profileRoot: profiles,
        sourceDirectory: observerAddonSource,
      });
      control.setEndpoint("127.0.0.1", 47831);
      const callerArguments = Array.from({ length: 512 }, (_, index) => `-caller-${index}`);

      const prepared = await control.prepareLaunch({
        runtimeKind: "client",
        arguments: ["-addonsDir", configuredAddons, ...callerArguments],
        profilePath: join(profiles, "run-max-caller-arguments"),
        sessionTtlMs: 60_000,
        transportPreference: ["rest"],
        forceUpdate: false,
        noFocus: false,
      });

      expect(prepared.arguments).toContain("-caller-511");
      expect(prepared.arguments[prepared.arguments.indexOf("-addonsDir") + 1])
        .toContain(configuredAddons);
    }, { prefix: "rfo-configured-addon-limit-" });
  });

  it("retains the approved root internally and provides the doctor recovery action", async () => {
    await withTemporaryDirectory(async (root) => {
      const profiles = join(root, "approved-profiles");
      const outside = join(root, "operating-system-temp-profile");
      mkdirSync(profiles, { recursive: true });
      mkdirSync(outside, { recursive: true });
      const control = new ObserverControlApi({
        root: join(root, "managed"),
        profileRoot: profiles,
        sourceDirectory: observerAddonSource,
      });
      control.setEndpoint("127.0.0.1", 47831);
      const rejected = control.prepareLaunch({
        runtimeKind: "client",
        arguments: ["-addons", "36374155AAC14289"],
        profilePath: outside,
        sessionTtlMs: 60_000,
        transportPreference: ["rest"],
        forceUpdate: false,
      });

      await expect(rejected).rejects.toMatchObject({
        code: "PROFILE_CONFLICT",
        message: expect.stringContaining(profiles),
      });
      await expect(rejected).rejects.toThrow(/observer_setup.*doctor.*profileRoot/);
    });
  });

  it("prepares idempotently and writes the session contract last", async () => {
    await withTemporaryDirectory(async (root) => {
    const profiles = join(root, "profiles");
    mkdirSync(profiles, { recursive: true });
    const control = new ObserverControlApi({ root: join(root, "managed"), profileRoot: profiles, sourceDirectory: observerAddonSource });
    control.setEndpoint("127.0.0.1", 47831);
    const request = {
      runtimeKind: "client" as const,
      arguments: ["-client"],
      profilePath: join(profiles, "run-1"),
      sessionTtlMs: 60_000,
      transportPreference: ["rest" as const],
      forceUpdate: false,
      idempotencyKey: "launch-1",
    };
    const first = await control.prepareLaunch(request);
    const second = await control.prepareLaunch(request);
    expect(second).toEqual(first);
    const contract = JSON.parse(readFileSync(first.session.contractPath, "utf8"));
    expect(contract.sessionId).toBe(first.session.sessionId);
    expect(first.arguments).toContain(ADDON_GUID);

    const launchProfile = first.session.profilePath;
    const observerDirectory = join(launchProfile, "profile", SESSION_DIRECTORY_NAME);
    expect(first.arguments[first.arguments.indexOf("-profile") + 1]).toBe(launchProfile);
    expect(first.session.contractPath).toBe(join(observerDirectory, SESSION_CONTRACT_NAME));
    const logsDirectoryName = `observer-${first.session.sessionId}`;
    expect(first.arguments.slice(first.arguments.indexOf("-logsDir"), first.arguments.indexOf("-logsDir") + 2))
      .toEqual(["-logsDir", logsDirectoryName]);
    expect(existsSync(join(launchProfile, "profile", "logs", logsDirectoryName))).toBe(true);
    expect(existsSync(join(launchProfile, SESSION_DIRECTORY_NAME))).toBe(false);
    expect(existsSync(join(observerDirectory, "captures"))).toBe(true);

    const mailbox = new MailboxTransport(launchProfile);
    expect(mailbox.commandsDirectory).toBe(join(observerDirectory, "mailbox", "commands"));
    expect(mailbox.statusDirectory).toBe(join(observerDirectory, "mailbox", "status"));
    });
  });
});
