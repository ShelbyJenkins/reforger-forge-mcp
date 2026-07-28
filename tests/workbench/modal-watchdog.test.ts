import { describe, expect, it, vi } from "vitest";
import {
  WorkbenchModalWatchdog,
  findOwnedNativeDialog,
} from "../../src/workbench/modal-watchdog.js";
import type { WorkbenchWindow } from "../../src/workbench/process-guard.js";

const mainWindow: WorkbenchWindow = {
  handle: "100",
  ownerHandle: "0",
  className: "EnfusionWorkbench",
  title: "Workbench",
  visible: true,
  enabled: true,
  iconic: false,
};

const nativeDialog: WorkbenchWindow = {
  handle: "200",
  ownerHandle: "100",
  className: "#32770",
  title: "Save As",
  visible: true,
  enabled: true,
  iconic: false,
};

const standaloneNativeDialog: WorkbenchWindow = {
  handle: "300",
  ownerHandle: "0",
  className: "Qt683QWindowIcon",
  title: "Workbench confirmation",
  visible: true,
  enabled: true,
  iconic: false,
};

describe("WorkbenchModalWatchdog", () => {
  it("recognizes an already-visible owned dialog before a save is dispatched", () => {
    expect(findOwnedNativeDialog([mainWindow, nativeDialog])).toEqual(nativeDialog);
    expect(findOwnedNativeDialog([mainWindow])).toBeUndefined();
  });

  it("closes only a newly visible owned dialog", async () => {
    const inspect = vi.fn()
      .mockResolvedValueOnce([mainWindow])
      .mockResolvedValueOnce([mainWindow, nativeDialog])
      .mockResolvedValueOnce([mainWindow]);
    const close = vi.fn(async () => true);
    const watchdog = new WorkbenchModalWatchdog({ inspect, close });
    const abort = new AbortController();

    const baseline = await watchdog.snapshot();
    const evidence = await watchdog.waitForNewModal(baseline, abort.signal);

    expect(evidence).toMatchObject({
      kind: "owned_modal",
      closeAttempted: true,
      closePosted: true,
      dismissed: true,
      window: nativeDialog,
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith({
      handle: nativeDialog.handle,
      ownerHandle: nativeDialog.ownerHandle,
      className: nativeDialog.className,
      title: nativeDialog.title,
      kind: "owned_child",
    });
  });

  it("closes the sole new standalone dialog only after an exact main window becomes disabled", async () => {
    const inspect = vi.fn()
      .mockResolvedValueOnce([mainWindow])
      .mockResolvedValueOnce([{ ...mainWindow, enabled: false }, standaloneNativeDialog])
      .mockResolvedValueOnce([{ ...mainWindow, enabled: false }]);
    const close = vi.fn(async () => true);
    const watchdog = new WorkbenchModalWatchdog({ inspect, close });
    const abort = new AbortController();

    const evidence = await watchdog.waitForNewModal(await watchdog.snapshot(), abort.signal);

    expect(evidence).toMatchObject({
      kind: "standalone_modal",
      closeAttempted: true,
      closePosted: true,
      dismissed: true,
      window: standaloneNativeDialog,
      disabledMainWindow: { ...mainWindow, enabled: false },
    });
    expect(close).toHaveBeenCalledWith({
      handle: standaloneNativeDialog.handle,
      ownerHandle: standaloneNativeDialog.ownerHandle,
      className: standaloneNativeDialog.className,
      title: standaloneNativeDialog.title,
      kind: "disabled_main_new_top_level",
      disabledMainHandle: mainWindow.handle,
    });
  });

  it("fails closed when the baseline main window becomes disabled without a closable child", async () => {
    const inspect = vi.fn()
      .mockResolvedValueOnce([mainWindow])
      .mockResolvedValueOnce([{ ...mainWindow, enabled: false }]);
    const close = vi.fn(async () => true);
    const watchdog = new WorkbenchModalWatchdog({ inspect, close });
    const abort = new AbortController();

    const evidence = await watchdog.waitForNewModal(await watchdog.snapshot(), abort.signal);

    expect(evidence).toMatchObject({
      kind: "disabled_main_window",
      closeAttempted: false,
      closePosted: false,
      dismissed: false,
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("fails closed when a disabled main window has multiple new unowned candidates", async () => {
    const inspect = vi.fn()
      .mockResolvedValueOnce([mainWindow])
      .mockResolvedValueOnce([
        { ...mainWindow, enabled: false },
        standaloneNativeDialog,
        { ...standaloneNativeDialog, handle: "301", title: "Another window" },
      ]);
    const close = vi.fn(async () => true);
    const watchdog = new WorkbenchModalWatchdog({ inspect, close });
    const abort = new AbortController();

    const evidence = await watchdog.waitForNewModal(await watchdog.snapshot(), abort.signal);

    expect(evidence).toMatchObject({ kind: "disabled_main_window", closeAttempted: false });
    expect(close).not.toHaveBeenCalled();
  });

  it("stops promptly when the save settles before any dialog appears", async () => {
    const inspect = vi.fn(async () => [mainWindow]);
    const close = vi.fn(async () => true);
    const watchdog = new WorkbenchModalWatchdog({ inspect, close });
    const abort = new AbortController();
    const baseline = await watchdog.snapshot();
    abort.abort();

    await expect(watchdog.waitForNewModal(baseline, abort.signal)).resolves.toBeNull();
    expect(close).not.toHaveBeenCalled();
  });
});
