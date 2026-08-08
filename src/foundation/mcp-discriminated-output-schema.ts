import { z as z4 } from "zod/v4";

type JsonObject = Record<string, unknown>;

function jsonObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

/**
 * Adapt an exact Zod 4 discriminated union to the object-shaped output schema
 * required by @modelcontextprotocol/sdk 1.29.0.
 *
 * The pinned SDK's public `registerTool` type accepts any Zod schema, but its
 * output path unconditionally calls `normalizeObjectSchema`: a root union is
 * omitted from `tools/list` and later passed to runtime validation as
 * `undefined`. A Zod 4 object retains its object kind after `superRefine`, so
 * this adapter gives the SDK an object it can validate while public Zod JSON
 * Schema metadata publishes the exact, mutually-exclusive branches.
 *
 * Keep the exact schema synchronous. Tool output validation itself remains in
 * the SDK and calls this returned schema through `safeParseAsync`.
 */
export function mcpDiscriminatedOutputSchema<Output extends Record<string, unknown>>(
  exactSchema: z4.ZodType<Output>,
  discriminator: keyof Output & string,
) {
  const generated = z4.toJSONSchema(exactSchema, {
    target: "draft-7",
    io: "output",
  });
  const generatedRecord = generated as JsonObject;
  const union = Array.isArray(generatedRecord.oneOf)
    ? generatedRecord.oneOf
    : Array.isArray(generatedRecord.anyOf)
      ? generatedRecord.anyOf
      : null;
  if (!union || union.length < 2) {
    throw new TypeError("MCP discriminated output schema must generate at least two union branches");
  }

  const discriminatorValues = new Set<string>();
  for (const candidate of union) {
    const branch = jsonObject(candidate);
    const properties = jsonObject(branch?.properties);
    const property = jsonObject(properties?.[discriminator]);
    const required = branch?.required;
    if (branch?.type !== "object" || property === null || !("const" in property) ||
        !Array.isArray(required) || !required.includes(discriminator)) {
      throw new TypeError(
        `MCP output union branch must require literal discriminator ${JSON.stringify(discriminator)}`,
      );
    }
    const key = JSON.stringify(property.const);
    if (discriminatorValues.has(key)) {
      throw new TypeError("MCP output union discriminator values must be unique");
    }
    discriminatorValues.add(key);
  }

  const {
    $schema: _dialect,
    anyOf: _generatedAnyOf,
    oneOf: _generatedOneOf,
    ...supportingMetadata
  } = generatedRecord;

  return z4.looseObject({})
    .superRefine((value, context) => {
      const parsed = exactSchema.safeParse(value);
      if (parsed.success) return;
      for (const issue of parsed.error.issues) {
        context.addIssue({
          code: "custom",
          message: issue.message,
          path: issue.path,
        });
      }
    })
    .meta({
      ...supportingMetadata,
      // Literal discriminator values make these branches mutually exclusive,
      // so publish the stronger client-visible keyword even when Zod generated
      // the equivalent `anyOf` form.
      oneOf: union,
    });
}
