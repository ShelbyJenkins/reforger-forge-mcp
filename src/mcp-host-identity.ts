import { isAbsolute } from "node:path";
import { z } from "zod";

export const MCP_HOST_PRODUCT = "reforger-forge-mcp" as const;
export const MCP_CLIENT_LABEL_FLAG = "--mcp-client-label" as const;
export const DEFAULT_MCP_CLIENT_LABEL = "manual" as const;

const PROCESS_TITLE_PREFIX = "ReforgerForge-MCP-";
const CLIENT_LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const CANONICAL_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const clientLabelSchema = z.string()
  .min(1)
  .max(48)
  .regex(CLIENT_LABEL_PATTERN);

const hostIdentityShape = z.object({
  schemaVersion: z.literal(1),
  product: z.literal(MCP_HOST_PRODUCT),
  clientLabel: clientLabelSchema,
  instanceId: z.string().uuid(),
  pid: z.number().int().positive(),
  startedAt: z.string().max(32),
}).strict();

export interface McpHostIdentity {
  readonly schemaVersion: 1;
  readonly product: typeof MCP_HOST_PRODUCT;
  readonly clientLabel: string;
  readonly instanceId: string;
  readonly pid: number;
  readonly startedAt: string;
}

export interface PartitionedMcpHostArguments {
  readonly clientLabel: string;
  /** Canonical server arguments, including the manual default when omitted. */
  readonly hostArguments: readonly [typeof MCP_CLIENT_LABEL_FLAG, string];
  readonly remainingArguments: string[];
  readonly explicitlySupplied: boolean;
}

export class McpHostIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpHostIdentityError";
  }
}

export function parseMcpClientLabel(value: unknown): string {
  const parsed = clientLabelSchema.safeParse(value);
  if (!parsed.success) {
    throw new McpHostIdentityError(
      "MCP client label must match [a-z0-9][a-z0-9._-]{0,47}."
    );
  }
  return parsed.data;
}

export function parseMcpInstanceId(value: unknown, label = "MCP instance ID"): string {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) {
    throw new McpHostIdentityError(`${label} must be a UUID.`);
  }
  return parsed.data;
}

export function partitionMcpHostArguments(
  argv: readonly string[],
  defaultClientLabel: string = DEFAULT_MCP_CLIENT_LABEL
): PartitionedMcpHostArguments {
  const fallback = parseMcpClientLabel(defaultClientLabel);
  const remainingArguments: string[] = [];
  let clientLabel = fallback;
  let explicitlySupplied = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== MCP_CLIENT_LABEL_FLAG) {
      remainingArguments.push(token);
      continue;
    }
    if (explicitlySupplied) {
      throw new McpHostIdentityError(
        `${MCP_CLIENT_LABEL_FLAG} may be supplied only once.`
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new McpHostIdentityError(
        `${MCP_CLIENT_LABEL_FLAG} requires one client label.`
      );
    }
    clientLabel = parseMcpClientLabel(value);
    explicitlySupplied = true;
    index += 1;
  }

  return Object.freeze({
    clientLabel,
    hostArguments: Object.freeze([MCP_CLIENT_LABEL_FLAG, clientLabel]) as readonly [
      typeof MCP_CLIENT_LABEL_FLAG,
      string,
    ],
    remainingArguments,
    explicitlySupplied,
  });
}

function canonicalStartedAt(value: string): boolean {
  if (!CANONICAL_ISO_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

/** Validate an identity at the process boundary and return an immutable projection. */
export function validateMcpHostIdentity(value: unknown): McpHostIdentity {
  const parsed = hostIdentityShape.safeParse(value);
  if (!parsed.success ||
      parsed.data.pid !== process.pid ||
      !canonicalStartedAt(parsed.data.startedAt)) {
    throw new McpHostIdentityError(
      "MCP host identity must contain the current PID, a UUID, a bounded client label, and a canonical UTC start time."
    );
  }
  return Object.freeze({ ...parsed.data });
}

export function createMcpHostIdentity(options: {
  readonly clientLabel: string;
  readonly instanceId: string;
  readonly pid?: number;
  readonly startedAt?: string;
}): McpHostIdentity {
  return validateMcpHostIdentity({
    schemaVersion: 1,
    product: MCP_HOST_PRODUCT,
    clientLabel: parseMcpClientLabel(options.clientLabel),
    instanceId: options.instanceId,
    pid: options.pid ?? process.pid,
    startedAt: options.startedAt ?? new Date().toISOString(),
  });
}

export function formatMcpNodeTitle(clientLabel: string): string {
  return `${PROCESS_TITLE_PREFIX}${parseMcpClientLabel(clientLabel)}`;
}

export function formatMcpNodeTitleArgument(clientLabel: string): string {
  return `--title=${formatMcpNodeTitle(clientLabel)}`;
}

export function formatMcpProcessTitle(identity: McpHostIdentity): string {
  const trusted = validateMcpHostIdentity(identity);
  const shortInstanceId = trusted.instanceId.replace(/-/g, "").slice(0, 8).toLowerCase();
  const title = `${formatMcpNodeTitle(trusted.clientLabel)}-${shortInstanceId}`;
  if (title.length > 80 || !/^[\x20-\x7e]+$/.test(title)) {
    throw new McpHostIdentityError("MCP process title must be at most 80 ASCII characters.");
  }
  return title;
}

/** Exact argv after the Node executable for a managed stdio server launch. */
export function buildManagedMcpServerArguments(options: {
  readonly clientLabel: string;
  readonly serverPath: string;
  readonly configurationArguments?: readonly string[];
}): string[] {
  const clientLabel = parseMcpClientLabel(options.clientLabel);
  if (!isAbsolute(options.serverPath)) {
    throw new McpHostIdentityError("Managed MCP server path must be absolute.");
  }
  return [
    formatMcpNodeTitleArgument(clientLabel),
    options.serverPath,
    MCP_CLIENT_LABEL_FLAG,
    clientLabel,
    ...(options.configurationArguments ?? []),
  ];
}
