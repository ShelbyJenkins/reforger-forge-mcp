import { register } from "tsx/esm/api";

// ObserverCoordinator intentionally clears inherited execArgv. Register the
// repository's checked-in TypeScript loader inside this hermetic child, then
// run the real private-child entry point over a genuine Node IPC boundary.
register();
const { runPrivateObserverChild } = await import("../../../observer/agent/private-child.ts");
await runPrivateObserverChild(process.argv.slice(2));
