# `wb_audio` — Workbench Audio Config Project (ACP) tool

*Research notes and implementation plan — 2026-08-05*

## Context

Maintaining `.acp` files for RainbowVeil is manual GUI work in the Audio Editor: every time a sample lands in
`arma/addons/addons-systems/RainbowVeil/Sounds/RainbowVeil/{noise,noise_long,voice,voice_long}`, someone has to
open the Audio Editor and re-drag it into a Bank node. There is no way to diff, audit, or regenerate that state.

The goal is a dedicated `wb_audio` MCP tool that makes ACP contents inspectable and Bank sample lists
programmatically maintainable, so the workflow becomes "build the two graph skeletons once by hand, then
maintain all audio resources from code."

Deliberately **not** in scope: generic Workbench menu automation (already refused on purpose in
[EMCP_WB_ExecuteAction.c](../../observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_ExecuteAction.c)),
and `.snd` conversion (`wb_audio_convert`) — see *Deferred* below.

Development happens in the `reforger-forge-mcp-dev` working copy; file paths below are repo-relative and apply to both.

---

## What research established

### The API surface is real, but it is entirely inherited and entirely untyped

`AudioEditor` is declared in `data/api/enfusion-classes.json` with **zero methods of its own**. It is
`AudioEditor : WBModuleDef`, and `WBModuleDef` is where the whole usable surface lives:

```
proto external bool            SetOpenedResource (string filename)
proto external BaseContainer   GetContainer      (int index=0)
proto external int             GetNumContainers  ()
proto external bool            Save              ()
proto external bool            Close             ()
proto external bool            ExecuteAction     (notnull array<string> menuPath, bool bKeepFocus=true)
proto external WorkbenchPlugin GetPlugin         (TypeName pluginType)
```

So the original premise holds — open an ACP, get its live `BaseContainer`, mutate, `Save()` — but there is **no
audio-aware API at all**. No `GetBanks()`, no node enumeration, no connection list. Every read and write is
generic `BaseContainer` reflection:

```
GetClassName / GetName / SetName
GetNumVars / GetVarName(i) / GetDataVarType(i) / GetUIWidget(i) / GetLimits(i) / GetEnumValues(i)
Get(varName, out void val)  /  Set(varName, void val)
GetObject / SetObject
GetObjectArray -> BaseContainerList  /  SetObjectArray
GetNumChildren / GetChild(n) / GetParent
```

`BaseContainerList`: `Get(i)`, `Set(i, c)`, `Insert(c, index=-1)`, `Remove(c)`, `Count()`, `Clone()`.

This is sufficient — it is exactly the "inspect the schema the current Workbench actually loaded" property that
makes a live handler safer than an external text generator. But it means the handler is a reflection walker
first and an audio tool second.

### There is no ground truth for the ACP schema anywhere

- `find` across the whole workspace returns **zero `.acp` files**.
- `SNDResourceClass` appears **nowhere** in `data/`, `src/`, or `observer/`. The only resource class names present
  anywhere in the repo are `PNGResourceClass`, `PTCResourceClass`, `TGAResourceClass`. The sound resource class
  name in the original proposal is an assumption.
- `DataVarType`'s enum members are absent from the offline index (only the bare `DataVarType.NULL` literal appears).
  The walker cannot switch on named members; it must handle the raw int and probe typed reads.
- [data/kb/patterns/Audio_And_Sound/audio-system.md](../../data/kb/patterns/Audio_And_Sound/audio-system.md)
  documents the editor's *UI concepts* — Bank / Sound / Shader / Amplitude / Selector / Bus / Signal / Stream /
  Variable, Bank max 1024 samples, selection modes Random / Sequential / CustomSignalIndex — but zero container
  class names and zero var names.

**Consequence, stated plainly:** the decision is to ship `inspect` + `validate` + `syncBankSamples` in one milestone.
That is workable, but the mutation code cannot be written before the schema is known. The sequencing gate in
Step 2 below is therefore not optional — it is the step that converts guesses into the constants the other two
actions are built on. Expect the `syncBankSamples` container-path constants to be the last code written, not the first.

### Every integration point in the host repo is already verified

| Concern | Fact |
|---|---|
| Handler registration | None needed. A `NetApiHandler` subclass is discovered by class name; `APIFunc == "EMCP_WB_Audio"` binds to `class EMCP_WB_Audio : NetApiHandler`. |
| Payload manifest | Adding a `.c` file requires `npm run observer:generate`, which rewrites `.reforger-forge-workbench-helper-source.json` (per-file sha256, `bundleDigest`, `buildIdentity`) and `src/workbench/helper-addon-payload.generated.ts`, and regenerates `RFWB_HelperBuild.c`'s `IDENTITY`. `npm run observer:manifest:check` is the CI gate. |
| Tool registration | [src/server.ts](../../src/server.ts) — import alongside `registerWbResources`, call alongside it in the same block. |
| Mode gating | Reuse `requireResourceManagerMode` from [src/workbench/status.ts](../../src/workbench/status.ts). It refuses Play mode and accepts a `no_world_editor` session — correct for AudioEditor, which does not need World Editor. Do **not** use `requireEditMode`. |
| Response encoding | `JsonApiStruct` scalars via `RegV(...)`; arrays and nested objects hand-rolled in `OnPack()` with `StartArray/StartObject/StoreString/EndObject/EndArray` — see the `m_aEntries` block in [EMCP_WB_Resources.c](../../observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Resources.c). **Deeply nested trees are painful here; the describe payload must be flattened.** |
| Resource class discovery | Already solved. `EMCP_WB_Resources.c` resolves any registered file's class from `MetaFile.GetObjectArray("Configurations")[0].GetClassName()`. `wb_resources getInfo` on a `.wav`/`.ogg`/`.snd` returns the real sound resource class name with **zero new code**. |

### One easy-to-miss requirement

[src/workbench/session-controller.ts](../../src/workbench/session-controller.ts) maintains a `documentSwitch`
allowlist (grep for `const documentSwitch`) of `apiFunc` + `action` pairs that can move the active document out
from under a target-bound explicit-save session:

```ts
const documentSwitch = (apiFunc === "EMCP_WB_EditorControl" && params.action === "openResource") ||
  (apiFunc === "EMCP_WB_Resources" && params.action === "open") ||
  (apiFunc === "EMCP_WB_ScriptEditor" && params.action === "openFile");
```

`EMCP_WB_Audio` calls `SetOpenedResource` on *every* action, so **every** `wb_audio` action is a document switch.
It must be added to this list unconditionally (no action filter), or a `wb_audio inspect` during a bound save
session silently taints the binding without tripping the guard.

---

## Plan

### Step 1 — Build the specimen ACP by hand

In Audio Editor, create `arma/addons/addons-systems/RainbowVeil/Sounds/RainbowVeil/RV_EnvironmentalNoise.acp` with the
minimum that exercises every shape the tool touches:

- one Bank node named `RV_ENV_BANK_BEDS`, holding **at least two** samples from `noise_long/`, selection mode Random,
  infinite loop on, a non-default volume
- one Sound node with a distinct name, wired to that Bank
- one signal input node

Two samples matters: it is the only way to tell a repeated-scalar layout from an object-array layout. Save and commit
it. This file is both the discovery specimen and the test fixture.

### Step 2 — `describe`, and freeze the schema (the gate)

Create `observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Audio.c` with `describe` implemented first.

The walk:

```
AudioEditor ae = Workbench.GetModule(AudioEditor);          // refuse if null
if (!ae.SetOpenedResource(absAcpPath)) -> error
int n = ae.GetNumContainers();                              // report it; do not assume 1
BaseContainer root = ae.GetContainer(0);
walk(root, depth):
  emit { path, className: GetClassName(), name: GetName(), depth }
  for i in 0 .. GetNumVars()-1:
    varName = GetVarName(i); rawType = GetDataVarType(i)
    emit { path, varName, rawType, uiWidget: GetUIWidget(i) }
    try GetObject(varName)      -> recurse
    try GetObjectArray(varName) -> BaseContainerList, recurse each Get(idx)
    else typed scalar probe (see below)
```

Because `DataVarType`'s members are unknown offline, do **not** switch on named enum members. Emit the raw int and
probe typed locals in a fixed order (`string`, `int`, `float`, `bool`, `vector`), recording which succeeded. The
first `describe` run is what tells you the int→type mapping; hoist it into named constants afterward.

Flatten the output to parallel arrays (`paths[]`, `classNames[]`, `varNames[]`, `rawTypes[]`, `values[]`) — one
`OnPack()` `StartArray`, no nesting. Reassemble the tree on the TypeScript side.

Guardrails from the start: require an already-running Workbench with an exact active project
(`client.activeProjectGprojPath()` + `canonicalizeGproj` + `isPathContained`, exactly as `validateRegistrationPath`
in [src/tools/wb-resources.ts](../../src/tools/wb-resources.ts) does), and cap recursion depth and total emitted
nodes so a pathological graph cannot hang the NET call.

**Gate:** run `describe` against the Step 1 ACP. Do not write `syncBankSamples` mutation code until its output
names the Bank container class, the samples var, and the sample-entry container class. Commit the raw output to
`tests/fixtures/` — that directory already holds `workbench-resource-meta/` as precedent.

Also run `wb_resources getInfo` against one `.ogg` in `noise_long/` and record the real sound resource class name.
This replaces the unverified `SNDResourceClass` everywhere it appears.

**Open questions this run must also answer** (they decide which preset mechanism is available — see *Preset graph
structures* below; both are cheap to check once a real `.acp` exists):

- **Q1. Is `.acp` the same Enfusion text grammar that [src/formats/enfusion-text.ts](../../src/formats/enfusion-text.ts)
  already parses?** That module handles `.gproj/.et/.ct/.conf/.layer`. Answer it by running `parse()` on the Step 1
  ACP and checking `serialize(parse(x)) === x`. A clean round-trip unlocks preset mechanism B.
- **Q2. Are node IDs and port IDs file-scoped or globally unique?** Copy the Step 1 ACP to a second filename,
  register it, and `describe` both. If the two files carry identical IDs and both load, IDs are file-scoped and
  template-file copying (mechanism A) is safe. If Workbench rejects or renumbers the copy, presets need ID
  remapping and mechanism A is off the table.

### Step 3 — `inspect` and `validate`

Both are `describe` with an interpretation layer, using the constants frozen in Step 2. Keep the walk shared;
these are projections, not second walkers.

`inspect` — Banks (name, sample count, sample paths, selection mode, loop, volume), Sound events (name, trigger,
spatialization), signals, and node count. Connection topology is a stretch goal: node IDs and port IDs are
undocumented internals, so report what the walk actually found and say nothing about what it did not.

`validate` — start with the checks the walk can genuinely prove:

- sample references that resolve to no registered resource (via `ResourceManager.GetMetaFile`)
- sample references whose resource class is not the sound class from Step 2
- duplicate Sound event names
- Banks over the 1024-sample limit
- empty Banks

Defer disconnected-node and invalid-loop/spatial checks until connection topology is actually readable. Reporting a
check you cannot perform is worse than omitting it.

### Step 4 — `syncBankSamples`

Ten steps, in this order, failing closed at each:

1. Require Workbench running, exact active project, not Play mode (`requireResourceManagerMode`).
2. `SetOpenedResource(acpPath)`; refuse on false.
3. `GetContainer(0)`; refuse on null.
4. Find **exactly one** container matching `bankName`. Zero or more than one → refuse, naming what was found.
5. Resolve every requested sample through `ResourceManager.GetMetaFile`. Any unresolved → refuse the **whole**
   operation; no partial writes.
6. Refuse any resolved resource whose class is not the Step 2 sound class.
7. Mutate only the Bank's samples list — `GetObjectArray` → `Insert`/`Remove`, or `SetObjectArray` if the schema
   demands rebuilding. Touch nothing else.
8. Re-read the Bank and verify the post-state matches the request.
9. `ae.Save()`; refuse on false.
10. Return a structured receipt: added / retained / removed, with resolved resource names.

`sampleFolder` resolution stays on the TypeScript side (glob the addon folder, sort deterministically, pass an
explicit array over the wire). The handler only ever receives an explicit list — the Workbench side should not be
doing directory enumeration.

`setBankProperties` (selection mode, loop, streaming, volume, fades) is a thin follow-on once Step 2 has named the
property vars; fold it in if the schema makes it trivial, otherwise leave it for a second pass.

### Step 5 — Wiring

- `src/tools/wb-audio.ts` exporting `registerWbAudio(server, client)`; zod schema discriminated on `action`.
- `src/server.ts`: import + call alongside `registerWbResources`.
- `src/workbench/session-controller.ts`: add `apiFunc === "EMCP_WB_Audio"` to the `documentSwitch` condition,
  with no action filter.
- `npm run observer:generate` to regenerate the manifest, payload descriptor, and `RFWB_HelperBuild.IDENTITY`.
- `tests/workbench/wb-audio-tool.test.ts` following the
  [wb-resources-tool.test.ts](../../tests/workbench/wb-resources-tool.test.ts) pattern: fake `server.registerTool`
  capture, fake client, assert the advertised action enum, assert the out-of-project refusal, assert the
  unresolved-sample refusal produces no call.

---

## Preset graph structures

The steps above automate *maintaining* audio content but leave *authoring* graph structure as GUI work: a new sound
event still means hand-wiring a Bank + Sound pair. Presets are the way to close that gap — define a shape like
"randomized background bed" or "randomized spatial one-shot" once, then stamp it out.

### What is ruled out: building nodes through the live API

`BaseContainer` cannot be duplicated. Its chain is `BaseContainer : BaseResourceObject : global_pointer`, and none
of those declare `Clone`. Only `Managed` declares `proto external ref Managed Clone()`, and `BaseContainerList` is
the `Managed` type here — so the *list wrapper* can be cloned, never an individual node. There is also no
`CreateContainer`/`AddObject` anywhere in the reflection surface: `SetObject` and `BaseContainerList.Insert` both
require an existing `BaseContainer` that nothing in the documented API can mint.

Conclusion: a preset cannot be instantiated by asking the engine to construct nodes. Structure has to come from a
file. Two mechanisms do that.

### Mechanism A — template-file presets (needs no new capability)

Hand-build `_TEMPLATE_RandomBed.acp` and `_TEMPLATE_SpatialOneShot.acp` once, in the same place the Step 1 specimen
lives. Instantiating a preset is then:

1. copy the template file to the target name
2. `wb_resources register` the copy
3. `wb_audio syncBankSamples` to fill the Bank
4. `wb_audio setBankProperties` for selection mode / loop / volume
5. `wb_audio validate` to confirm

Structure is *carried* by the file rather than generated, so this works with Steps 1–5 exactly as written — no extra
handler code. It is the "build the skeleton once" idea generalized to N reusable shapes.

**Gated on Q2.** If node/port IDs turn out to be globally unique rather than file-scoped, a copied template will
collide and this mechanism is dead.

**Limitation:** one preset instance per ACP file. Adding a *second* bed to an existing ACP is node creation again,
which only mechanism B reaches.

### Mechanism B — text-level generation with the existing parser

[src/formats/enfusion-text.ts](../../src/formats/enfusion-text.ts) already parses and serializes the Enfusion text
grammar, exporting `parse`, `serialize`, `createNode`, `setProperty`, and `getProperty`, with a round-trip test
suite in [tests/formats/enfusion-text.test.ts](../../tests/formats/enfusion-text.test.ts). If `.acp` uses that same
grammar (**Q1**), node insertion and ID remapping come nearly free, and multi-instance presets become possible.

This is also the answer to the fragility objection against external ACP generators. A generator alone drifts
silently when an engine update changes undocumented internals. Pairing it with the live handler removes that
failure mode: generate the text offline, then `describe` and `validate` through Workbench to prove the engine
actually loaded what was meant. **Generator plus live verifier is strictly stronger than either alone** — and it is
the reason the live handler is worth building even if text generation ends up doing the structural work.

### Where presets should live

The repo already has a preset system worth reusing rather than reinventing:
[src/templates/recipe-loader.ts](../../src/templates/recipe-loader.ts) lazily loads and validates JSON recipes from
[data/recipes/](../../data/recipes/), caches them, and merges variant overrides, exposing a singleton
`recipeLoader.getRecipe(id, variant?)`. The recipe schema in
[src/templates/recipe.ts](../../src/templates/recipe.ts) carries `defaultParent`, `subdirectory`,
`overrideComponents`, `variants`, and `postCreateNotes`.

An audio preset wants structurally the same fields — template ACP instead of `defaultParent`, bank name, selection
mode, volume, sample folder, plus a post-create checklist. A `data/recipes/audio/` set should fit the existing
loader with little change. Follow the `prefab` precedent: recipes describe, the generator applies, the tool
validates at entry.

### Sequencing

Presets are a **follow-on milestone**, not part of Steps 1–5. Q1 and Q2 are answered as a side effect of the Step 2
discovery run, so no separate investigation is needed — just do not commit to a mechanism before that run.

---

## Deferred

**`.snd` conversion.** `AudioEditor.ExecuteAction(menuPath, bKeepFocus)` is inherited and would in principle reach a
converter menu item. But that is precisely the hazard `EMCP_WB_ExecuteAction.c` refuses by design, and the session
controller already carries native-modal detection machinery (`describeNativeDialogEvidence`) because Workbench
dialogs are a known failure mode. A converter path must first prove its menu item is callable and nonmodal, and must
route through the modal-evidence path. Do not promise it.

**Connection topology editing.** Node IDs, port IDs, and connection containers are undocumented internals. Read them
if `describe` surfaces them; do not write them.

**In-engine node construction.** Not deferred by choice — ruled out. `BaseContainer` has no `Clone` and the
reflection surface offers no way to create one, so nodes cannot be minted through the live API at all. See
*Preset graph structures* for the two file-based mechanisms that reach the same goal.

---

## Verification

1. `npm run typecheck` and `npm run test`.
2. `npm run observer:manifest:check` — must pass, proving the manifest and payload descriptor were regenerated.
3. Live: launch Workbench on the RainbowVeil project, then
   - `wb_audio { action: "describe", acpPath: <Step 1 ACP> }` → tree matches the committed fixture
   - `wb_audio { action: "inspect", ... }` → reports `RV_ENV_BANK_BEDS` with its two samples
   - `wb_audio { action: "validate", ... }` → clean
   - `wb_audio { action: "syncBankSamples", bankName: "RV_ENV_BANK_BEDS", samples: [<three from noise_long>] }`
     → receipt shows one added, two retained
   - reopen the ACP in Audio Editor and confirm the Bank visually matches
4. Negative cases, each must refuse without mutating: a sample outside the active project; a `.txt` posing as a
   sample; a `bankName` matching zero nodes; a `bankName` matching two nodes; Workbench in Play mode.
5. Regression: with an explicit target-bound save session active (`wb_launch { gprojPath, resourcePath }`), a
   `wb_audio` call must trip the `TARGET_SESSION_TAINTED` guard rather than silently switching the document.
