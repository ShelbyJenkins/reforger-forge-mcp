/**
 * Stable public Workbench client import.
 *
 * Stage 3 moved lifecycle ownership into WorkbenchSessionController. Keep the
 * historical WorkbenchClient name as a compatibility alias so tools and
 * published consumers do not require a flag-day import migration.
 */
export * from "./session-controller.js";
export { WorkbenchSessionController as WorkbenchClient } from "./session-controller.js";
export type { DiagnosticReport, LifecycleDiagnostic } from "./diagnostics.js";
