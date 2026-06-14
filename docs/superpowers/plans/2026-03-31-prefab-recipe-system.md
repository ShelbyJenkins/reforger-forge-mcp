# Prefab Recipe System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded `PREFAB_CONFIGS` with a JSON recipe system, expand prefab types from 7 to 12 categories, and add variant support for intelligent prefab generation.

**Architecture:** Recipe loader reads JSON files from `data/recipes/` on first use, validates against TypeScript schema, and merges variant overrides. The existing ancestry resolver automatically pulls inherited components from base game prefabs. Tool responses include post-creation checklists.

**Tech Stack:** TypeScript, JSON, Vitest (existing test framework), zod for validation (if available, else manual)

---

## File Structure

### New Files
- `src/templates/recipe.ts` — TypeScript schema (interfaces + types)
- `src/templates/recipe-loader.ts` — Loader, caching, validation, merging
- `data/recipes/firearm.json` — Weapon recipes (handgun, rifle, launcher, machinegun variants)
- `data/recipes/attachment.json` — Attachment recipes (suppressor, optic, muzzle_device)
- `data/recipes/ground_vehicle.json` — Ground vehicle recipes (car, truck, apc, tracked)
- `data/recipes/air_vehicle.json` — Air vehicle recipes (helicopter)
- `data/recipes/character.json` — Character recipes (soldier, civilian)
- `data/recipes/prop.json` — Prop recipes (static, destructible)
- `data/recipes/building.json` — Building recipes
- `data/recipes/item.json` — Item recipes
- `data/recipes/group.json` — Group recipes
- `data/recipes/spawnpoint.json` — Spawnpoint recipes
- `data/recipes/gamemode.json` — Gamemode recipes (conflict, coop)
- `data/recipes/generic.json` — Generic (empty) recipe

### Modified Files
- `src/templates/prefab.ts` — Remove `PREFAB_CONFIGS`, add `variant` param, integrate recipe loader
- `src/tools/prefab.ts` — Update `prefabType` enum, add `variant` param, format response with checklist
- `tests/templates/prefab.test.ts` — Update tests for new types and recipe system

---

## Task Breakdown

### Task 1: Create Recipe TypeScript Schema

**Files:**
- Create: `src/templates/recipe.ts`

- [ ] **Step 1: Write failing test for recipe schema validation**

Create `tests/templates/recipe.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { PrefabRecipe, RecipeVariant, RecipeOverrideComponent } from "../../src/templates/recipe.js";

describe("Recipe Schema", () => {
  it("defines PrefabRecipe interface with required fields", () => {
    // This test verifies the schema exists and is importable
    const recipe: PrefabRecipe = {
      id: "firearm",
      name: "Firearm",
      description: "Handheld firearm",
      entityType: "GenericEntity",
      subdirectory: "Prefabs/Weapons",
      defaultParent: "Prefabs/Weapons/Core/Weapon_Base.et",
      overrideComponents: [
        {
          type: "MeshObject",
          properties: { Object: "" },
          comment: "Your weapon .xob path"
        }
      ],
      postCreateNotes: ["Set MeshObject.Object"]
    };
    expect(recipe.id).toBe("firearm");
  });

  it("defines RecipeVariant interface", () => {
    const variant: RecipeVariant = {
      name: "handgun",
      description: "Pistol / sidearm",
      defaultParent: "Prefabs/Weapons/Core/Handgun_Base.et",
      subdirectory: "Prefabs/Weapons/Handguns"
    };
    expect(variant.name).toBe("handgun");
  });

  it("defines RecipeOverrideComponent interface", () => {
    const comp: RecipeOverrideComponent = {
      type: "MeshObject",
      properties: { Object: "" },
      comment: "Required"
    };
    expect(comp.type).toBe("MeshObject");
  });
});
```

- [ ] **Step 2: Run test to verify it fails (schema not yet defined)**

Run: `npm test tests/templates/recipe.test.ts`
Expected: FAIL with "Cannot find module" or "type not found"

- [ ] **Step 3: Write the schema interfaces**

Create `src/templates/recipe.ts`:

```typescript
/**
 * A single component override in a recipe.
 * Properties are placeholder values (empty strings) that the user must fill in.
 */
export interface RecipeOverrideComponent {
  /** Component class name (e.g., "MeshObject", "WeaponSoundComponent") */
  type: string;
  /** Default/placeholder property values */
  properties?: Record<string, string>;
  /** Guidance comment for what to fill in */
  comment?: string;
}

/**
 * A variant of a recipe category.
 * Variants override the base recipe's parent, subdirectory, and/or components.
 */
export interface RecipeVariant {
  /** Variant identifier (e.g., "handgun", "rifle") */
  name: string;
  /** Human-readable description */
  description: string;
  /** Override base recipe's defaultParent if set */
  defaultParent?: string;
  /** Override base recipe's subdirectory if set */
  subdirectory?: string;
  /** Additional or overriding components for this variant */
  overrideComponents?: RecipeOverrideComponent[];
  /** Variant-specific post-creation notes */
  postCreateNotes?: string[];
}

/**
 * A complete recipe for a prefab category.
 * Recipes are thin guidance layers; ancestry resolver pulls inherited components automatically.
 */
export interface PrefabRecipe {
  /** Recipe identifier, matches prefabType enum value */
  id: string;
  /** Human-readable category name */
  name: string;
  /** Description of what this category covers */
  description: string;
  /** Root entity class (e.g., "GenericEntity", "SCR_ChimeraCharacter") */
  entityType: string;
  /** Output subdirectory under project root (e.g., "Prefabs/Weapons") */
  subdirectory: string;
  /** Base game parent prefab path (empty string = standalone) */
  defaultParent: string;
  /** Components a modder typically customizes (with placeholder values) */
  overrideComponents: RecipeOverrideComponent[];
  /** Optional variants that specialize this recipe */
  variants?: RecipeVariant[];
  /** Checklist of what user must fill in after prefab creation */
  postCreateNotes: string[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test tests/templates/recipe.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/templates/recipe.ts tests/templates/recipe.test.ts
git commit -m "feat: add recipe TypeScript schema

Define PrefabRecipe, RecipeVariant, and RecipeOverrideComponent interfaces
for the recipe system. Recipes are thin guidance layers on top of ancestry
resolution — each recipe points to the correct base game parent prefab.

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

### Task 2: Create Recipe Loader

**Files:**
- Create: `src/templates/recipe-loader.ts`

- [ ] **Step 1: Write failing test for recipe loader**

Add to `tests/templates/recipe.test.ts`:

```typescript
import { RecipeLoader } from "../../src/templates/recipe-loader.js";
import { join } from "node:path";

describe("RecipeLoader", () => {
  it("loads and caches recipes from JSON files", async () => {
    const loader = new RecipeLoader(join(process.cwd(), "data", "recipes"));
    const firearmRecipe = loader.getRecipe("firearm");
    
    expect(firearmRecipe).toBeDefined();
    expect(firearmRecipe.id).toBe("firearm");
    expect(firearmRecipe.name).toBe("Firearm");
  });

  it("merges variant overrides onto base recipe", () => {
    const loader = new RecipeLoader(join(process.cwd(), "data", "recipes"));
    const handgunRecipe = loader.getRecipe("firearm", "handgun");
    
    expect(handgunRecipe).toBeDefined();
    expect(handgunRecipe.defaultParent).toContain("Handgun_Base.et");
  });

  it("lists all available recipes and variants", () => {
    const loader = new RecipeLoader(join(process.cwd(), "data", "recipes"));
    const list = loader.listRecipes();
    
    expect(list).toContain("firearm");
    expect(list).toContain("attachment");
    expect(list).toContain("character");
  });

  it("returns undefined for unknown recipe", () => {
    const loader = new RecipeLoader(join(process.cwd(), "data", "recipes"));
    const unknown = loader.getRecipe("unknown_type");
    
    expect(unknown).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/templates/recipe.test.ts`
Expected: FAIL with "Cannot find module" or "RecipeLoader not found"

- [ ] **Step 3: Write recipe loader implementation**

Create `src/templates/recipe-loader.ts`:

```typescript
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../utils/logger.js";
import type { PrefabRecipe } from "./recipe.js";

/**
 * Loads and caches prefab recipes from JSON files.
 * On first use, reads all data/recipes/*.json, validates structure,
 * and caches them in memory.
 */
export class RecipeLoader {
  private recipesDir: string;
  private cache: Map<string, PrefabRecipe> = new Map();
  private loaded = false;

  constructor(recipesDir: string) {
    this.recipesDir = recipesDir;
  }

  /**
   * Lazily load all recipes on first access.
   * Scans the recipes directory and reads all .json files.
   */
  private ensureLoaded(): void {
    if (this.loaded) return;

    try {
      const files = readdirSync(this.recipesDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;

        try {
          const path = resolve(this.recipesDir, file);
          const raw = readFileSync(path, "utf-8");
          const recipe = JSON.parse(raw) as PrefabRecipe;

          // Basic validation: id and required fields must exist
          if (!recipe.id || !recipe.name || !recipe.entityType) {
            logger.warn(`Invalid recipe in ${file}: missing required fields`);
            continue;
          }

          this.cache.set(recipe.id, recipe);
        } catch (e) {
          logger.warn(`Failed to load recipe from ${file}: ${String(e)}`);
        }
      }

      this.loaded = true;
      logger.debug(`Loaded ${this.cache.size} recipes from ${this.recipesDir}`);
    } catch (e) {
      logger.warn(`Failed to load recipes directory: ${String(e)}`);
      this.loaded = true; // Prevent repeated attempts
    }
  }

  /**
   * Get a recipe by ID and optional variant.
   * Returns the base recipe with variant overrides merged on top.
   * Returns undefined if recipe not found.
   */
  getRecipe(id: string, variant?: string): PrefabRecipe | undefined {
    this.ensureLoaded();

    const base = this.cache.get(id);
    if (!base) return undefined;

    // No variant requested, return base recipe
    if (!variant) return base;

    // Find the variant in the recipe
    const variantDef = base.variants?.find((v) => v.name === variant);
    if (!variantDef) {
      logger.warn(`Variant "${variant}" not found in recipe "${id}"`);
      return base;
    }

    // Merge variant overrides onto a copy of the base recipe
    const merged: PrefabRecipe = {
      ...base,
      defaultParent: variantDef.defaultParent ?? base.defaultParent,
      subdirectory: variantDef.subdirectory ?? base.subdirectory,
      overrideComponents: variantDef.overrideComponents ?? base.overrideComponents,
      postCreateNotes: variantDef.postCreateNotes ?? base.postCreateNotes,
    };

    return merged;
  }

  /**
   * List all available recipe IDs.
   * Used by the tool description to show available types.
   */
  listRecipes(): string[] {
    this.ensureLoaded();
    return Array.from(this.cache.keys());
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test tests/templates/recipe.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/templates/recipe-loader.ts
git commit -m "feat: implement recipe loader with lazy loading and variant merging

Loader reads all JSON files from data/recipes/ on first access, validates
basic structure, and caches recipes in memory. getRecipe() merges variant
overrides onto base recipes. listRecipes() returns available recipe IDs.

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

### Task 3: Create Firearm Recipe JSON

**Files:**
- Create: `data/recipes/firearm.json`

- [ ] **Step 1: Write firearm.json**

Create `data/recipes/firearm.json`:

```json
{
  "id": "firearm",
  "name": "Firearm",
  "description": "Any handheld firearm: pistol, rifle, SMG, LMG, launcher",
  "entityType": "GenericEntity",
  "subdirectory": "Prefabs/Weapons",
  "defaultParent": "Prefabs/Weapons/Core/Weapon_Base.et",
  "overrideComponents": [
    {
      "type": "MeshObject",
      "properties": { "Object": "" },
      "comment": "REQUIRED: your weapon .xob model path"
    },
    {
      "type": "WeaponSoundComponent",
      "properties": { "Filenames": "" },
      "comment": "Your weapon .acp sound file paths"
    }
  ],
  "variants": [
    {
      "name": "handgun",
      "description": "Pistol / sidearm",
      "defaultParent": "Prefabs/Weapons/Core/Handgun_Base.et",
      "subdirectory": "Prefabs/Weapons/Handguns",
      "postCreateNotes": [
        "Configure MuzzleComponent fire modes (default: Safe + Single, 500 RPM)",
        "Optics slot disabled by default — enable if needed",
        "Adjust SightsComponent ADS time (default: 0.2s)"
      ]
    },
    {
      "name": "rifle",
      "description": "Assault rifle / battle rifle",
      "defaultParent": "Prefabs/Weapons/Core/Rifle_Base.et",
      "subdirectory": "Prefabs/Weapons/Rifles",
      "postCreateNotes": [
        "Add muzzle attachment context if supporting suppressors",
        "Configure bipod deployment settings if applicable",
        "Adjust SightsComponent ADS time (default: 0.35s)"
      ]
    },
    {
      "name": "launcher",
      "description": "Rocket or grenade launcher",
      "defaultParent": "Prefabs/Weapons/Core/Launcher_Base.et",
      "subdirectory": "Prefabs/Weapons/Launchers",
      "postCreateNotes": [
        "Uses SCR_MuzzleInMagComponent (projectile loaded as magazine)",
        "Configure backblast via SCR_WeaponBlastComponent",
        "Set MaxAmmo in SCR_MuzzleInMagComponent (default: 1)"
      ]
    },
    {
      "name": "machinegun",
      "description": "Light or general-purpose machine gun",
      "defaultParent": "Prefabs/Weapons/Core/MachineGun_Base.et",
      "subdirectory": "Prefabs/Weapons/MachineGuns",
      "postCreateNotes": [
        "Configure MuzzleComponent fire rate (default: 650 RPM)",
        "Enable bipod deployment for prone stance",
        "Adjust muzzle climb properties in WeaponComponent"
      ]
    }
  ],
  "postCreateNotes": [
    "Set MeshObject.Object to your weapon .xob model path",
    "Configure WeaponSoundComponent with .acp sound file paths",
    "Set up fire modes in MuzzleComponent (Safe, Single, Auto, Burst)",
    "Configure SightsComponent ADS camera (PivotID: 'eye', offset if needed)"
  ]
}
```

- [ ] **Step 2: Verify JSON is valid**

Run: `node -e "console.log(JSON.parse(require('fs').readFileSync('data/recipes/firearm.json', 'utf-8')))"`
Expected: Pretty-printed JSON object

- [ ] **Step 3: Commit**

```bash
git add data/recipes/firearm.json
git commit -m "data: add firearm recipe with handgun, rifle, launcher, machinegun variants

Each variant specifies a different base game parent prefab and post-creation
notes. Override components define placeholders for MeshObject and sound files.

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

### Task 4: Create Remaining Recipe JSON Files

**Files:**
- Create: `data/recipes/{attachment,ground_vehicle,air_vehicle,character,prop,building,item,group,spawnpoint,gamemode,generic}.json`

- [ ] **Step 1: Create attachment.json**

```bash
cat > data/recipes/attachment.json << 'EOF'
{
  "id": "attachment",
  "name": "Attachment",
  "description": "Weapon attachments: optics, suppressors, muzzle devices, grips",
  "entityType": "GenericEntity",
  "subdirectory": "Prefabs/Weapons/Attachments",
  "defaultParent": "Prefabs/Weapons/Core/Attachment_Base.et",
  "overrideComponents": [
    {
      "type": "MeshObject",
      "properties": { "Object": "" },
      "comment": "Your attachment .xob model path"
    }
  ],
  "variants": [
    {
      "name": "suppressor",
      "description": "Muzzle suppressor",
      "defaultParent": "Prefabs/Weapons/Core/Suppressor_base.et",
      "subdirectory": "Prefabs/Weapons/Attachments/Suppressors",
      "postCreateNotes": [
        "Add SCR_WeaponAttachmentSuppressorAttributes to InventoryItemComponent",
        "Configure velocity and dispersion reduction factors",
        "Set sound switching if using dual .acp files"
      ]
    },
    {
      "name": "optic",
      "description": "Optics sight or scope",
      "defaultParent": "Prefabs/Weapons/Core/WeaponSight_Base.et",
      "subdirectory": "Prefabs/Weapons/Attachments/Optics",
      "postCreateNotes": [
        "Configure SightsComponent magnification and FOV",
        "Set up PIP (picture-in-picture) material if applicable",
        "Define sight reticle mesh or sprite"
      ]
    },
    {
      "name": "muzzle_device",
      "description": "Muzzle brake or flash hider",
      "defaultParent": "Prefabs/Weapons/Core/MuzzleDevice_base.et",
      "subdirectory": "Prefabs/Weapons/Attachments/MuzzleDevices",
      "postCreateNotes": [
        "Configure recoil reduction in MuzzleComponent",
        "Adjust muzzle flash visibility if different from baseline"
      ]
    }
  ],
  "postCreateNotes": [
    "Set MeshObject.Object to your attachment .xob model path",
    "Configure snap_weapon bone for mounting to weapons",
    "Set up InventoryItemComponent attributes for compatibility"
  ]
}
EOF
```

- [ ] **Step 2: Create ground_vehicle.json**

```bash
cat > data/recipes/ground_vehicle.json << 'EOF'
{
  "id": "ground_vehicle",
  "name": "Ground Vehicle",
  "description": "Wheeled or tracked ground vehicles",
  "entityType": "Vehicle",
  "subdirectory": "Prefabs/Vehicles",
  "defaultParent": "Prefabs/Vehicles/Core/Wheeled_Base.et",
  "overrideComponents": [
    {
      "type": "MeshObject",
      "properties": { "Object": "" },
      "comment": "Your vehicle .xob model path"
    }
  ],
  "variants": [
    {
      "name": "car",
      "description": "Light wheeled vehicle (car, jeep)",
      "defaultParent": "Prefabs/Vehicles/Core/Wheeled_Car_Base.et",
      "subdirectory": "Prefabs/Vehicles/Wheeled/Cars",
      "postCreateNotes": [
        "Configure wheel count and suspension in VehicleWheeledSimulation",
        "Set fuel tank capacity in SCR_FuelManagerComponent",
        "Define compartment slots for driver and passengers"
      ]
    },
    {
      "name": "truck",
      "description": "Medium wheeled cargo vehicle",
      "defaultParent": "Prefabs/Vehicles/Core/Wheeled_Truck_Base.et",
      "subdirectory": "Prefabs/Vehicles/Wheeled/Trucks",
      "postCreateNotes": [
        "Increase fuel tank capacity (500+ L recommended)",
        "Configure cargo compartment slots",
        "Adjust weight and max speed properties"
      ]
    },
    {
      "name": "apc",
      "description": "Armored personnel carrier",
      "defaultParent": "Prefabs/Vehicles/Core/Wheeled_APC_Base.et",
      "subdirectory": "Prefabs/Vehicles/Wheeled/APCs",
      "postCreateNotes": [
        "Configure armor values in SCR_VehicleDamageManagerComponent",
        "Set up multiple passenger compartments",
        "Add weapon turret slots if applicable"
      ]
    },
    {
      "name": "tracked",
      "description": "Tracked vehicle (tank, IFV)",
      "defaultParent": "Prefabs/Vehicles/Core/TrackedVehicle_Base.et",
      "subdirectory": "Prefabs/Vehicles/Tracked",
      "postCreateNotes": [
        "Configure track simulation parameters",
        "Set high armor values for combat vehicles",
        "Define turret rotation and gun traverse limits"
      ]
    }
  ],
  "postCreateNotes": [
    "Set MeshObject.Object to your vehicle .xob model path",
    "Configure VehicleWheeledSimulation or VehicleTrackedSimulation",
    "Set compartment slots (driver, passengers, cargo)",
    "Configure SCR_FuelManagerComponent fuel tank properties"
  ]
}
EOF
```

- [ ] **Step 3: Create air_vehicle.json**

```bash
cat > data/recipes/air_vehicle.json << 'EOF'
{
  "id": "air_vehicle",
  "name": "Air Vehicle",
  "description": "Rotary-wing and fixed-wing aircraft",
  "entityType": "Vehicle",
  "subdirectory": "Prefabs/Vehicles",
  "defaultParent": "Prefabs/Vehicles/Core/Helicopter_Base.et",
  "overrideComponents": [
    {
      "type": "MeshObject",
      "properties": { "Object": "" },
      "comment": "Your aircraft .xob model path"
    }
  ],
  "postCreateNotes": [
    "Set MeshObject.Object to your aircraft .xob model path",
    "Configure VehicleHelicopterSimulation rotor properties",
    "Set up pilot compartment and passenger seats",
    "Configure fuel tank capacity (typically 1000+ L for helicopters)"
  ]
}
EOF
```

- [ ] **Step 4: Create character.json**

```bash
cat > data/recipes/character.json << 'EOF'
{
  "id": "character",
  "name": "Character",
  "description": "Playable or AI characters",
  "entityType": "SCR_ChimeraCharacter",
  "subdirectory": "Prefabs/Characters",
  "defaultParent": "Prefabs/Characters/Core/Character_Base.et",
  "overrideComponents": [],
  "variants": [
    {
      "name": "soldier",
      "description": "Military character with full loadout",
      "postCreateNotes": [
        "Set character identity (head, body, voice) in SCR_CharacterIdentityComponent",
        "Configure faction affiliation in FactionAffiliationComponent",
        "Set up loadout slots (hat, jacket, pants, boots, vest, backpack)",
        "Assign starting weapons and equipment in BaseLoadoutManagerComponent"
      ]
    },
    {
      "name": "civilian",
      "description": "Civilian character with minimal gear",
      "postCreateNotes": [
        "Set character identity to civilian head/body meshes",
        "Clear or minimize weapon loadout",
        "Configure civilian-appropriate clothing loadout",
        "Disable tactical equipment slots as needed"
      ]
    }
  ],
  "postCreateNotes": [
    "Configure SceneCharacterIdentityComponent with head and body prefabs",
    "Set FactionAffiliationComponent faction key to match faction",
    "Define BaseLoadoutManagerComponent slots and initial equipment",
    "Set up AI behavior if this is an AI character"
  ]
}
EOF
```

- [ ] **Step 5: Create prop.json**

```bash
cat > data/recipes/prop.json << 'EOF'
{
  "id": "prop",
  "name": "Prop",
  "description": "Static or destructible props and decorations",
  "entityType": "GenericEntity",
  "subdirectory": "Prefabs/Props",
  "defaultParent": "Prefabs/Props/Core/Props_Base.et",
  "overrideComponents": [
    {
      "type": "MeshObject",
      "properties": { "Object": "" },
      "comment": "Your prop .xob model path"
    }
  ],
  "variants": [
    {
      "name": "static",
      "description": "Non-destructible static prop",
      "defaultParent": "Prefabs/Props/Core/Props_Base.et",
      "postCreateNotes": [
        "Ensure RigidBody has Static=1 for non-moving props",
        "Set LOD factors appropriate for prop size"
      ]
    },
    {
      "name": "destructible",
      "description": "Destructible prop with destruction states",
      "defaultParent": "Prefabs/Props/Core/DestructibleEntity_Props_Base.et",
      "postCreateNotes": [
        "Configure SCR_DestructionMultiPhaseComponent phases",
        "Set destruction particle effects",
        "Define destruction sound events"
      ]
    }
  ],
  "postCreateNotes": [
    "Set MeshObject.Object to your prop .xob model path",
    "Enable RigidBody.ModelGeometry if prop has collision",
    "Configure LOD factors based on visual importance",
    "Add Hierarchy component for proper replication"
  ]
}
EOF
```

- [ ] **Step 6: Create remaining recipe files**

```bash
cat > data/recipes/building.json << 'EOF'
{
  "id": "building",
  "name": "Building",
  "description": "Buildings and structures",
  "entityType": "SCR_DestructibleBuildingEntity",
  "subdirectory": "Prefabs/Structures",
  "defaultParent": "Prefabs/Structures/Core/Building_Base.et",
  "overrideComponents": [
    {
      "type": "MeshObject",
      "properties": { "Object": "" },
      "comment": "Your building .xob model path"
    }
  ],
  "postCreateNotes": [
    "Set MeshObject.Object to your building .xob model path",
    "Configure destruction phases in SCR_DestructionMultiPhaseComponent",
    "Set worldScale and damage thresholds for destruction"
  ]
}
EOF

cat > data/recipes/item.json << 'EOF'
{
  "id": "item",
  "name": "Item",
  "description": "Inventory items, gadgets, consumables",
  "entityType": "GenericEntity",
  "subdirectory": "Prefabs/Items",
  "defaultParent": "Prefabs/Items/Core/Item_Base.et",
  "overrideComponents": [
    {
      "type": "MeshObject",
      "properties": { "Object": "" },
      "comment": "Your item .xob model path (optional)"
    }
  ],
  "postCreateNotes": [
    "Configure InventoryItemComponent attributes",
    "Set item size and slot type",
    "Define pickup and drop sound events"
  ]
}
EOF

cat > data/recipes/group.json << 'EOF'
{
  "id": "group",
  "name": "Group",
  "description": "AI group definitions for squads and patrols",
  "entityType": "SCR_AIGroup",
  "subdirectory": "Prefabs/Groups",
  "defaultParent": "Prefabs/Groups/PlayableGroup.et",
  "overrideComponents": [],
  "postCreateNotes": [
    "Add characters to group via child entities",
    "Configure group formation in AIFormationComponent",
    "Set group callsign in SCR_CallsignGroupComponent"
  ]
}
EOF

cat > data/recipes/spawnpoint.json << 'EOF'
{
  "id": "spawnpoint",
  "name": "Spawn Point",
  "description": "Character spawn points for respawning",
  "entityType": "GenericEntity",
  "subdirectory": "Prefabs/Systems/SpawnPoints",
  "defaultParent": "Prefabs/Systems/SpawnPoints/SpawnPosition.et",
  "overrideComponents": [],
  "postCreateNotes": [
    "Position in the world at spawn location",
    "Assign to faction in multiplayer scenarios",
    "Configure respawn properties if custom"
  ]
}
EOF

cat > data/recipes/gamemode.json << 'EOF'
{
  "id": "gamemode",
  "name": "Game Mode",
  "description": "Game mode configuration and systems",
  "entityType": "GenericEntity",
  "subdirectory": "Prefabs/Systems",
  "defaultParent": "",
  "overrideComponents": [],
  "variants": [
    {
      "name": "conflict",
      "description": "Conflict mode (Seize and Secure equivalent)",
      "postCreateNotes": [
        "Add SCR_BaseGameMode and respawn manager",
        "Configure faction managers",
        "Set up supply and reinforcement systems"
      ]
    },
    {
      "name": "coop",
      "description": "Cooperative Scenario Framework mode",
      "postCreateNotes": [
        "Add game mode and task system components",
        "Configure mission objectives",
        "Set up AI behavior and spawning"
      ]
    }
  ],
  "postCreateNotes": [
    "Configure game mode properties",
    "Set up faction and respawn systems"
  ]
}
EOF

cat > data/recipes/generic.json << 'EOF'
{
  "id": "generic",
  "name": "Generic",
  "description": "Completely custom entity (no defaults)",
  "entityType": "GenericEntity",
  "subdirectory": "Prefabs",
  "defaultParent": "",
  "overrideComponents": [],
  "postCreateNotes": [
    "Add components manually as needed"
  ]
}
EOF
```

- [ ] **Step 7: Verify all JSON files are valid**

```bash
for file in data/recipes/*.json; do
  node -e "console.log('$file OK')" && \
  cat "$file" | node -e "console.log(JSON.parse(require('fs').readFileSync(0, 'utf-8')))" > /dev/null || \
  echo "ERROR in $file"
done
```

Expected: All files report OK

- [ ] **Step 8: Commit all recipe files**

```bash
git add data/recipes/
git commit -m "data: add all prefab recipes (attachment, ground_vehicle, air_vehicle, character, prop, building, item, group, spawnpoint, gamemode, generic)

Each recipe specifies:
- Recipe ID and entity type
- Default base game parent prefab
- Override components with placeholder values
- Variants with different parents and post-creation notes
- Post-creation checklists for users

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

### Task 5: Update src/templates/prefab.ts for Recipe System

**Files:**
- Modify: `src/templates/prefab.ts`

- [ ] **Step 1: Write failing test for recipe integration**

Add to `tests/templates/prefab.test.ts`:

```typescript
describe("generatePrefab with recipes", () => {
  it("uses recipe overrideComponents when available", () => {
    const recipe: PrefabRecipe = {
      id: "test",
      name: "Test",
      description: "Test recipe",
      entityType: "GenericEntity",
      subdirectory: "Prefabs/Test",
      defaultParent: "",
      overrideComponents: [
        { type: "TestComponent", properties: { prop: "value" } }
      ],
      postCreateNotes: ["Test note"]
    };
    
    const text = generatePrefab({
      name: "TestEntity",
      prefabType: "test" as any,
      recipe: recipe
    });
    
    const node = parse(text);
    const comps = node.children.find((c) => c.type === "components");
    expect(comps!.children.find((c) => c.type === "TestComponent")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/templates/prefab.test.ts -t "recipe"`
Expected: FAIL

- [ ] **Step 3: Update PrefabOptions interface to accept recipe parameter**

In `src/templates/prefab.ts`, update the `PrefabOptions` interface:

```typescript
export interface PrefabOptions {
  /** Prefab name (used for filename and ID) */
  name: string;
  /** Prefab template type (now matches recipe IDs) */
  prefabType: string;  // Changed from PrefabType union
  /** Parent prefab path to inherit from */
  parentPrefab?: string;
  /** Additional components to add */
  components?: ComponentDef[];
  /** Description (used for m_sDisplayName if applicable) */
  description?: string;
  /** Pre-resolved ancestor components (from prefab-ancestry walkChain) */
  ancestorComponents?: ComponentDef[];
  /** Optional recipe to use instead of hardcoded defaults */
  recipe?: PrefabRecipe;
  /** Optional variant name to apply recipe overrides */
  variant?: string;
}
```

- [ ] **Step 4: Remove PREFAB_CONFIGS and add recipe import**

Replace the entire `PREFAB_CONFIGS` object and add:

```typescript
import type { PrefabRecipe } from "./recipe.js";
```

Then remove:

```typescript
export type PrefabType = "character" | "vehicle" | "weapon" | ...
```

- [ ] **Step 5: Update generatePrefab to use recipe**

Modify the `generatePrefab` function:

```typescript
export function generatePrefab(opts: PrefabOptions): string {
  // Get base components from recipe if provided, otherwise use passed components
  const baseComponents: ComponentDef[] = 
    opts.recipe?.overrideComponents ?? opts.ancestorComponents ?? [];
  
  // Rest of the function stays the same, building components from
  // baseComponents + opts.components
  const allComponents: ComponentDef[] = [
    ...baseComponents,
    ...(opts.components ?? []),
  ];

  // ... rest of implementation
}
```

- [ ] **Step 6: Remove subdirectory/filename functions or update them**

Update `getPrefabSubdirectory` to accept recipe or prefabType:

```typescript
export function getPrefabSubdirectory(recipe: PrefabRecipe | string): string {
  if (typeof recipe === "string") {
    // Fallback: return empty for unknown types
    return "Prefabs";
  }
  return recipe.subdirectory;
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm test tests/templates/prefab.test.ts -t "recipe"`
Expected: PASS

- [ ] **Step 8: Update existing tests to use new type names**

Update old tests that use deprecated type names:
- `prefabType: "weapon"` → `prefabType: "firearm"`
- `prefabType: "vehicle"` → `prefabType: "ground_vehicle"`
- `prefabType: "interactive"` → `prefabType: "prop"`

Run: `npm test tests/templates/prefab.test.ts`
Expected: All existing tests still pass

- [ ] **Step 9: Commit**

```bash
git add src/templates/prefab.ts tests/templates/prefab.test.ts
git commit -m "refactor: integrate recipe system into generatePrefab

- Remove hardcoded PREFAB_CONFIGS
- Add recipe parameter to PrefabOptions
- Update component selection to use recipe.overrideComponents
- Add variant parameter support
- Update tests to use new type names (firearm, ground_vehicle, prop, etc)

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

### Task 6: Update src/tools/prefab.ts for Recipe System and New Types

**Files:**
- Modify: `src/tools/prefab.ts`

- [ ] **Step 1: Import recipe loader and update enum**

At top of file, add:

```typescript
import { RecipeLoader } from "../templates/recipe-loader.js";
```

Update the `prefabType` enum in inputSchema:

```typescript
prefabType: z.enum([
  "firearm",
  "attachment",
  "ground_vehicle",
  "air_vehicle",
  "character",
  "prop",
  "building",
  "item",
  "group",
  "spawnpoint",
  "gamemode",
  "generic",
]).optional()
```

- [ ] **Step 2: Add variant parameter to schema**

Add after `prefabType`:

```typescript
variant: z.string().optional().describe(
  "(create) Variant name for recipe specialization (e.g., 'handgun', 'rifle')"
),
```

- [ ] **Step 3: Update creation handler to use recipes**

In the `action === "create"` block, replace the recipe lookup:

```typescript
const { name, prefabType, parentPrefab, components, description, includeAncestry, projectPath, variant } = params;

// Instantiate recipe loader (in real code, cache this at server startup)
const recipeLoader = new RecipeLoader(config.dataDir + "/recipes");
const recipe = recipeLoader.getRecipe(prefabType, variant);

if (!recipe) {
  return {
    content: [{ type: "text", text: `Error: unknown prefabType "${prefabType}" (variant: ${variant || "none"})` }],
    isError: true,
  };
}
```

- [ ] **Step 4: Update ancestry resolution**

Replace the current ancestry logic to use recipe's defaultParent:

```typescript
const effectiveParent = parentPrefab || recipe.defaultParent;
let ancestorComponents: ComponentDef[] | undefined;

if (effectiveParent && includeAncestry) {
  const { levels, warnings } = walkChain(effectiveParent, config, projectPath);
  // ... rest of ancestry merging
}
```

- [ ] **Step 5: Update generatePrefab call**

```typescript
const content = generatePrefab({
  name,
  prefabType: prefabType as string,
  parentPrefab: effectiveParent,
  components: components as ComponentDef[] | undefined,
  description,
  ancestorComponents,
  recipe,
  variant,
});
```

- [ ] **Step 6: Update response to include post-creation notes**

After building the response string, add:

```typescript
const postCreateNotes = recipe.postCreateNotes || [];
const notesText = postCreateNotes.length > 0
  ? "\n\nRequired follow-up:\n" + postCreateNotes.map((note) => `[ ] ${note}`).join("\n")
  : "";

return {
  content: [
    {
      type: "text",
      text: `Prefab created: ${subdir}/${filename}\n` +
            `Type: ${prefabType}${variant ? ` (variant: ${variant})` : ""}\n` +
            `Ancestry: ${levels.length} level(s), ${ancestorComponents?.length || 0} components` +
            notesText +
            `\n\n\`\`\`\n${content}\n\`\`\`` +
            meshWarning +
            ancestryNote,
    },
  ],
};
```

- [ ] **Step 7: Update subdirectory lookup**

```typescript
const subdir = recipe.subdirectory;
```

- [ ] **Step 8: Commit**

```bash
git add src/tools/prefab.ts
git commit -m "feat: update prefab tool to use recipe system

- Add variant parameter
- Use RecipeLoader to fetch recipes
- Update prefabType enum to new recipe IDs
- Include post-creation checklist in tool response
- Use recipe.defaultParent when no parentPrefab provided
- Update ancestry resolution to fall back to recipe parent

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

### Task 7: Run Full Test Suite and Verify

**Files:**
- No new files

- [ ] **Step 1: Run all prefab tests**

Run: `npm test tests/templates/prefab.test.ts`
Expected: All tests pass (updated and new)

- [ ] **Step 2: Run related tests (ancestry, formats)**

Run: `npm test tests/utils/prefab-ancestry.test.ts tests/formats/enfusion-text.test.ts`
Expected: All pass (no changes should affect these)

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: No new failures

- [ ] **Step 4: Build TypeScript**

Run: `npm run build`
Expected: No compilation errors

---

### Task 8: Integration Test - Create a Sample Prefab with Recipe

**Files:**
- No new files (manual test only)

- [ ] **Step 1: Create a simple test to load a recipe and generate prefab**

Add to `tests/templates/prefab.test.ts`:

```typescript
describe("Integration: Recipe + generatePrefab", () => {
  it("loads firearm recipe and generates handgun prefab", () => {
    const loader = new RecipeLoader(join(process.cwd(), "data", "recipes"));
    const recipe = loader.getRecipe("firearm", "handgun");

    expect(recipe).toBeDefined();
    expect(recipe!.defaultParent).toContain("Handgun_Base.et");

    const text = generatePrefab({
      name: "MyHandgun",
      prefabType: "firearm",
      recipe: recipe!,
      components: [
        { type: "CustomComponent", properties: { custom: "value" } }
      ]
    });

    const node = parse(text);
    expect(node.inheritance).toContain("Handgun_Base.et");
    expect(node.type).toBe("GenericEntity");
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `npm test tests/templates/prefab.test.ts -t "Integration"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/templates/prefab.test.ts
git commit -m "test: add integration test for recipe + prefab generation

Verify that recipes can be loaded, variants merged, and prefabs generated
with correct parent paths and override components.

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

## Summary

This plan implements the prefab recipe system in 8 focused tasks:

1. **Schema** — TypeScript interfaces defining recipes
2. **Loader** — JSON file loading, caching, variant merging
3. **Firearm recipe** — First recipe with 4 variants (handgun, rifle, launcher, machinegun)
4. **Other recipes** — 10 more recipe files covering all categories
5. **Prefab template** — Integrate recipes into component generation
6. **Prefab tool** — Update enum, add variant param, format checklist response
7. **Testing** — Run full test suite, verify no regressions
8. **Integration test** — Verify recipe + prefab generation flow

Each task produces a working, testable increment with frequent commits. Old type names are removed; new types match recipe IDs. Post-creation notes are included in tool responses as actionable checklists.

---

## Plan complete and saved to `docs/superpowers/plans/2026-03-31-prefab-recipe-system.md`

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**