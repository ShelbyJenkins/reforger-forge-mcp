import { z } from "zod";

export interface ServerConfigOptions {
  /** Server display name */
  name: string;
  /** Addon ID from .gproj */
  modName?: string;
  /** Addon GUID from .gproj */
  modId?: string;
  /** Scenario resource path e.g. "{GUID}Missions/MissionHeader.conf" */
  scenarioId?: string;
  /** Maximum players (default 32) */
  maxPlayers?: number;
  /** Game host port (default 2001) */
  port?: number;
  /** Local address to bind. Empty uses all interfaces. */
  bindAddress?: string;
  /** Address advertised to the backend. Empty enables automatic detection. */
  publicAddress?: string;
  /** Port advertised to the backend (defaults to port). */
  publicPort?: number;
  /** A2S query port (default 17777) */
  a2sPort?: number;
  /** Whether server appears in browser (default false for local testing) */
  visible?: boolean;
  /** Server password (empty = no password) */
  password?: string;
}

const portSchema = z.number().int().min(1).max(65_535);
const ipv4AddressSchema = z.string().regex(
  /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/,
  "A2S bind address must be an IPv4 address"
);

/**
 * Root schema used by Arma Reforger 1.7. Keep this strict so obsolete field
 * names cannot silently re-enter generated configurations.
 */
const currentServerConfigSchema = z.object({
  bindAddress: z.string(),
  bindPort: portSchema,
  publicAddress: z.string(),
  publicPort: portSchema,
  a2s: z.object({
    address: ipv4AddressSchema,
    port: portSchema,
  }).strict(),
  game: z.object({
    name: z.string(),
    password: z.string(),
    scenarioId: z.string(),
    maxPlayers: z.number().int().min(1).max(128),
    visible: z.boolean(),
    gameProperties: z.object({
      serverMaxViewDistance: z.number(),
      serverMinGrassDistance: z.number(),
      fastValidation: z.boolean(),
      battlEye: z.boolean(),
    }).strict(),
    mods: z.array(z.object({
      modId: z.string(),
      name: z.string(),
      version: z.string(),
    }).strict()),
  }).strict(),
}).strict();

/**
 * Generate a JSON server config for Arma Reforger dedicated server.
 */
export function generateServerConfig(opts: ServerConfigOptions): string {
  const port = opts.port ?? 2001;
  const publicPort = opts.publicPort ?? port;
  const a2sPort = opts.a2sPort ?? 17777;

  const config = {
    bindAddress: opts.bindAddress ?? "",
    bindPort: port,
    publicAddress: opts.publicAddress ?? "",
    publicPort,
    a2s: {
      // Reforger 1.7 requires a concrete IPv4 value here even though the
      // root bindAddress may be omitted/empty to mean all interfaces.
      address: opts.bindAddress?.trim() || "0.0.0.0",
      port: a2sPort,
    },
    game: {
      name: opts.name,
      password: opts.password ?? "",
      scenarioId: opts.scenarioId ?? "",
      maxPlayers: opts.maxPlayers ?? 32,
      visible: opts.visible ?? false,
      gameProperties: {
        serverMaxViewDistance: 1600,
        serverMinGrassDistance: 50,
        fastValidation: true,
        battlEye: false,
      },
      mods: buildModList(opts),
    },
  };

  return JSON.stringify(currentServerConfigSchema.parse(config), null, 2);
}

function buildModList(
  opts: ServerConfigOptions
): Array<{ modId: string; name: string; version: string }> {
  if (!opts.modName && !opts.modId) return [];
  return [
    {
      modId: opts.modId ?? "",
      name: opts.modName ?? "",
      version: "",
    },
  ];
}
