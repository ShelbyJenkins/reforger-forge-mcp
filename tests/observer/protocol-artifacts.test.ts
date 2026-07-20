import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENFORCE_PROTOCOL_HEADER,
  PROTOCOL_ARTIFACT_PATHS,
  enforceContractDescriptor,
  escapeEnforceStringLiteral,
  findProtocolArtifactDrift,
  renderEnforceNumberLiteral,
  renderEnforceProtocolClass,
  renderProtocolArtifacts,
  writeProtocolArtifacts,
  type ProtocolArtifactPath,
  type ProtocolArtifacts,
  type ProtocolRegistrySource,
} from "../../scripts/generate-protocol-artifacts.js";
import {
  OBSERVER_ENFORCE_CONTRACT,
  createObserverEnforceContract,
  validateObserverEnforceContract,
  type EnforceTargetContract,
  type ObserverEnforceContract,
} from "../../observer/protocol/enforce-contract.js";
import { repositoryRoot } from "../support/observer-fixtures.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

function scopedIt(
  name: string,
  run: (root: string) => Promise<void> | void,
): void {
  it(name, () => withTemporaryDirectory(run, { prefix: "rfo-protocol-artifacts-" }));
}

function absoluteArtifactPath(root: string, artifactPath: ProtocolArtifactPath): string {
  return join(root, ...artifactPath.split("/"));
}

function artifact(artifacts: ProtocolArtifacts, path: ProtocolArtifactPath): string {
  const contents = artifacts.get(path);
  if (contents === undefined) throw new Error(`Missing rendered artifact ${path}`);
  return contents;
}

function targetStringValues(target: EnforceTargetContract): Record<string, string> {
  return Object.fromEntries(target.strings.map(({ field, value }) => [field, value]));
}

function targetNumberValues(target: EnforceTargetContract): Record<string, { kind: string; value: string }> {
  return Object.fromEntries(target.numbers.map(({ field, kind, value }) => [
    field,
    { kind, value: renderEnforceNumberLiteral(value, kind) },
  ]));
}

function emittedStringValues(source: string): Record<string, string> {
  return Object.fromEntries([...source.matchAll(
    /^\tstatic const string ([A-Z][A-Z0-9_]*) = "([^"\\\r\n]*)";$/gm
  )].map(([, field, value]) => [field, value]));
}

function emittedNumberValues(source: string): Record<string, { kind: string; value: string }> {
  return Object.fromEntries([...source.matchAll(
    /^\tstatic const (int|float) ([A-Z][A-Z0-9_]*) = (-?(?:\d+\.\d+|\d+));$/gm
  )].map(([, kind, field, value]) => [field, { kind, value }]));
}

function expectLiteralOnlyEnforceClass(source: string, target: EnforceTargetContract): void {
  const lines = source.split("\n");
  expect(lines).toHaveLength(target.strings.length + target.numbers.length + 5);
  expect(lines[0]).toBe(ENFORCE_PROTOCOL_HEADER);
  expect(lines[1]).toBe(`class ${target.className}`);
  expect(lines[2]).toBe("{");
  expect(lines.at(-2)).toBe("}");
  expect(lines.at(-1)).toBe("");
  expect(lines.slice(3, -2).every((line) =>
    /^\tstatic const (?:string|int|float) [A-Z][A-Z0-9_]* = .+;$/.test(line)
  )).toBe(true);
  expect(emittedStringValues(source)).toEqual(targetStringValues(target));
  expect(emittedNumberValues(source)).toEqual(targetNumberValues(target));
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

  scopedIt("recreates deleted or altered artifacts deterministically", (root) => {
    const expected = renderProtocolArtifacts();

    writeProtocolArtifacts(root);
    unlinkSync(absoluteArtifactPath(root, "observer/protocol/generated/error-codes.json"));
    unlinkSync(absoluteArtifactPath(root, "observer/protocol/schemas/instance-registration.schema.json"));
    writeFileSync(
      absoluteArtifactPath(root, "observer/protocol/schemas/capture-request.schema.json"),
      "stale\n",
      "utf8"
    );
    writeFileSync(
      absoluteArtifactPath(root, "observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverProtocol.c"),
      "stale\n",
      "utf8"
    );
    writeFileSync(
      absoluteArtifactPath(root, "observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_ObserverProtocol.c"),
      "stale\n",
      "utf8"
    );
    expect(findProtocolArtifactDrift(root)).toEqual([
      "observer/protocol/generated/error-codes.json",
      "observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverProtocol.c",
      "observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_ObserverProtocol.c",
      "observer/protocol/schemas/capture-request.schema.json",
      "observer/protocol/schemas/instance-registration.schema.json",
    ]);

    writeProtocolArtifacts(root);
    for (const [artifactPath, contents] of expected) {
      expect(readFileSync(absoluteArtifactPath(root, artifactPath), "utf8"), artifactPath)
        .toBe(contents);
    }
    expect(findProtocolArtifactDrift(root)).toEqual([]);
  });

  it("renders the descriptor targets as literal-only C classes with exact member maps", () => {
    const rendered = renderProtocolArtifacts();
    const descriptor = JSON.parse(artifact(rendered, "observer/protocol/generated/enforce-contract.json"));

    expect(ENFORCE_PROTOCOL_HEADER).toBe(
      "// Generated by npm run protocol:generate from observer/protocol/enforce-contract.ts. Do not edit."
    );
    expect(descriptor).toEqual(enforceContractDescriptor(OBSERVER_ENFORCE_CONTRACT));
    expect(PROTOCOL_ARTIFACT_PATHS as readonly string[]).not.toContain(
      "observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/RFWB_HelperBuild.c"
    );

    const generatedTargets: readonly (readonly [EnforceTargetContract, ProtocolArtifactPath])[] = [
      [
        OBSERVER_ENFORCE_CONTRACT.targets.game,
        "observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverProtocol.c",
      ],
      [
        OBSERVER_ENFORCE_CONTRACT.targets.workbench,
        "observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_ObserverProtocol.c",
      ],
    ];
    for (const [target, artifactPath] of generatedTargets) {
      expect(target.outputPath).toBe(artifactPath);
      const source = artifact(rendered, artifactPath);
      expectLiteralOnlyEnforceClass(source, target);
      expect(source).toBe(renderEnforceProtocolClass(target));
    }
  });

  it("escapes and renders Enforce scalars deterministically while rejecting unsafe input", () => {
    const escaped = "quote\" slash\\ CR\rLF\nTab\tcontrol\u0001";
    const target: EnforceTargetContract = {
      className: "FixtureProtocol",
      outputPath: "fixtures/FixtureProtocol.c",
      strings: [{ field: "ESCAPED", value: escaped }],
      numbers: [
        { field: "COUNT", kind: "int", value: 7 },
        { field: "EPSILON", kind: "float", value: 1e-7 },
      ],
    };

    expect(escapeEnforceStringLiteral(escaped)).toBe("quote\\\" slash\\\\ CR\\rLF\\nTab\\tcontrol\\x01");
    expect(renderEnforceNumberLiteral(12, "float")).toBe("12.0");
    expect(renderEnforceNumberLiteral(1e-7, "float")).toBe("0.0000001");
    expect(renderEnforceProtocolClass(target)).toBe([
      ENFORCE_PROTOCOL_HEADER,
      "class FixtureProtocol",
      "{",
      "\tstatic const string ESCAPED = \"quote\\\" slash\\\\ CR\\rLF\\nTab\\tcontrol\\x01\";",
      "\tstatic const int COUNT = 7;",
      "\tstatic const float EPSILON = 0.0000001;",
      "}",
      "",
    ].join("\n"));

    expect(() => escapeEnforceStringLiteral("not\0safe")).toThrow(/NUL/);
    expect(() => renderEnforceNumberLiteral(Number.POSITIVE_INFINITY, "float")).toThrow(/finite/);
    expect(() => renderEnforceNumberLiteral(1.5, "int")).toThrow(/safe integers/);
    expect(() => renderEnforceNumberLiteral(1, "double" as never)).toThrow(/Unsupported Enforce numeric kind/);
    expect(() => renderEnforceProtocolClass({ ...target, className: "not-a-class" })).toThrow(/class name/i);
    expect(() => renderEnforceProtocolClass({
      ...target,
      strings: [...target.strings, { field: "ESCAPED", value: "duplicate" }],
    })).toThrow(/Duplicate Enforce field/);
  });

  it("rejects coupled identities, duplicate outputs, and registry field collisions before rendering", () => {
    const coupledIdentities: ObserverEnforceContract = {
      ...OBSERVER_ENFORCE_CONTRACT,
      identities: {
        ...OBSERVER_ENFORCE_CONTRACT.identities,
        runtimeObserver: OBSERVER_ENFORCE_CONTRACT.identities.workbenchAdapter,
      },
    };
    const duplicateOutput: ObserverEnforceContract = {
      ...OBSERVER_ENFORCE_CONTRACT,
      targets: {
        ...OBSERVER_ENFORCE_CONTRACT.targets,
        game: {
          ...OBSERVER_ENFORCE_CONTRACT.targets.game,
          outputPath: OBSERVER_ENFORCE_CONTRACT.targets.workbench.outputPath,
        },
      },
    };

    expect(() => validateObserverEnforceContract(coupledIdentities)).toThrow(/identities must remain distinct/);
    expect(() => validateObserverEnforceContract(duplicateOutput)).toThrow(/duplicate target output path/);
    expect(() => createObserverEnforceContract({
      errorRegistry: {},
      capabilityRegistry: {
        "render.capture": { backends: ["runtime"], proof: "first field" },
        "render-capture": { backends: ["runtime"], proof: "colliding field" },
      },
    })).toThrow(/duplicate field CAP_RENDER_CAPTURE/);
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
      enforceContractSource: {
        runtimeObserverProtocol: "7.5",
        workbenchAdapterProtocol: "fixture-workbench-observer/7",
        workbenchHelperBundleProtocol: "fixture-helper/7",
        sessionDirectoryName: "FixtureObserver",
        sessionContractName: "fixture-session.json",
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

    const descriptor = JSON.parse(artifact(rendered, "observer/protocol/generated/enforce-contract.json"));
    expect(descriptor.identities).toEqual({
      runtimeObserver: "7.5",
      workbenchAdapter: "fixture-workbench-observer/7",
      workbenchHelperBundle: "fixture-helper/7",
    });
    expect(descriptor.targets.game.strings).toContainEqual({ field: "ERROR_FIRST_ERROR", value: "FIRST_ERROR" });
    expect(descriptor.targets.game.strings).toContainEqual({ field: "CAP_A_CAPABILITY", value: "a.capability" });
    expect(descriptor.targets.game.strings).not.toContainEqual({ field: "ERROR_SECOND_ERROR", value: "SECOND_ERROR" });
    expect(descriptor.targets.workbench.strings).toContainEqual({ field: "CAP_Z_CAPABILITY", value: "z.capability" });
    expect(descriptor.targets.workbench.strings).not.toContainEqual({ field: "CAP_A_CAPABILITY", value: "a.capability" });
    expect(artifact(rendered, "observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverProtocol.c"))
      .toContain('static const string ERROR_FIRST_ERROR = "FIRST_ERROR";');
    expect(artifact(rendered, "observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_ObserverProtocol.c"))
      .toContain('static const string CAP_Z_CAPABILITY = "z.capability";');

    const schema = JSON.parse(artifact(rendered, "observer/protocol/schemas/vocabulary.schema.json"));
    expect(schema.$defs.errorCode.enum).toEqual(["SECOND_ERROR", "FIRST_ERROR"]);
    expect(schema.$defs.runtimeErrorCode.enum).toEqual(["FIRST_ERROR"]);
    expect(schema.$defs.runtimeCapability.enum).toEqual(["a.capability"]);
    expect(schema.$defs.workbenchCapability.enum).toEqual(["z.capability"]);
    const errorSchema = JSON.parse(artifact(rendered, "observer/protocol/schemas/error.schema.json"));
    const heartbeatSchema = JSON.parse(artifact(rendered, "observer/protocol/schemas/heartbeat.schema.json"));
    const jobStatusSchema = JSON.parse(artifact(rendered, "observer/protocol/schemas/job-status.schema.json"));
    const instanceRegistrationSchema = JSON.parse(artifact(
      rendered,
      "observer/protocol/schemas/instance-registration.schema.json"
    ));
    expect(errorSchema.properties.error.properties.code.enum)
      .toEqual(["SECOND_ERROR", "FIRST_ERROR"]);
    expect(heartbeatSchema.properties.lastErrorCode.oneOf[0].enum).toEqual(["FIRST_ERROR"]);
    expect(jobStatusSchema.properties.errorCode.enum).toEqual(["FIRST_ERROR"]);
    expect(instanceRegistrationSchema.$defs.knownCapability.enum)
      .toEqual(["z.capability", "a.capability"]);
    expect(artifact(rendered, "observer/protocol/errors.md"))
      .toContain("| SECOND_ERROR | bounded-diagnostic | no | host | Second error. |");
    expect(artifact(rendered, "observer/protocol/capabilities.md"))
      .toContain("| `a.capability` | runtime | Runtime proof. |");
  });
});
