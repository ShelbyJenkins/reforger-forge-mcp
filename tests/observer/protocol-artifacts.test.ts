import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROTOCOL_ARTIFACT_PATHS,
  findProtocolArtifactDrift,
  renderProtocolArtifacts,
  writeProtocolArtifacts,
  type ProtocolArtifactPath,
  type ProtocolArtifacts,
  type ProtocolRegistrySource,
} from "../../scripts/generate-protocol-artifacts.js";
import { repositoryRoot } from "./helpers.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function absoluteArtifactPath(root: string, artifactPath: ProtocolArtifactPath): string {
  return join(root, ...artifactPath.split("/"));
}

function artifact(artifacts: ProtocolArtifacts, path: ProtocolArtifactPath): string {
  const contents = artifacts.get(path);
  if (contents === undefined) throw new Error(`Missing rendered artifact ${path}`);
  return contents;
}

describe("protocol artifact generator", () => {
  it("keeps every checked-in artifact byte-for-byte current", () => {
    const rendered = renderProtocolArtifacts();
    expect([...rendered.keys()]).toEqual(PROTOCOL_ARTIFACT_PATHS);
    for (const [artifactPath, expected] of rendered) {
      expect(readFileSync(absoluteArtifactPath(repositoryRoot, artifactPath), "utf8"), artifactPath)
        .toBe(expected);
    }
    expect(findProtocolArtifactDrift(repositoryRoot)).toEqual([]);
  });

  it("recreates deleted or altered artifacts deterministically", () => {
    const root = mkdtempSync(join(tmpdir(), "rfo-protocol-artifacts-"));
    temporaryRoots.push(root);
    const expected = renderProtocolArtifacts();

    writeProtocolArtifacts(root);
    unlinkSync(absoluteArtifactPath(root, "observer/protocol/generated/error-codes.json"));
    writeFileSync(
      absoluteArtifactPath(root, "observer/protocol/errors.md"),
      "stale\n",
      "utf8"
    );
    expect(findProtocolArtifactDrift(root)).toEqual([
      "observer/protocol/generated/error-codes.json",
      "observer/protocol/errors.md",
    ]);

    writeProtocolArtifacts(root);
    for (const [artifactPath, contents] of expected) {
      expect(readFileSync(absoluteArtifactPath(root, artifactPath), "utf8"), artifactPath)
        .toBe(contents);
    }
    expect(findProtocolArtifactDrift(root)).toEqual([]);
  });

  it("derives order and backend-scoped enums from one registry source", () => {
    const source = {
      errorRegistry: {
        SECOND_ERROR: {
          publicMessagePolicy: "bounded-diagnostic",
          publicMessage: "Second error.",
          retryable: false,
          backends: ["host"],
        },
        FIRST_ERROR: {
          publicMessagePolicy: "fixed",
          publicMessage: "First error.",
          retryable: true,
          backends: ["runtime"],
        },
      },
      capabilityRegistry: {
        "z.capability": { backends: ["workbench"], proof: "Workbench proof." },
        "a.capability": { backends: ["runtime"], proof: "Runtime proof." },
      },
    } as const satisfies ProtocolRegistrySource;

    const rendered = renderProtocolArtifacts(source);
    expect(JSON.parse(artifact(rendered, "observer/protocol/generated/error-codes.json")))
      .toEqual(["SECOND_ERROR", "FIRST_ERROR"]);
    expect(JSON.parse(artifact(rendered, "observer/protocol/generated/runtime-error-codes.json")))
      .toEqual(["FIRST_ERROR"]);
    expect(JSON.parse(artifact(rendered, "observer/protocol/generated/capabilities.json")))
      .toEqual(["z.capability", "a.capability"]);
    expect(JSON.parse(artifact(rendered, "observer/protocol/generated/fixed-error-messages.json")))
      .toEqual({ FIRST_ERROR: "First error." });

    const schema = JSON.parse(artifact(rendered, "observer/protocol/schemas/vocabulary.schema.json"));
    expect(schema.$defs.errorCode.enum).toEqual(["SECOND_ERROR", "FIRST_ERROR"]);
    expect(schema.$defs.runtimeErrorCode.enum).toEqual(["FIRST_ERROR"]);
    expect(schema.$defs.runtimeCapability.enum).toEqual(["a.capability"]);
    expect(schema.$defs.workbenchCapability.enum).toEqual(["z.capability"]);
    const errorSchema = JSON.parse(artifact(rendered, "observer/protocol/schemas/error.schema.json"));
    const heartbeatSchema = JSON.parse(artifact(rendered, "observer/protocol/schemas/heartbeat.schema.json"));
    const jobStatusSchema = JSON.parse(artifact(rendered, "observer/protocol/schemas/job-status.schema.json"));
    expect(errorSchema.properties.error.properties.code.enum)
      .toEqual(["SECOND_ERROR", "FIRST_ERROR"]);
    expect(heartbeatSchema.properties.lastErrorCode.oneOf[0].enum).toEqual(["FIRST_ERROR"]);
    expect(jobStatusSchema.properties.errorCode.enum).toEqual(["FIRST_ERROR"]);
    expect(artifact(rendered, "observer/protocol/errors.md"))
      .toContain("| SECOND_ERROR | bounded-diagnostic | no | host | Second error. |");
    expect(artifact(rendered, "observer/protocol/capabilities.md"))
      .toContain("| `a.capability` | runtime | Runtime proof. |");
  });
});
