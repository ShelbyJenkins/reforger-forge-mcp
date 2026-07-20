import { describe, expect, it } from "vitest";
import { createObserverApplication } from "../../observer/agent/application.js";
import { observerAddonSource } from "../support/observer-fixtures.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

describe("observer application root", () => {
  it("constructs one shared graph with explicit options", async () => {
    await withTemporaryDirectory(async (root) => {
      const app = createObserverApplication({ root, sourceDirectory: observerAddonSource });
      expect(app.control).toBeDefined();
      expect(app.server).toBeDefined();
      await app.server.close();
    }, { prefix: "rfo-application-" });
  });
});
