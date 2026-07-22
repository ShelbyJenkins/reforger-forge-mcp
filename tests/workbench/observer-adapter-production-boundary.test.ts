import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  WorkbenchObserverAdapter,
  type WorkbenchObserverAdapterOptions,
} from "../../src/workbench/observer-adapter.js";

type ForbiddenProductionAdapterMethod = Extract<
  keyof WorkbenchObserverAdapter,
  | "armOneShotBeforeSubmitDelivery"
  | "armOneShotBeforeRelease"
  | "requireExactOwnerExit"
  | "confirmExactOwnerExit"
>;

type ForbiddenProductionAdapterOption = Extract<
  keyof WorkbenchObserverAdapterOptions,
  "beforeArtifactValidation" | "verifyIdempotentReleaseReplay"
>;

describe("Workbench observer production adapter boundary", () => {
  it("keeps repository acceptance controls out of the shipped public types", () => {
    expectTypeOf<ForbiddenProductionAdapterMethod>().toEqualTypeOf<never>();
    expectTypeOf<ForbiddenProductionAdapterOption>().toEqualTypeOf<never>();
  });

  it("keeps repository-only acceptance state out of the production implementation", () => {
    const productionSource = readFileSync(
      join(process.cwd(), "src", "workbench", "observer-adapter.ts"),
      "utf8"
    );
    for (const acceptanceOnlyIdentifier of [
      "armOneShotBeforeSubmitDelivery",
      "armOneShotBeforeRelease",
      "requireExactOwnerExit",
      "confirmExactOwnerExit",
      "exactOwnerExitRequired",
      "exactOwnerExitConfirmed",
      "artifactPreValidationInvoked",
      "beforeArtifactValidation",
      "verifyIdempotentReleaseReplay",
    ]) {
      expect(productionSource).not.toContain(acceptanceOnlyIdentifier);
    }
  });
});

