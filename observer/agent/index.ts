import { pathToFileURL } from "node:url";
import { AGENT_VERSION } from "../protocol/index.js";

export { AGENT_VERSION };
export * from "./artifacts.js";
export * from "./application.js";
export * from "./bmp.js";
export * from "./control-api.js";
export * from "./control-client.js";
export * from "./evidence-bundle-service.js";
export * from "./application-operations.js";
export * from "./errors.js";
export * from "./jobs.js";
export * from "./launch-arguments.js";
export * from "./mailbox.js";
export * from "./mailbox-coordinator.js";
export * from "./paths.js";
export * from "./registry.js";
export * from "./runs.js";
export * from "./server.js";
export * from "./sessions.js";
export * from "./staging.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { runCli } = await import("./cli.js");
  await runCli(process.argv.slice(2));
}
