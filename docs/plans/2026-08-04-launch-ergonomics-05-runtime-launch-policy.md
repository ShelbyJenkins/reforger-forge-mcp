# Commit 5 plan: share runtime launch policy and derived roots

> **Commit:** `refactor(observer): centralize graphical launch policy`
>
> **Series position:** 5 of 7 required baseline commits.
>
> **Dependencies:** [world resolution](2026-08-04-launch-ergonomics-03-world-resolution.md)
> and [dependency/root safety](2026-08-04-launch-ergonomics-04-dependency-root-safety.md).

## Why this is its own commit

This is a behavior-preserving integration layer: it promotes the repository's
already accepted CLI mapping, extracts private policy helpers, and exposes the two
observer roots needed by later tools. Keeping it separate lets reviewers prove the
argument vector before any MCP tool starts a process.

## Goal

Given the exact world/add-on plan, produce the complete caller-owned argument vector
and deterministic observer profile for `client` or `listenServer`, while leaving
the observer private child as the final managed-argument authority.

## Research context

[Bohemia's startup-parameter documentation](https://community.bistudio.com/wiki/Arma_Reforger:Startup_Parameters)
documents `-world`, `-server`, `-client`, `-addons`, `-addonsDir`, and
`-config`. [The server-config documentation](https://community.bistudio.com/wiki/Arma_Reforger:Server_Config)
places `scenarioId` in JSON configuration rather than the startup argv. The
repository's accepted runtime helper already implements the corrected
client-to-`-world` and listenServer-to-`-server` mapping.

## Files

- new `src/observer/launch-policy.ts`
- new `src/launch/game-runtime-arguments.ts`
- `src/observer/tools.ts`
- `src/observer/application.ts`
- `scripts/observer-runtime-launch-support.ts`
- `scripts/run-runtime-observer-acceptance.ts`
- `scripts/observer-runtime-failure-matrix.ts`
- `tests/observer/launch-arguments.test.ts`
- `tests/observer/runtime-launch-arguments.test.ts`
- `tests/observer/runtime-failure-matrix.test.ts`
- `tests/observer/runtime-live-acceptance-contract.test.ts`
- `tests/observer/application-contract.test.ts`
- new `tests/launch/game-runtime-arguments.test.ts`

## Promote the proven CLI mapping

Move the production-safe portion of
`scripts/observer-runtime-launch-support.ts:256-270` into source and import it back
through a facade/re-export so both the live acceptance runner and failure matrix use
one implementation.

The baseline vector is:

```ts
[
  "-noSplash",
  "-noThrow",
  "-disableCrashReporter",
  runtimeKind === "listenServer" ? "-server" : "-world",
  worldResourceRef,
  "-addonsDir", emittedAddonRoots.join(","),
  "-addons", targetAddonGuid,
  ...extra,
]
```

Do not emit `-scenarioId`. It is a server-config JSON field, not a documented CLI
argument. Do not emit standalone `-client`; that starts/connects a replication
client and is not the standalone local-world selector.

Support only `client` and `listenServer`, defaulting the eventual composite to
`listenServer`. `dedicated` needs server JSON and non-render readiness; `testRunner`
remains primitive-only.

## Shared policy extraction

Move/export from `src/observer/tools.ts` into `src/observer/launch-policy.ts`:

- the native-fullscreen schema and `assertNativeFullscreenLaunch`;
- configured add-on root helpers still needed by the primitive;
- a composite-only reserved argument classifier.

Import the helpers back into `observer/tools.ts`; do not create a runtime cycle by
having a later tool import values from the registrar.

Preserve the primitive's current argument schema and caller-owned
world/server/add-on behavior byte-for-byte. Today it accepts some empty/control
tokens subject only to its existing count/length schema; do not tighten that in
this behavior-preserving extraction. Put all new empty/control/aggregate hygiene
and the following broad reserved set in the composite-only validator. Do not apply
it to `observer_prepare_launch`; doing so would reject arguments it intentionally
accepts today and violate this commit's behavior-preserving boundary. Apply it only
to the extras accepted by the future `game_launch` composite.

Validate composite extras case-insensitively in both split and `-flag=value`
forms. Reserve:

- `-profile`, `-logsDir`, `-addonsDir`, `-addons`, `-addonDownloadDir`;
- `-world`, `-server`, `-client`, `-config`, `-worldSystemsConfig`;
- `-forceUpdate`, `-noFocus`, `-noSplash`, `-noThrow`,
  `-disableCrashReporter`;
- `-window`, `-screenWidth`, `-screenHeight`;
- every Workbench/runtime owner-token prefix.

Reject empty/NUL/control tokens and token count/per-token/aggregate input overflow.
At this layer the executable path, child-managed profile/log/observer arguments,
and final owner token are not yet known, so do not claim an exact Windows
CreateProcess-length proof. Leave conservative fixed headroom in the composite
input budget; `OwnedRuntimeManager` remains the exact final command-line
authority after preparation and immediately before consumption/spawn.
`-addonDownloadDir` is reserved because it could introduce mods outside the
audited root set.

Do not call `mergeConfiguredAddonDirectories` after the game add-on planner has
already produced the final explicit root list. Exactly one layer owns ordering.
`mergeLaunchArguments` in the private child remains the final authority for
`-profile`, logs, observer add-on insertion, canonical deduplication, force-update,
and no-focus.

## Expose canonical application roots

Add readonly `managedRoot` and `profileRoot` to `ObserverApplication`, assigned
once from the constructor's existing resolved values. Canonicalize prospective
spelling without creating directories and pass the same value to the child.

Property access must not create/fork anything. Commit 4's planner receives these
private roots and performs dynamic project/explicit-root overlap checks.

## Derived profile

Use a versioned fixed-width leaf such as:

```text
<profileRoot>/derived-v1/<first 32 hex of sha256(project.comparisonKey)>
```

Derivation is deterministic and read-only. The child still performs final
containment and directory creation. One stable project profile deliberately
serializes active/prepared launches and avoids proliferating settings/downloads.

## Tests

Prove:

- client -> `-world <formed-ref>`;
- listenServer -> `-server <formed-ref>`;
- no `-scenarioId` or standalone `-client`;
- only target GUID is initially passed to `-addons`;
- every composite-reserved split and `=value` spelling is rejected by the
  composite validator while the primitive's currently accepted caller-owned
  launch flags remain accepted;
- roots are not merged twice;
- native fullscreen remains default;
- the derived profile is stable, 32 hex, contained, and does not create roots;
- application root properties use the same spelling passed to the child;
- both acceptance-script consumers use the shared implementation.

## Validation

The direct runtime launch tests are not in the current stage-4 list.

```powershell
npx vitest run tests/launch/game-runtime-arguments.test.ts tests/observer/launch-arguments.test.ts tests/observer/runtime-launch-arguments.test.ts tests/observer/runtime-failure-matrix.test.ts tests/observer/runtime-live-acceptance-contract.test.ts tests/observer/application-contract.test.ts
npm run test:stage4
npm run typecheck
npm run lint:unused
```

## Commit acceptance

- One tested source owns the client/listen-server world selector.
- The primitive's current behavior remains intact through imported shared policy.
- Application roots and profile derivation are deterministic and non-creating.
- No MCP tool registration, owned runtime start, Workbench preview, or script output
  is added.
