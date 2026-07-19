import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPABILITY_REGISTRY,
  ERROR_REGISTRY,
  type ObserverCapabilityDefinition,
  type ObserverErrorDefinition,
} from "../observer/protocol/registry.js";

export interface ProtocolRegistrySource {
  errorRegistry: Readonly<Record<string, ObserverErrorDefinition>>;
  capabilityRegistry: Readonly<Record<string, ObserverCapabilityDefinition>>;
}

export const CANONICAL_PROTOCOL_REGISTRIES: ProtocolRegistrySource = {
  errorRegistry: ERROR_REGISTRY,
  capabilityRegistry: CAPABILITY_REGISTRY,
};

export const PROTOCOL_ARTIFACT_PATHS = [
  "observer/protocol/generated/error-codes.json",
  "observer/protocol/generated/runtime-error-codes.json",
  "observer/protocol/generated/capabilities.json",
  "observer/protocol/generated/fixed-error-messages.json",
  "observer/protocol/schemas/error.schema.json",
  "observer/protocol/schemas/heartbeat.schema.json",
  "observer/protocol/schemas/job-status.schema.json",
  "observer/protocol/schemas/vocabulary.schema.json",
  "observer/protocol/errors.md",
  "observer/protocol/capabilities.md",
] as const;

export type ProtocolArtifactPath = (typeof PROTOCOL_ARTIFACT_PATHS)[number];
export type ProtocolArtifacts = ReadonlyMap<ProtocolArtifactPath, string>;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDirectory, "..");

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function markdownCell(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\r\n", "<br>")
    .replaceAll("\n", "<br>")
    .replaceAll("\r", "<br>");
}

function stringEnum(values: readonly string[]): { type: "string"; enum: string[] } {
  if (values.length === 0) {
    throw new Error("Generated protocol vocabulary enums must not be empty");
  }
  return { type: "string", enum: [...values] };
}

const ERROR_RESPONSE_SCHEMA_TEMPLATE = String.raw`{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://reforger-forge.dev/observer/v1/error.schema.json",
  "title": "Observer error response",
  "type": "object",
  "required": ["protocolVersion", "error"],
  "properties": {
    "protocolVersion": { "const": "1.0" },
    "error": { "type": "object", "required": ["code", "message"], "properties": { "code": { "type": "string", "enum": "__ERROR_CODES__" }, "message": { "type": "string", "maxLength": 512 } } }
  }
}`;

const HEARTBEAT_SCHEMA_TEMPLATE = String.raw`{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://reforger-forge.dev/observer/v1/heartbeat.schema.json",
  "title": "Observer heartbeat",
  "type": "object",
  "required": ["protocolVersion", "sessionId", "instanceId", "instanceNonce", "sequence", "sentAt", "worldId", "worldEpoch", "capabilities", "transportHealthy"],
  "properties": {
    "protocolVersion": { "type": "string", "pattern": "^1\\.[0-9]+$" },
    "sessionId": { "$ref": "#/$defs/id" },
    "instanceId": { "$ref": "#/$defs/id" },
    "instanceNonce": { "type": "string", "minLength": 32, "maxLength": 256 },
    "sequence": { "type": "integer", "minimum": 0 },
    "sentAt": { "type": "string", "format": "date-time" },
    "worldId": { "oneOf": [{ "type": "string", "minLength": 1, "maxLength": 512 }, { "type": "null" }] },
    "worldEpoch": { "type": "integer", "minimum": 0 },
    "capabilities": { "type": "array", "maxItems": 64, "items": { "type": "string", "maxLength": 64 } },
    "activeJobId": { "oneOf": [{ "$ref": "#/$defs/id" }, { "type": "null" }] },
    "cameraLeaseJobId": { "oneOf": [{ "$ref": "#/$defs/id" }, { "type": "null" }] },
    "transportHealthy": { "type": "boolean" },
    "lastErrorCode": {
      "oneOf": [
        { "type": "string", "enum": "__RUNTIME_ERROR_CODES__" },
        { "type": "null" }
      ]
    }
  },
  "$defs": { "id": { "type": "string", "pattern": "^[A-Za-z0-9_-]{1,96}$" } }
}`;

const JOB_STATUS_SCHEMA_TEMPLATE = String.raw`{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://reforger-forge.dev/observer/v1/job-status.schema.json",
  "title": "Observer job status",
  "type": "object",
  "required": ["protocolVersion", "sessionId", "instanceId", "instanceNonce", "jobId", "sequence", "state", "worldId", "worldEpoch", "timestamp"],
  "properties": {
    "protocolVersion": { "type": "string", "pattern": "^1\\.[0-9]+$" },
    "sessionId": { "$ref": "#/$defs/id" },
    "instanceId": { "$ref": "#/$defs/id" },
    "instanceNonce": { "type": "string", "minLength": 32, "maxLength": 256 },
    "jobId": { "$ref": "#/$defs/id" },
    "sequence": { "type": "integer", "minimum": 0 },
    "state": { "enum": ["queued", "dispatched", "accepted", "resolving", "preloading", "acquiringCamera", "positioning", "settling", "capturing", "awaitingArtifact", "restoring", "completed", "failed", "cancelled"] },
    "worldId": { "oneOf": [{ "type": "string", "minLength": 1, "maxLength": 512 }, { "type": "null" }] },
    "worldEpoch": { "type": "integer", "minimum": 0 },
    "timestamp": { "type": "string", "format": "date-time" },
    "deliveryToken": { "type": "string", "minLength": 16, "maxLength": 256, "pattern": "^[A-Za-z0-9_-]+$" },
    "cameraLease": {
      "oneOf": [
        {
          "type": "object",
          "required": ["held", "leaseId", "observerCameraId"],
          "properties": {
            "held": { "const": true },
            "leaseId": { "$ref": "#/$defs/id" },
            "observerCameraId": { "oneOf": [{ "$ref": "#/$defs/id" }, { "type": "integer", "minimum": 0 }] }
          }
        },
        {
          "type": "object",
          "required": ["held", "restorationConfirmed"],
          "properties": {
            "held": { "const": false },
            "restorationConfirmed": { "type": "boolean" }
          }
        }
      ]
    },
    "errorCode": { "type": "string", "enum": "__RUNTIME_ERROR_CODES__" },
    "message": { "type": "string", "maxLength": 512 }
  },
  "$defs": { "id": { "type": "string", "pattern": "^[A-Za-z0-9_-]{1,96}$" } }
}`;

function renderSchemaTemplate(
  template: string,
  replacements: Readonly<Record<string, readonly string[]>>
): string {
  let rendered = template.trim().replaceAll("\r\n", "\n");
  for (const [name, values] of Object.entries(replacements)) {
    const marker = JSON.stringify(`__${name}__`);
    if (!rendered.includes(marker)) {
      throw new Error(`Protocol schema template is missing marker ${marker}`);
    }
    rendered = rendered.replaceAll(marker, JSON.stringify(values));
  }
  const unresolvedMarker = /__[A-Z][A-Z0-9_]*__/.exec(rendered)?.[0];
  if (unresolvedMarker) {
    throw new Error(`Protocol schema template has unresolved marker ${unresolvedMarker}`);
  }
  JSON.parse(rendered);
  return `${rendered}\n`;
}

function renderErrorsMarkdown(
  entries: ReadonlyArray<readonly [string, ObserverErrorDefinition]>
): string {
  const rows = entries.map(([code, definition]) => [
    code,
    definition.publicMessagePolicy,
    definition.retryable ? "yes" : "no",
    definition.backends.join(", "),
    markdownCell(definition.publicMessage),
  ].join(" | "));

  return [
    "# Observer protocol errors",
    "",
    "<!-- Generated by `npm run protocol:generate` from `observer/protocol/registry.ts`. Do not edit. -->",
    "",
    "Consumers branch on the stable code; diagnostic prose is bounded to 512 characters. A `fixed`",
    "message policy suppresses backend prose. Backend-private Workbench handler and lifecycle values",
    "are accepted only at the adapter boundary and mapped to their host equivalents before MCP",
    "publication.",
    "",
    "| Code | Message policy | Retryable | Applicable backends | Public/fallback message |",
    "|---|---|---:|---|---|",
    ...rows.map((row) => `| ${row} |`),
    "",
    "`RESTORATION_UNCONFIRMED` is a hard safety failure: the renderer remains unavailable until a",
    "later explicit state proves safe restoration.",
    "",
  ].join("\n");
}

function renderCapabilitiesMarkdown(
  entries: ReadonlyArray<readonly [string, ObserverCapabilityDefinition]>
): string {
  const rows = entries.map(([capability, definition]) => [
    `\`${markdownCell(capability)}\``,
    definition.backends.join(", "),
    markdownCell(definition.proof),
  ].join(" | "));

  return [
    "# Observer protocol capabilities",
    "",
    "<!-- Generated by `npm run protocol:generate` from `observer/protocol/registry.ts`. Do not edit. -->",
    "",
    "A capability is routable only on a backend listed below and only after that backend's producer",
    "proves initialization. Unknown claims remain diagnostic and are never used for routing.",
    "",
    "| Capability | Proving backend | Required proof |",
    "|---|---|---|",
    ...rows.map((row) => `| ${row} |`),
    "",
    "`entity.resolve` and `server.coordinate` are deliberately absent until an implementation and",
    "conformance test can prove them. Headless runtimes also strip render/camera claims; a runtime",
    "can never route `camera.editor` merely because that capability is globally known for Workbench.",
    "",
  ].join("\n");
}

/**
 * Render every registry-derived artifact in canonical registry insertion order.
 * The returned bytes are platform-independent (UTF-8 with LF line endings).
 */
export function renderProtocolArtifacts(
  source: ProtocolRegistrySource = CANONICAL_PROTOCOL_REGISTRIES
): ProtocolArtifacts {
  const errorEntries = Object.entries(source.errorRegistry);
  const capabilityEntries = Object.entries(source.capabilityRegistry);
  const errorCodes = errorEntries.map(([code]) => code);
  const runtimeErrorCodes = errorEntries
    .filter(([, definition]) => definition.backends.includes("runtime"))
    .map(([code]) => code);
  const capabilities = capabilityEntries.map(([capability]) => capability);
  const runtimeCapabilities = capabilityEntries
    .filter(([, definition]) => definition.backends.includes("runtime"))
    .map(([capability]) => capability);
  const workbenchCapabilities = capabilityEntries
    .filter(([, definition]) => definition.backends.includes("workbench"))
    .map(([capability]) => capability);
  const fixedErrorMessages = Object.fromEntries(errorEntries
    .filter(([, definition]) => definition.publicMessagePolicy === "fixed")
    .map(([code, definition]) => [code, definition.publicMessage]));

  const vocabularySchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://reforger-forge.dev/observer/v1/vocabulary.schema.json",
    title: "Observer protocol registry vocabulary",
    $comment: "Generated by npm run protocol:generate from observer/protocol/registry.ts. Do not edit.",
    $defs: {
      errorCode: stringEnum(errorCodes),
      runtimeErrorCode: stringEnum(runtimeErrorCodes),
      capability: stringEnum(capabilities),
      runtimeCapability: stringEnum(runtimeCapabilities),
      workbenchCapability: stringEnum(workbenchCapabilities),
    },
  };

  return new Map<ProtocolArtifactPath, string>([
    ["observer/protocol/generated/error-codes.json", json(errorCodes)],
    ["observer/protocol/generated/runtime-error-codes.json", json(runtimeErrorCodes)],
    ["observer/protocol/generated/capabilities.json", json(capabilities)],
    ["observer/protocol/generated/fixed-error-messages.json", json(fixedErrorMessages)],
    ["observer/protocol/schemas/error.schema.json", renderSchemaTemplate(
      ERROR_RESPONSE_SCHEMA_TEMPLATE,
      { ERROR_CODES: errorCodes }
    )],
    ["observer/protocol/schemas/heartbeat.schema.json", renderSchemaTemplate(
      HEARTBEAT_SCHEMA_TEMPLATE,
      { RUNTIME_ERROR_CODES: runtimeErrorCodes }
    )],
    ["observer/protocol/schemas/job-status.schema.json", renderSchemaTemplate(
      JOB_STATUS_SCHEMA_TEMPLATE,
      { RUNTIME_ERROR_CODES: runtimeErrorCodes }
    )],
    ["observer/protocol/schemas/vocabulary.schema.json", json(vocabularySchema)],
    ["observer/protocol/errors.md", renderErrorsMarkdown(errorEntries)],
    ["observer/protocol/capabilities.md", renderCapabilitiesMarkdown(capabilityEntries)],
  ]);
}

function artifactAbsolutePath(root: string, artifactPath: ProtocolArtifactPath): string {
  return join(root, ...artifactPath.split("/"));
}

export function writeProtocolArtifacts(
  root = repositoryRoot,
  source: ProtocolRegistrySource = CANONICAL_PROTOCOL_REGISTRIES
): void {
  for (const [artifactPath, contents] of renderProtocolArtifacts(source)) {
    const absolutePath = artifactAbsolutePath(root, artifactPath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents, "utf8");
  }
}

export function findProtocolArtifactDrift(
  root = repositoryRoot,
  source: ProtocolRegistrySource = CANONICAL_PROTOCOL_REGISTRIES
): ProtocolArtifactPath[] {
  const drifted: ProtocolArtifactPath[] = [];
  for (const [artifactPath, expected] of renderProtocolArtifacts(source)) {
    const absolutePath = artifactAbsolutePath(root, artifactPath);
    if (!existsSync(absolutePath) || readFileSync(absolutePath, "utf8") !== expected) {
      drifted.push(artifactPath);
    }
  }
  return drifted;
}

function main(): void {
  const arguments_ = process.argv.slice(2);
  const unknown = arguments_.filter((argument) => argument !== "--check");
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
  }

  if (arguments_.includes("--check")) {
    const drifted = findProtocolArtifactDrift();
    if (drifted.length > 0) {
      process.stderr.write([
        "Protocol artifacts are stale or missing:",
        ...drifted.map((path) => `  - ${path}`),
        "Run `npm run protocol:generate` and commit the resulting files.",
        "",
      ].join("\n"));
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Protocol artifacts are current (${PROTOCOL_ARTIFACT_PATHS.length} files).\n`);
    return;
  }

  writeProtocolArtifacts();
  process.stdout.write(
    `Generated ${PROTOCOL_ARTIFACT_PATHS.length} protocol artifacts under ${relative(repositoryRoot, join(repositoryRoot, "observer", "protocol"))}.\n`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
