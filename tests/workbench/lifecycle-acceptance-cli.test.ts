import { describe, expect, it } from "vitest";
import {
  LIVE_WORKBENCH_LIFECYCLE_ENVIRONMENT,
  parseWorkbenchLifecycleArguments,
} from "../../scripts/run-workbench-lifecycle-acceptance.js";

describe("Workbench lifecycle acceptance CLI", () => {
  it("requires an explicit, singleton config path for live execution", () => {
    const parsed = parseWorkbenchLifecycleArguments([
      "--config",
      "machine.json",
      "--confirm-live-run",
    ]);

    expect(parsed.configPath).toMatch(/[\\/]machine\.json$/);
    expect(parsed.confirmed).toBe(true);
    expect(parsed.initialDwellMs).toBe(0);
    expect(parsed.restartedDwellMs).toBe(0);
    expect(LIVE_WORKBENCH_LIFECYCLE_ENVIRONMENT).toBe(
      "RFO_RUN_LIVE_WORKBENCH_LIFECYCLE_ACCEPTANCE"
    );
    expect(() => parseWorkbenchLifecycleArguments([
      "--config",
      "first.json",
      "--config",
      "second.json",
    ])).toThrow(/--config may be specified only once/);
  });

  it("parses bounded dwell overrides and rejects unknown or incomplete input", () => {
    const parsed = parseWorkbenchLifecycleArguments([
      "--initial-dwell-ms",
      "210000",
      "--restart-dwell-ms",
      "60000",
    ]);

    expect(parsed.initialDwellMs).toBe(210_000);
    expect(parsed.restartedDwellMs).toBe(60_000);
    expect(() => parseWorkbenchLifecycleArguments(["--config"])).toThrow(
      /--config requires a value/
    );
    expect(() => parseWorkbenchLifecycleArguments(["--mystery"])).toThrow(
      /Unknown lifecycle acceptance argument/
    );
    expect(() => parseWorkbenchLifecycleArguments([
      "--initial-dwell-ms",
      "3600001",
    ])).toThrow(/0 through 3600000/);
  });
});
