import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z as z4 } from "zod/v4";
import { mcpDiscriminatedOutputSchema } from
  "../../src/foundation/mcp-discriminated-output-schema.js";

const exactResultSchema = z4.discriminatedUnion("action", [
  z4.object({
    action: z4.literal("start"),
    runtimeId: z4.string().min(1),
    preparation: z4.object({ digest: z4.string().length(64) }).strict(),
  }).strict(),
  z4.object({
    action: z4.literal("status"),
    runtimeId: z4.string().min(1),
    state: z4.enum(["running", "exited"]),
  }).strict(),
  z4.object({
    action: z4.literal("stop"),
    runtimeId: z4.string().min(1),
    termination: z4.literal("terminated"),
  }).strict(),
]);

const sdkOutputSchema = mcpDiscriminatedOutputSchema(exactResultSchema, "action");

function textResult(value: z4.infer<typeof exactResultSchema>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

describe("MCP discriminated output adapter", () => {
  it("publishes exclusive action branches and retains SDK runtime validation", async () => {
    const server = new McpServer({ name: "discriminated-output-server", version: "1.0.0" });
    server.registerTool(
      "lifecycle",
      {
        inputSchema: { action: z4.enum(["start", "status", "stop"]) },
        outputSchema: sdkOutputSchema,
      },
      async ({ action }) => {
        if (action === "start") {
          return textResult({
            action,
            runtimeId: "rt-start",
            preparation: { digest: "a".repeat(64) },
          });
        }
        if (action === "status") {
          return textResult({ action, runtimeId: "rt-status", state: "running" });
        }
        return textResult({ action, runtimeId: "rt-stop", termination: "terminated" });
      },
    );
    // This handler deliberately bypasses the exact fixture helper. The SDK must
    // reject its missing start-only field through the registered wrapper.
    const invalid = server.registerTool(
      "missing_branch_field",
      { inputSchema: {}, outputSchema: sdkOutputSchema },
      async () => ({
        content: [{ type: "text" as const, text: "invalid" }],
        structuredContent: { action: "start", runtimeId: "rt-invalid" },
      }),
    );
    expect(invalid).toBeDefined();

    const client = new Client({ name: "discriminated-output-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.listTools();
      const definition = listed.tools.find((tool) => tool.name === "lifecycle");
      expect(definition?.outputSchema).toMatchObject({
        type: "object",
        oneOf: [
          {
            type: "object",
            properties: { action: { const: "start" } },
            required: expect.arrayContaining(["action", "runtimeId", "preparation"]),
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { action: { const: "status" } },
            required: expect.arrayContaining(["action", "runtimeId", "state"]),
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { action: { const: "stop" } },
            required: expect.arrayContaining(["action", "runtimeId", "termination"]),
            additionalProperties: false,
          },
        ],
      });
      expect(definition?.outputSchema).not.toHaveProperty("anyOf");

      for (const action of ["start", "status", "stop"] as const) {
        const result = await client.callTool({ name: "lifecycle", arguments: { action } });
        expect(result.isError).not.toBe(true);
        const structured = exactResultSchema.parse(result.structuredContent);
        if (!Array.isArray(result.content)) throw new Error("Expected MCP result content array");
        const text = result.content.find((item: unknown): item is { type: "text"; text: string } => {
          if (item === null || typeof item !== "object") return false;
          const candidate = item as { type?: unknown; text?: unknown };
          return candidate.type === "text" && typeof candidate.text === "string";
        });
        expect(text?.type).toBe("text");
        if (text?.type !== "text") throw new Error("Expected compatibility text result");
        expect(JSON.parse(text.text)).toEqual(structured);
      }

      const rejected = await client.callTool({ name: "missing_branch_field", arguments: {} });
      expect(rejected).toMatchObject({ isError: true });
      expect(rejected.content).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringMatching(/Output validation error.*preparation/is),
        }),
      ]));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refuses a union whose branches are not uniquely discriminated objects", () => {
    expect(() => mcpDiscriminatedOutputSchema(
      z4.union([z4.object({ value: z4.string() }), z4.object({ value: z4.number() })]),
      "value",
    )).toThrow(/literal discriminator/i);
  });
});
