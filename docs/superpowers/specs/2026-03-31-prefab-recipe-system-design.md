# Prefab Recipe System Design

**Date:** 2026-03-31  
**Status:** Approved  
**Scope:** Replace hardcoded `PREFAB_CONFIGS` with a JSON recipe system and expand prefab types from 7 to 12 categories with variant support.

---

## Problem

The current `prefab create` tool has 7 hardcoded type configs (`character`, `vehicle`, `weapon`, `spawnpoint`, `gamemode`, `interactive`, `generic`) with 2–3 placeholder components each. This means:

- Saying "make a handgun" produces a prefab with only `WeaponComponent` + `MeshObject` — missing the ~10 other components a real weapon needs.
- The user or LLM must manually look up and specify all required components.
- Type configs are in TypeScript, requiring code changes to update or extend.

The ancestry resolver already exists and correctly pulls in inherited components from base game prefabs. The gap is that the `prefab create` tool doesn't know which base game prefab to point to for a given intent.

---

## Chosen Approach

**Replace** the hardcoded `PREFAB_CONFIGS` with a hybrid system:

- **TypeScript schema** (`src/templates/recipe.ts`) — defines and validates the recipe structure at build time.
- **JSON data files** (`data/recipes/*.json`) — one file per category, editable without code changes.
- **Recipe loader** (`src/templates/recipe-loader.ts`) — reads and caches JSON files, merges variant overrides.

Recipes are **thin guidance layers**, not full component trees. Each recipe points to the correct base game parent prefab; the existing ancestry resolver handles pulling in all inherited components automatically. Recipes only define:

1. The correct `defaultParent` path per type/variant
2. The `overrideComponents` a modder typically customizes (with placeholder values)
3. `postCreateNotes` — what the user still needs to fill in

Old type names (`weapon`, `vehicle`, `interactive`) are removed. New types are added. The `prefabType` enum expands to 12 values with an optional `variant` parameter.

---

## Architecture

### Recipe Schema (`src/templates/recipe.ts`)

```typescript
interface RecipeOverrideComponent {
  type: string;                          // e.g. "MeshObject"
  properties?: Record<string, string>;   // Placeholder values
  comment?: string;                      // What to fill in
}

interface RecipeVariant {
  name: string;
  description: string;
  defaultParent?: string;                // Override base parent
  subdirectory?: string;                 // Override output directory
  overrideComponents?: RecipeOverrideComponent[];
  postCreateNotes?: string[];
}

interface PrefabRecipe {
  id: string;                            // Matches prefabType enum value
  name: string;
  description: string;
  entityType: string;                    // Root entity class
  subdirectory: string;                  // Output path under project root
  defaultParent: string;                 // Base game parent (empty = standalone)
  overrideComponents: RecipeOverrideComponent[];
  variants?: RecipeVariant[];
  postCreateNotes: string[];
}
```

### Recipe Loader (`src/templates/recipe-loader.ts`)

- On first call, reads all `data/recipes/*.json`, validates schema, caches in `Map<string, PrefabRecipe>`.
- `getRecipe(id, variant?)` — returns base recipe merged with variant overrides.
- `listRecipes()` — returns all recipe IDs and variant names (for tool description).

### Changes to `src/templates/prefab.ts`

- `PrefabType` union replaced with recipe IDs: `"firearm" | "attachment" | "ground_vehicle" | "air_vehicle" | "character" | "prop" | "building" | "item" | "group" | "spawnpoint" | "gamemode" | "generic"`
- `PREFAB_CONFIGS` object removed.
- `PrefabOptions` gains `variant?: string`.
- `generatePrefab()` calls `getRecipe(prefabType, variant)` instead of `PREFAB_CONFIGS[type]`.
- Override components from recipe are merged after ancestry-resolved components (ancestry wins for GUIDs, recipe adds any not already present).

### Changes to `src/tools/prefab.ts`

- `prefabType` enum schema updated to match new recipe IDs.
- New optional `variant` parameter added.
- `ancestry resolution` still runs on top when `parentPrefab` provided, or falls back to recipe's `defaultParent`.
- Tool response appends `postCreateNotes` as a checklist.

---

## Recipe Categories

| Recipe ID | Entity Type | Default Parent | Variants |
|---|---|---|---|
| `firearm` | `GenericEntity` | `Prefabs/Weapons/Core/Weapon_Base.et` | `handgun` → `Handgun_Base.et`, `rifle` → `Rifle_Base.et`, `launcher` → `Launcher_Base.et`, `machinegun` → `MachineGun_Base.et` |
| `attachment` | `GenericEntity` | `Prefabs/Weapons/Core/Attachment_Base.et` | `suppressor` → `Suppressor_base.et`, `optic` → `WeaponSight_Base.et`, `muzzle_device` → `MuzzleDevice_base.et` |
| `ground_vehicle` | `Vehicle` | `Prefabs/Vehicles/Core/Wheeled_Base.et` | `car` → `Wheeled_Car_Base.et`, `truck` → `Wheeled_Truck_Base.et`, `apc` → `Wheeled_APC_Base.et`, `tracked` → `TrackedVehicle_Base.et` |
| `air_vehicle` | `Vehicle` | `Prefabs/Vehicles/Core/Helicopter_Base.et` | (single variant) |
| `character` | `SCR_ChimeraCharacter` | `Prefabs/Characters/Core/Character_Base.et` | `soldier`, `civilian` |
| `prop` | `GenericEntity` | `Prefabs/Props/Core/Props_Base.et` | `static` (default), `destructible` → `DestructibleEntity_Props_Base.et` |
| `building` | `SCR_DestructibleBuildingEntity` | `Prefabs/Structures/Core/Building_Base.et` | (none) |
| `item` | `GenericEntity` | `Prefabs/Items/Core/Item_Base.et` | (none — covers inventory items, gadgets, consumables) |
| `group` | `SCR_AIGroup` | `Prefabs/Groups/PlayableGroup.et` | (none — AI squads, faction group definitions) |
| `spawnpoint` | `GenericEntity` | `Prefabs/Systems/SpawnPoints/SpawnPosition.et` | (none) |
| `gamemode` | `GenericEntity` | (none — standalone) | `conflict`, `coop` |
| `generic` | `GenericEntity` | (none — fully custom) | (none) |

Parent paths are verified against actual base game files. All paths above exist in the game's pak archives.

---

## Data Flow

```
User: "make a handgun called MyPistol"
  ↓
LLM calls: prefab create { name: "MyPistol", prefabType: "firearm", variant: "handgun" }
  ↓
recipe-loader: reads firearm.json, applies "handgun" variant
  → defaultParent = "Prefabs/Weapons/Core/Handgun_Base.et"
  → subdirectory = "Prefabs/Weapons/Handguns"
  → overrideComponents = [MeshObject{Object:""}, WeaponSoundComponent{Filenames:""}]
  ↓
walkChain("Prefabs/Weapons/Core/Handgun_Base.et")
  → resolves Weapon_Base.et → Handgun_Base.et
  → merges ~25 components with real GUIDs
  ↓
generatePrefab()
  → ancestry components (with real GUIDs from base game)
  + recipe override components (MeshObject, WeaponSoundComponent with placeholders)
  → serialized .et file
  ↓
Written to: {projectPath}/Prefabs/Weapons/Handguns/MyPistol.et
  ↓
Response:
  Prefab created: Prefabs/Weapons/Handguns/MyPistol.et
  Type: firearm (variant: handgun)
  Ancestry: 2 levels, 25 inherited components

  Required follow-up:
  [ ] Set MeshObject.Object to your weapon .xob model path
  [ ] Configure WeaponSoundComponent with .acp sound files
  [ ] Set up fire modes in MuzzleComponent (default: Safe + Single, 500 RPM)
  [ ] Configure SightsComponent ADS camera (PivotID: "eye")
```

---

## Files to Create/Modify

### New files
- `src/templates/recipe.ts` — TypeScript interfaces (RecipeOverrideComponent, RecipeVariant, PrefabRecipe)
- `src/templates/recipe-loader.ts` — JSON file loading, caching, variant merging
- `data/recipes/firearm.json`
- `data/recipes/attachment.json`
- `data/recipes/ground_vehicle.json`
- `data/recipes/air_vehicle.json`
- `data/recipes/character.json`
- `data/recipes/prop.json`
- `data/recipes/building.json`
- `data/recipes/item.json`
- `data/recipes/group.json`
- `data/recipes/spawnpoint.json`
- `data/recipes/gamemode.json`
- `data/recipes/generic.json`

### Modified files
- `src/templates/prefab.ts` — remove `PREFAB_CONFIGS`, integrate recipe loader
- `src/tools/prefab.ts` — update enum, add `variant` param, add `postCreateNotes` to response
- `tests/templates/prefab.test.ts` — update tests for new type names and recipe system

---

## Testing

Existing 14 prefab template tests need updating for:
- New `prefabType` values (old names removed)
- `variant` parameter behaviour
- `postCreateNotes` presence in output
- Recipe fallback when ancestry unavailable

New tests:
- Recipe loader: reads JSON, validates schema, merges variants correctly
- Each recipe category: generates valid `.et` with correct entity type and parent path
- Override components merge correctly (ancestry GUIDs preserved, recipe fills gaps)

---

## What Does NOT Change

- The ancestry resolver (`src/utils/prefab-ancestry.ts`) — untouched
- The `action=inspect` path — untouched
- The `.et` format serializer (`src/formats/enfusion-text.ts`) — untouched
- The `game_duplicate` tool — untouched
- All workbench tools — untouched
- The `ComponentDef` interface — unchanged
