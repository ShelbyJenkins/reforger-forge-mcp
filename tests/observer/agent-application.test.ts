import { describe, expect, it } from "vitest";
import { createObserverApplication } from "../../observer/agent/application.js";
import { cleanup, observerAddonSource, temporaryDirectory } from "./helpers.js";

describe("observer application root", () => {
  it("constructs one shared graph with explicit options", async () => {
    const root = temporaryDirectory("rfo-application-");
    try {
      const app = createObserverApplication({ root, sourceDirectory: observerAddonSource });
      expect(app.control).toBeDefined();
      expect(app.server).toBeDefined();
      await app.server.close();
    } finally { cleanup(root); }
  });
});

