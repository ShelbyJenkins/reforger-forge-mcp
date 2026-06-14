# Animation Editor Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deep animation graph parsing, validation, and expanded guidance for Enfusion MCP animation tools.

**Architecture:** Extract shared parser into `src/animation/parser.ts` with typed node tree representation. Both `animation-graph-inspect` and `animation-graph-setup` import from this module. Validation and suggest logic are separate modules that operate on the parsed tree.

**Tech Stack:** TypeScript, Vitest, Zod, MCP SDK

**Spec:** `docs/superpowers/specs/2026-03-22-animation-editor-improvements-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/animation/parser.ts` | Create | Shared parser: `extractBlocks`, `extractProp`, `extractStringArray` + deep AGF/AGR/AST/ASI/AW parsing into typed node tree |
| `src/animation/types.ts` | Create | TypeScript interfaces for parsed nodes, validation results, suggestions |
| `src/animation/formatter.ts` | Create | Render parsed node tree as indented text with hierarchy, summary header |
| `src/animation/validator.ts` | Create | V01-V13 validation checks operating on parsed tree |
| `src/animation/suggestions.ts` | Create | Suggest-action logic: analyze tree + AGR data, return improvement recommendations |
| `src/animation/guides.ts` | Create | Guide presets: character, weapon, prop, custom questionnaire |
| `src/tools/animation-graph-inspect.ts` | Modify | Add `action`, `agrPath`, `asiPath` params; add `.asi` support; use shared parser; wire validate action |
| `src/tools/animation-graph-setup.ts` | Modify | Add `action`, `preset`, `agrPath`, `agfPath` params; wire suggest and guide actions |
| `tests/animation/parser.test.ts` | Create | Unit tests for deep parser (all node types, edge cases) |
| `tests/animation/formatter.test.ts` | Create | Unit tests for tree rendering |
| `tests/animation/validator.test.ts` | Create | Unit tests for each validation check V01-V13 |
| `tests/animation/suggestions.test.ts` | Create | Unit tests for suggestion detection |
| `tests/animation/guides.test.ts` | Create | Unit tests for guide preset output |

---

### Task 1: Types and Parser Helpers

Extract the existing parser helpers from `animation-graph-inspect.ts` into a shared module with typed interfaces.

**Files:**
- Create: `src/animation/types.ts`
- Create: `src/animation/parser.ts`
- Create: `tests/animation/parser.test.ts`

- [ ] **Step 1: Write type interfaces**

Create `src/animation/types.ts`:

```typescript
// Parsed node from AGF
export interface ParsedNode {
  type: string;        // e.g. "AnimSrcNodeQueue", "AnimSrcNodeStateMachine"
  name: string;
  editorPos?: { x: number; y: number };
  children: string[];  // node names referenced as children
  properties: Record<string, unknown>;
  raw: string;         // raw body text for fallback extraction
}

// StateMachine-specific
export interface ParsedState {
  name: string;
  startCondition: string | null;
  timeMode: string | null;  // "Notime" | "Realtime" | "Normtime"
  exit: boolean;
  child: string | null;
}

export interface ParsedTransition {
  from: string;
  to: string;
  condition: string | null;
  duration: string | null;
  postEval: boolean;
  blendFn: string | null;
  startTime: string | null;
}

// Queue-specific
export interface ParsedQueueItem {
  child: string | null;
  startExpr: string | null;
  interruptExpr: string | null;
  blendInTime: string | null;
  blendOutTime: string | null;
  enqueueMethod: string | null;
  tagMainPath: string | null;
}

// ProcTransform bone item
export interface ParsedBoneItem {
  bone: string | null;
  op: string | null;      // "Rotate" | "Translate" | "Scale"
  axis: string | null;    // "X" | "Y" | "Z" or null (default X)
  amount: string | null;  // expression string
}

// IK binding
export interface ParsedIkBinding {
  ikTarget: string | null;
  ikChain: string | null;
}

// Switch item
export interface ParsedSwitchItem {
  child: string | null;
  nextProbabilities: string | null;
}

// AGF parse result
export interface ParsedSheet {
  name: string;
  nodes: ParsedNode[];
}

export interface ParsedAgf {
  sheets: ParsedSheet[];
}

// AGR parse result
export interface ParsedVariable {
  name: string;
  type: "Float" | "Int" | "Bool";
  min: string | null;
  max: string | null;
  defaultValue: string | null;
}

export interface ParsedCommand {
  name: string;
}

export interface ParsedIkChain {
  name: string;
  joints: string[];
  middleJoint: string | null;
  chainAxis: string | null;
}

export interface ParsedBoneMask {
  name: string;
  bones: string[];
}

export interface ParsedAgr {
  variables: ParsedVariable[];
  commands: ParsedCommand[];
  ikChains: ParsedIkChain[];
  boneMasks: ParsedBoneMask[];
  globalTags: string[];
  defaultRunNode: string | null;
  agfReferences: string[];
  astReference: string | null;
}

// AST parse result
export interface ParsedAnimGroup {
  name: string;
  animationNames: string[];
  columnNames: string[];
}

export interface ParsedAst {
  groups: ParsedAnimGroup[];
}

// ASI parse result
export interface ParsedAsiMapping {
  group: string;
  column: string;
  animation: string;
  anmPath: string | null;  // null = unmapped
}

export interface ParsedAsi {
  mappings: ParsedAsiMapping[];
}

// AW parse result
export interface ParsedAw {
  animGraph: string | null;
  animSetTemplate: string | null;
  animSetInstances: string[];
  previewModels: string[];
  childPreviewModels: Array<{ model: string; bone: string; enabled: boolean }>;
}

// Validation
export interface ValidationIssue {
  id: string;      // "V01", "V02", etc.
  severity: "error" | "warning";
  message: string;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  errorCount: number;
  warningCount: number;
}

// Suggestion
export interface Suggestion {
  category: string;
  title: string;
  description: string;
  snippet: string;
}
```

- [ ] **Step 2: Write failing tests for parser helpers**

Create `tests/animation/parser.test.ts` with tests for `extractBlocks`, `extractProp`, `extractStringArray`:

```typescript
import { describe, it, expect } from "vitest";
import { extractBlocks, extractProp, extractStringArray } from "../../src/animation/parser.js";

describe("extractBlocks", () => {
  it("extracts named blocks with nested braces", () => {
    const text = `AnimSrcNodeQueue MasterQueue {
 Child "Foo"
 Inner {
  Nested 1
 }
}`;
    const blocks = extractBlocks(text, "AnimSrcNodeQueue");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe("MasterQueue");
    expect(blocks[0].body).toContain('Child "Foo"');
    expect(blocks[0].body).toContain("Nested 1");
  });

  it("extracts quoted names", () => {
    const text = `AnimSrcGCTVarFloat "My Variable" {
 DefaultValue 1.0
}`;
    const blocks = extractBlocks(text, "AnimSrcGCTVarFloat");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe("My Variable");
  });

  it("returns empty for no matches", () => {
    const blocks = extractBlocks("no match here", "AnimSrcNodeQueue");
    expect(blocks).toHaveLength(0);
  });
});

describe("extractProp", () => {
  it("extracts unquoted value", () => {
    expect(extractProp(" DefaultValue 2.094\n MaxValue 10", "DefaultValue")).toBe("2.094");
  });

  it("extracts quoted value", () => {
    expect(extractProp(' Source "Locomotion.Erc.Idle"', "Source")).toBe("Locomotion.Erc.Idle");
  });

  it("returns null for missing prop", () => {
    expect(extractProp("Child Foo", "Missing")).toBeNull();
  });
});

describe("extractStringArray", () => {
  it("extracts quoted strings from block", () => {
    const body = `GlobalTags {
 "Vehicle"
 "Wheeled"
}`;
    const result = extractStringArray(body, "GlobalTags");
    expect(result).toEqual(["Vehicle", "Wheeled"]);
  });

  it("returns empty for missing block", () => {
    expect(extractStringArray("no array", "Tags")).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/animation/parser.test.ts`
Expected: FAIL — module `../../src/animation/parser.js` does not exist

- [ ] **Step 4: Create parser.ts with extracted helpers**

Create `src/animation/parser.ts` — move `extractBlocks`, `extractProp`, `extractStringArray`, and `escapeRegExp` from `src/tools/animation-graph-inspect.ts` into this module and export them:

```typescript
// ── Regex helper ─────────────────────────────────────────────────────────────

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Block extraction ─────────────────────────────────────────────────────────

export function extractBlocks(
  text: string,
  typeName: string
): Array<{ name: string; body: string }> {
  const results: Array<{ name: string; body: string }> = [];
  const openRe = new RegExp(
    `^[ \\t]*${escapeRegExp(typeName)}[ \\t]+"?([^"\\s{][^{]*?)"?[ \\t]*\\{[ \\t]*$`,
    "gm"
  );

  let match: RegExpExecArray | null;
  while ((match = openRe.exec(text)) !== null) {
    const name = match[1].trim().replace(/^"|"$/g, "");
    const openBrace = text.indexOf("{", match.index + match[0].indexOf("{"));
    let depth = 1;
    let i = openBrace + 1;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      i++;
    }
    const body = text.slice(openBrace + 1, i - 1);
    results.push({ name, body });
  }
  return results;
}

// ── Property extraction ──────────────────────────────────────────────────────

export function extractProp(body: string, propName: string): string | null {
  const re = new RegExp(
    `^[ \\t]*${escapeRegExp(propName)}[ \\t]+"?([^"\\n\\r]+?)"?[ \\t]*$`,
    "m"
  );
  const m = body.match(re);
  if (!m) return null;
  return m[1].trim().replace(/^"|"$/g, "");
}

// ── String array extraction ──────────────────────────────────────────────────

export function extractStringArray(body: string, propName: string): string[] {
  const startRe = new RegExp(
    `^[ \\t]*${escapeRegExp(propName)}[ \\t]*\\{`,
    "m"
  );
  const startMatch = body.match(startRe);
  if (!startMatch || startMatch.index === undefined) return [];

  const openPos = body.indexOf("{", startMatch.index + startMatch[0].lastIndexOf("{") - 1);
  let depth = 1;
  let i = openPos + 1;
  while (i < body.length && depth > 0) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") depth--;
    i++;
  }
  const inner = body.slice(openPos + 1, i - 1);
  const items: string[] = [];
  const itemRe = /"([^"\n\r]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(inner)) !== null) {
    items.push(m[1]);
  }
  return items;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/animation/parser.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 6: Commit**

```bash
git add src/animation/types.ts src/animation/parser.ts tests/animation/parser.test.ts
git commit -m "feat(animation): extract shared types and parser helpers"
```

---

### Task 2: AGR Parser

Move and enhance the AGR parser to produce a typed `ParsedAgr` result.

**Files:**
- Modify: `src/animation/parser.ts`
- Create: `tests/animation/parser-agr.test.ts`

- [ ] **Step 1: Write failing tests for AGR parsing**

Create `tests/animation/parser-agr.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseAgrToStruct } from "../../src/animation/parser.js";
import type { ParsedAgr } from "../../src/animation/types.js";

const SAMPLE_AGR = `AnimSrcGraph {
 AnimSetTemplate "{ABC123}path/to/file.ast"
 ControlTemplate AnimSrcGCT "{DEF456}" {
  Variables {
   AnimSrcGCTVarFloat Speed {
    MinValue 0
    MaxValue 30
    DefaultValue 0
   }
   AnimSrcGCTVarBool IsActive {
   }
   AnimSrcGCTVarInt GearIndex {
    MaxValue 6
   }
  }
  Commands {
   AnimSrcGCTCmd CMD_GetIn {
   }
   AnimSrcGCTCmd CMD_GetOut {
   }
  }
  IkChains {
   AnimSrcGCTIkChain LeftLeg {
    Joints {
     "thigh_l"
     "calf_l"
     "foot_l"
    }
    MiddleJoint "calf_l"
    ChainAxis "+y"
   }
  }
  BoneMasks {
   AnimSrcGCTBoneMask UpperBody {
    BoneNames {
     "spine_01"
     "spine_02"
    }
   }
  }
 }
 GlobalTags {
  "Vehicle"
  "Wheeled"
 }
 GraphFilesResourceNames {
  "{GHI789}path/to/file.agf"
 }
 DefaultRunNode "MasterQueue"
}`;

describe("parseAgrToStruct", () => {
  it("parses variables by type", () => {
    const result = parseAgrToStruct(SAMPLE_AGR);
    expect(result.variables).toHaveLength(3);
    const speed = result.variables.find(v => v.name === "Speed");
    expect(speed).toBeDefined();
    expect(speed!.type).toBe("Float");
    expect(speed!.min).toBe("0");
    expect(speed!.max).toBe("30");
    expect(speed!.defaultValue).toBe("0");
  });

  it("parses bool and int variables", () => {
    const result = parseAgrToStruct(SAMPLE_AGR);
    const isActive = result.variables.find(v => v.name === "IsActive");
    expect(isActive!.type).toBe("Bool");
    const gear = result.variables.find(v => v.name === "GearIndex");
    expect(gear!.type).toBe("Int");
    expect(gear!.max).toBe("6");
  });

  it("parses commands", () => {
    const result = parseAgrToStruct(SAMPLE_AGR);
    expect(result.commands).toHaveLength(2);
    expect(result.commands.map(c => c.name)).toContain("CMD_GetIn");
  });

  it("parses IK chains with joints", () => {
    const result = parseAgrToStruct(SAMPLE_AGR);
    expect(result.ikChains).toHaveLength(1);
    expect(result.ikChains[0].name).toBe("LeftLeg");
    expect(result.ikChains[0].joints).toEqual(["thigh_l", "calf_l", "foot_l"]);
    expect(result.ikChains[0].middleJoint).toBe("calf_l");
    expect(result.ikChains[0].chainAxis).toBe("+y");
  });

  it("parses bone masks", () => {
    const result = parseAgrToStruct(SAMPLE_AGR);
    expect(result.boneMasks).toHaveLength(1);
    expect(result.boneMasks[0].name).toBe("UpperBody");
    expect(result.boneMasks[0].bones).toEqual(["spine_01", "spine_02"]);
  });

  it("parses global tags", () => {
    const result = parseAgrToStruct(SAMPLE_AGR);
    expect(result.globalTags).toEqual(["Vehicle", "Wheeled"]);
  });

  it("parses DefaultRunNode and AGF references", () => {
    const result = parseAgrToStruct(SAMPLE_AGR);
    expect(result.defaultRunNode).toBe("MasterQueue");
    expect(result.agfReferences).toHaveLength(1);
    expect(result.agfReferences[0]).toContain("path/to/file.agf");
  });

  it("parses AST reference", () => {
    const result = parseAgrToStruct(SAMPLE_AGR);
    expect(result.astReference).toContain("path/to/file.ast");
  });

  it("handles empty AGR gracefully", () => {
    const result = parseAgrToStruct("AnimSrcGraph {\n}");
    expect(result.variables).toHaveLength(0);
    expect(result.commands).toHaveLength(0);
    expect(result.defaultRunNode).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/animation/parser-agr.test.ts`
Expected: FAIL — `parseAgrToStruct` not exported

- [ ] **Step 3: Implement parseAgrToStruct**

Add to `src/animation/parser.ts`:

```typescript
import type { ParsedAgr, ParsedVariable, ParsedCommand, ParsedIkChain, ParsedBoneMask } from "./types.js";

export function parseAgrToStruct(content: string): ParsedAgr {
  const varTypes: Array<{ typeName: string; label: "Float" | "Int" | "Bool" }> = [
    { typeName: "AnimSrcGCTVarFloat", label: "Float" },
    { typeName: "AnimSrcGCTVarInt", label: "Int" },
    { typeName: "AnimSrcGCTVarBool", label: "Bool" },
  ];

  const variables: ParsedVariable[] = [];
  for (const { typeName, label } of varTypes) {
    for (const { name, body } of extractBlocks(content, typeName)) {
      variables.push({
        name,
        type: label,
        min: extractProp(body, "MinValue") ?? extractProp(body, "Min"),
        max: extractProp(body, "MaxValue") ?? extractProp(body, "Max"),
        defaultValue: extractProp(body, "DefaultValue") ?? extractProp(body, "Default"),
      });
    }
  }

  const commands: ParsedCommand[] = extractBlocks(content, "AnimSrcGCTCmd").map(b => ({ name: b.name }));

  const ikChains: ParsedIkChain[] = extractBlocks(content, "AnimSrcGCTIkChain").map(({ name, body }) => ({
    name,
    joints: extractStringArray(body, "Joints"),
    middleJoint: extractProp(body, "MiddleJoint"),
    chainAxis: extractProp(body, "ChainAxis"),
  }));

  const boneMasks: ParsedBoneMask[] = extractBlocks(content, "AnimSrcGCTBoneMask").map(({ name, body }) => ({
    name,
    bones: extractStringArray(body, "BoneNames"),
  }));

  const globalTags = extractStringArray(content, "GlobalTags");
  const defaultRunNode = extractProp(content, "DefaultRunNode");
  const agfReferences = extractStringArray(content, "GraphFilesResourceNames");
  const astReference = extractProp(content, "AnimSetTemplate");

  return { variables, commands, ikChains, boneMasks, globalTags, defaultRunNode, agfReferences, astReference };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/animation/parser-agr.test.ts`
Expected: PASS (all 9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/animation/parser.ts tests/animation/parser-agr.test.ts
git commit -m "feat(animation): structured AGR parser"
```

---

### Task 3: Deep AGF Parser

Parse AGF files into typed node tree with all node-specific properties.

**Files:**
- Modify: `src/animation/parser.ts`
- Create: `tests/animation/parser-agf.test.ts`

- [ ] **Step 1: Write failing tests for core AGF node parsing**

Create `tests/animation/parser-agf.test.ts` with tests for Queue, StateMachine, Source, ProcTransform, Blend nodes, and generic fallback:

```typescript
import { describe, it, expect } from "vitest";
import { parseAgfToStruct } from "../../src/animation/parser.js";

const SAMPLE_AGF = `AnimSrcGraphFile {
 Sheets {
  AnimSrcGraphSheet MainSheet {
   Nodes {
    AnimSrcNodeQueue MasterQueue {
     EditorPos 0 0
     Child "LocoSM"
     AnimSrcNodeQueueItem {
      Child "ReloadAction"
      StartExpr "IsCommand(CMD_Reload)"
      InterruptExpr "IsCommand(CMD_Cancel)"
      BlendInTime 0.2
      BlendOutTime 0.3
      EnqueueMethod Replace
     }
    }
    AnimSrcNodeStateMachine LocoSM {
     EditorPos 2 0
     AnimSrcNodeState Idle {
      StartCondition "Speed == 0"
      Time Normtime
      Child "IdleSrc"
     }
     AnimSrcNodeState Walk {
      StartCondition "Speed > 0"
      Time Realtime
      Child "WalkBlend"
     }
     AnimSrcNodeState Fallback {
      StartCondition "1"
      Time Notime
      Child "FallbackSM"
     }
     AnimSrcNodeTransition {
      From "Idle"
      To "Walk"
      Condition "Speed > 0.1"
      Duration 0.3
      PostEval 1
      BlendFn S
     }
    }
    AnimSrcNodeSource IdleSrc {
     EditorPos 4 0
     Source "Locomotion.Erc.Idle"
    }
    AnimSrcNodeProcTransform Spin {
     EditorPos 6 0
     Child "BindPose"
     Expression "1"
     Bones {
      AnimSrcNodeProcTrBoneItem "{A1B2}" {
       Bone "wheel_fl"
       Op Rotate
       Axis Y
       Amount "GetUpperRTime() * RotationSpeed"
      }
      AnimSrcNodeProcTrBoneItem "{C3D4}" {
       Bone "wheel_fr"
       Op Rotate
       Amount "GetUpperRTime() * 2.094"
      }
     }
    }
    AnimSrcNodeBlend AimBlend {
     EditorPos 8 0
     Child0 "BasePose"
     Child1 "AimPose"
     BlendWeight "AimWeight"
     Optimization 1
    }
    AnimSrcNodeBindPose BindPose {
     EditorPos 10 0
    }
    AnimSrcNodeUnknownFuture CustomNode {
     EditorPos 12 0
     Child "BindPose"
     SomeCustomProp 42
    }
   }
  }
 }
}`;

describe("parseAgfToStruct", () => {
  const result = parseAgfToStruct(SAMPLE_AGF);

  it("parses sheets and node count", () => {
    expect(result.sheets).toHaveLength(1);
    expect(result.sheets[0].name).toBe("MainSheet");
    expect(result.sheets[0].nodes.length).toBeGreaterThanOrEqual(7);
  });

  it("parses Queue with child and queue items", () => {
    const queue = result.sheets[0].nodes.find(n => n.name === "MasterQueue")!;
    expect(queue.type).toBe("AnimSrcNodeQueue");
    expect(queue.children).toContain("LocoSM");
    const items = queue.properties.queueItems as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].child).toBe("ReloadAction");
    expect(items[0].startExpr).toBe("IsCommand(CMD_Reload)");
    expect(items[0].interruptExpr).toBe("IsCommand(CMD_Cancel)");
    expect(items[0].enqueueMethod).toBe("Replace");
  });

  it("parses StateMachine with states and transitions", () => {
    const sm = result.sheets[0].nodes.find(n => n.name === "LocoSM")!;
    expect(sm.type).toBe("AnimSrcNodeStateMachine");
    const states = sm.properties.states as Array<Record<string, unknown>>;
    expect(states).toHaveLength(3);
    expect(states[0].name).toBe("Idle");
    expect(states[0].startCondition).toBe("Speed == 0");
    expect(states[0].timeMode).toBe("Normtime");
    expect(states[2].startCondition).toBe("1");

    const transitions = sm.properties.transitions as Array<Record<string, unknown>>;
    expect(transitions).toHaveLength(1);
    expect(transitions[0].from).toBe("Idle");
    expect(transitions[0].to).toBe("Walk");
    expect(transitions[0].condition).toBe("Speed > 0.1");
    expect(transitions[0].duration).toBe("0.3");
    expect(transitions[0].postEval).toBe(true);
    expect(transitions[0].blendFn).toBe("S");

    // States add children
    expect(sm.children).toContain("IdleSrc");
    expect(sm.children).toContain("WalkBlend");
    expect(sm.children).toContain("FallbackSM");
  });

  it("parses Source with animation reference", () => {
    const src = result.sheets[0].nodes.find(n => n.name === "IdleSrc")!;
    expect(src.type).toBe("AnimSrcNodeSource");
    expect(src.properties.source).toBe("Locomotion.Erc.Idle");
  });

  it("parses ProcTransform with bone items", () => {
    const pt = result.sheets[0].nodes.find(n => n.name === "Spin")!;
    expect(pt.type).toBe("AnimSrcNodeProcTransform");
    expect(pt.children).toContain("BindPose");
    expect(pt.properties.expression).toBe("1");
    const bones = pt.properties.boneItems as Array<Record<string, unknown>>;
    expect(bones).toHaveLength(2);
    expect(bones[0].bone).toBe("wheel_fl");
    expect(bones[0].op).toBe("Rotate");
    expect(bones[0].axis).toBe("Y");
    expect(bones[0].amount).toBe("GetUpperRTime() * RotationSpeed");
    expect(bones[1].axis).toBeNull(); // no Axis = default X
  });

  it("parses Blend with weights and optimization", () => {
    const blend = result.sheets[0].nodes.find(n => n.name === "AimBlend")!;
    expect(blend.type).toBe("AnimSrcNodeBlend");
    expect(blend.children).toContain("BasePose");
    expect(blend.children).toContain("AimPose");
    expect(blend.properties.blendWeight).toBe("AimWeight");
    expect(blend.properties.optimization).toBe(true);
  });

  it("handles unknown node types with generic extraction", () => {
    const unknown = result.sheets[0].nodes.find(n => n.name === "CustomNode")!;
    expect(unknown.type).toBe("AnimSrcNodeUnknownFuture");
    expect(unknown.children).toContain("BindPose");
  });

  it("handles empty AGF gracefully", () => {
    const empty = parseAgfToStruct("AnimSrcGraphFile {\n Sheets {\n }\n}");
    expect(empty.sheets).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/animation/parser-agf.test.ts`
Expected: FAIL — `parseAgfToStruct` not exported

- [ ] **Step 3: Implement parseAgfToStruct**

Add to `src/animation/parser.ts`. The function:
1. Extracts `AnimSrcGraphSheet` blocks
2. Within each sheet, finds all `AnimSrcNode*` blocks using the existing regex pattern
3. For each node, dispatches to type-specific property extraction:
   - `AnimSrcNodeQueue`: extract `Child`, find `AnimSrcNodeQueueItem` sub-blocks
   - `AnimSrcNodeStateMachine`: find `AnimSrcNodeState` and `AnimSrcNodeTransition` sub-blocks
   - `AnimSrcNodeSource`: extract `Source` property
   - `AnimSrcNodeProcTransform`: extract `Expression`, `Child`, find `AnimSrcNodeProcTrBoneItem` sub-blocks
   - `AnimSrcNodeBlend`: extract `Child0`, `Child1`, `BlendWeight`, `Optimization` (parse "1"→true)
   - `AnimSrcNodeBlendN`: extract `BlendWeight`, `Thresholds`, `IsCyclic`, find children
   - `AnimSrcNodeBlendT`/`BlendTAdd`/`BlendTW`: extract respective properties per spec
   - `AnimSrcNodeIK2`/`IK2Target`/`IK2Plane`/`IKLock`/`IKRotation`: extract `Weight`, `Chains` bindings, solver
   - `AnimSrcNodeSwitch`: extract `FirstProbabilities`, find `AnimSrcNodeSwitchItem` sub-blocks
   - `AnimSrcNodeFilter`/`BufferSave`/`BufferUse`: extract mask/buffer names
   - `AnimSrcNodeFunctionBegin`/`FunctionCall`/`FunctionEnd`: extract method/index
   - `AnimSrcNodeGroupSelect`: extract `Group`, `Column`
   - All other `AnimSrcNode*`: generic extraction (name, Child only)
4. Collects all children references into the `children` array
5. Returns `ParsedAgf` with sheets and nodes

Implementation is ~300 lines. Each node type handler is a small function that calls `extractProp`/`extractBlocks` on the node body.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/animation/parser-agf.test.ts`
Expected: PASS (all 8 tests)

- [ ] **Step 5: Add tests for remaining node types**

Add to `tests/animation/parser-agf.test.ts`: BlendN (thresholds, IsCyclic), BlendT (TriggerOn/Off, BlendTime, PostEval), IK2 (Weight, Chains, Solver), Switch (probabilities), Filter (BoneMask, Condition), FunctionCall (Method, Child0-Child7), GroupSelect (Group, Column), TimeSave/TimeScale/TimeUse, VarSet/VarReset.

- [ ] **Step 6: Implement remaining node type handlers and make tests pass**

Run: `npx vitest run tests/animation/parser-agf.test.ts`
Expected: PASS (all tests)

- [ ] **Step 7: Commit**

```bash
git add src/animation/parser.ts tests/animation/parser-agf.test.ts
git commit -m "feat(animation): deep AGF parser with all node types"
```

---

### Task 4: AST and ASI Parsers

Add structured parsing for AST and ASI files.

**Files:**
- Modify: `src/animation/parser.ts`
- Create: `tests/animation/parser-ast-asi.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/animation/parser-ast-asi.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseAstToStruct, parseAsiToStruct } from "../../src/animation/parser.js";

const SAMPLE_AST = `AnimSetTemplate {
 AnimSetTemplateSource_AnimationGroup Locomotion {
  AnimationNames {
   "Idle"
   "WalkF"
   "WalkB"
  }
  ColumnNames {
   "Erc"
   "Cro"
  }
 }
 AnimSetTemplateSource_AnimationGroup Actions {
  AnimationNames {
   "Reload"
  }
  ColumnNames {
   "Default"
  }
 }
}`;

const SAMPLE_ASI = `AnimSetInstance {
 AnimSetInstanceSource_AnimationGroup Locomotion {
  AnimationNames {
   "Idle"
   "WalkF"
   "WalkB"
  }
  ColumnInstances {
   AnimSetInstanceColumn Erc {
    Animations {
     "{G1}Anims/idle_erc.anm"
     "{G2}Anims/walk_fwd_erc.anm"
     ""
    }
   }
  }
 }
}`;

describe("parseAstToStruct", () => {
  it("parses animation groups with names and columns", () => {
    const result = parseAstToStruct(SAMPLE_AST);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0].name).toBe("Locomotion");
    expect(result.groups[0].animationNames).toEqual(["Idle", "WalkF", "WalkB"]);
    expect(result.groups[0].columnNames).toEqual(["Erc", "Cro"]);
  });
});

describe("parseAsiToStruct", () => {
  it("parses animation mappings from column instances", () => {
    const result = parseAsiToStruct(SAMPLE_ASI);
    expect(result.mappings.length).toBeGreaterThanOrEqual(2);
    const idleMapping = result.mappings.find(
      m => m.group === "Locomotion" && m.column === "Erc" && m.animation === "Idle"
    );
    expect(idleMapping).toBeDefined();
    expect(idleMapping!.anmPath).toContain("idle_erc.anm");
  });

  it("marks empty slots as unmapped", () => {
    const result = parseAsiToStruct(SAMPLE_ASI);
    const walkB = result.mappings.find(
      m => m.group === "Locomotion" && m.column === "Erc" && m.animation === "WalkB"
    );
    expect(walkB).toBeDefined();
    expect(walkB!.anmPath).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/animation/parser-ast-asi.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement parseAstToStruct and parseAsiToStruct**

Add to `src/animation/parser.ts`:

```typescript
import type { ParsedAst, ParsedAsi, ParsedAsiMapping, ParsedAnimGroup } from "./types.js";

export function parseAstToStruct(content: string): ParsedAst {
  const groups: ParsedAnimGroup[] = extractBlocks(content, "AnimSetTemplateSource_AnimationGroup")
    .map(({ name, body }) => ({
      name,
      animationNames: extractStringArray(body, "AnimationNames"),
      columnNames: extractStringArray(body, "ColumnNames"),
    }));
  return { groups };
}

export function parseAsiToStruct(content: string): ParsedAsi {
  const mappings: ParsedAsiMapping[] = [];
  const groups = extractBlocks(content, "AnimSetInstanceSource_AnimationGroup");

  for (const { name: groupName, body: groupBody } of groups) {
    const animNames = extractStringArray(groupBody, "AnimationNames");
    const columns = extractBlocks(groupBody, "AnimSetInstanceColumn");

    for (const { name: colName, body: colBody } of columns) {
      // Extract animation file paths from the Animations block
      // Each line is either a "{GUID}path/to/file.anm" or "" (empty = unmapped)
      const animPaths = extractStringArray(colBody, "Animations");

      for (let i = 0; i < animNames.length; i++) {
        const rawPath = i < animPaths.length ? animPaths[i] : "";
        // Strip GUID prefix if present
        const anmPath = rawPath === "" ? null : rawPath.replace(/^\{[^}]*\}/, "");
        mappings.push({
          group: groupName,
          column: colName,
          animation: animNames[i],
          anmPath,
        });
      }
    }
  }

  return { mappings };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/animation/parser-ast-asi.test.ts`
Expected: PASS

- [ ] **Step 5: Add AW struct parser**

Add `parseAwToStruct` to `src/animation/parser.ts`:

```typescript
import type { ParsedAw } from "./types.js";

export function parseAwToStruct(content: string): ParsedAw {
  const animGraph = extractProp(content, "AnimGraph");
  const animSetTemplate = extractProp(content, "AnimSetTemplate");
  const animSetInstances = extractStringArray(content, "AnimSetInstances");

  const previewModels: string[] = [];
  for (const { body } of extractBlocks(content, "AnimSrcWorkspacePreviewModel")) {
    const model = extractProp(body, "Model");
    if (model) previewModels.push(model);
  }

  const childPreviewModels: Array<{ model: string; bone: string; enabled: boolean }> = [];
  for (const { body } of extractBlocks(content, "AnimSrcWorkspaceChildPreviewModel")) {
    childPreviewModels.push({
      model: extractProp(body, "Model") ?? "(unknown)",
      bone: extractProp(body, "Bone") ?? "(no bone)",
      enabled: extractProp(body, "Enabled") !== "0",
    });
  }

  return { animGraph, animSetTemplate, animSetInstances, previewModels, childPreviewModels };
}
```

- [ ] **Step 6: Commit**

```bash
git add src/animation/parser.ts tests/animation/parser-ast-asi.test.ts
git commit -m "feat(animation): AST, ASI, and AW structured parsers"
```

---

### Task 5: Tree Formatter

Render parsed AGF as indented hierarchy with summary header.

**Files:**
- Create: `src/animation/formatter.ts`
- Create: `tests/animation/formatter.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/animation/formatter.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { formatAgfTree, formatAgrSummary, formatAstSummary, formatAsiSummary } from "../../src/animation/formatter.js";
import type { ParsedAgf, ParsedAgr, ParsedAst, ParsedAsi } from "../../src/animation/types.js";

describe("formatAgfTree", () => {
  it("renders summary header with node counts", () => {
    const agf: ParsedAgf = {
      sheets: [{
        name: "Main",
        nodes: [
          { type: "AnimSrcNodeQueue", name: "MQ", children: ["Child1"], properties: { queueItems: [] }, editorPos: { x: 0, y: 0 }, raw: "" },
          { type: "AnimSrcNodeBindPose", name: "Child1", children: [], properties: {}, editorPos: { x: 2, y: 0 }, raw: "" },
        ],
      }],
    };
    const output = formatAgfTree(agf);
    expect(output).toContain("Sheets: 1");
    expect(output).toContain("Nodes: 2");
    expect(output).toContain("1 Queue");
    expect(output).toContain("1 BindPose");
  });

  it("renders parent-child tree with indentation", () => {
    const agf: ParsedAgf = {
      sheets: [{
        name: "Main",
        nodes: [
          { type: "AnimSrcNodeQueue", name: "Root", children: ["Mid"], properties: { queueItems: [] }, editorPos: { x: 0, y: 0 }, raw: "" },
          { type: "AnimSrcNodeBlend", name: "Mid", children: ["Leaf"], properties: { blendWeight: "0.5" }, editorPos: { x: 2, y: 0 }, raw: "" },
          { type: "AnimSrcNodeBindPose", name: "Leaf", children: [], properties: {}, editorPos: { x: 4, y: 0 }, raw: "" },
        ],
      }],
    };
    const output = formatAgfTree(agf);
    expect(output).toContain('Queue "Root"');
    expect(output).toContain('Blend "Mid"');
    expect(output).toContain('BindPose "Leaf"');
  });

  it("marks cross-references with (see above)", () => {
    const agf: ParsedAgf = {
      sheets: [{
        name: "Main",
        nodes: [
          { type: "AnimSrcNodeQueue", name: "Root", children: ["Shared"], properties: { queueItems: [] }, editorPos: { x: 0, y: 0 }, raw: "" },
          { type: "AnimSrcNodeBlend", name: "Blend1", children: ["Shared"], properties: {}, editorPos: { x: 2, y: 0 }, raw: "" },
          { type: "AnimSrcNodeBindPose", name: "Shared", children: [], properties: {}, editorPos: { x: 4, y: 0 }, raw: "" },
        ],
      }],
    };
    const output = formatAgfTree(agf);
    expect(output).toContain("(see above)");
  });

  it("shows StateMachine states and transitions", () => {
    const agf: ParsedAgf = {
      sheets: [{
        name: "Main",
        nodes: [
          {
            type: "AnimSrcNodeStateMachine", name: "SM", children: ["IdleSrc"],
            properties: {
              states: [{ name: "Idle", startCondition: "Speed == 0", timeMode: "Normtime", exit: false, child: "IdleSrc" }],
              transitions: [{ from: "Idle", to: "Walk", condition: "Speed > 0", duration: "0.3", postEval: true, blendFn: "S", startTime: null }],
            },
            editorPos: { x: 0, y: 0 }, raw: "",
          },
          { type: "AnimSrcNodeSource", name: "IdleSrc", children: [], properties: { source: "Loco.Erc.Idle" }, editorPos: { x: 2, y: 0 }, raw: "" },
        ],
      }],
    };
    const output = formatAgfTree(agf);
    expect(output).toContain('State "Idle"');
    expect(output).toContain("StartCondition");
    expect(output).toContain("Speed == 0");
    expect(output).toContain("Transition");
    expect(output).toContain("Speed > 0");
    expect(output).toContain("Duration: 0.3");
  });

  it("handles empty AGF", () => {
    const output = formatAgfTree({ sheets: [] });
    expect(output).toContain("Sheets: 0");
    expect(output).toContain("Nodes: 0");
  });
});

describe("formatAgrSummary", () => {
  it("renders variables, commands, IK chains, bone masks", () => {
    const agr: ParsedAgr = {
      variables: [{ name: "Speed", type: "Float", min: "0", max: "30", defaultValue: "0" }],
      commands: [{ name: "CMD_Fire" }],
      ikChains: [{ name: "LeftLeg", joints: ["a", "b"], middleJoint: "b", chainAxis: "+y" }],
      boneMasks: [{ name: "Upper", bones: ["spine"] }],
      globalTags: ["Vehicle"],
      defaultRunNode: "MQ",
      agfReferences: ["path.agf"],
      astReference: "path.ast",
    };
    const output = formatAgrSummary(agr);
    expect(output).toContain("Speed");
    expect(output).toContain("Float");
    expect(output).toContain("CMD_Fire");
    expect(output).toContain("LeftLeg");
    expect(output).toContain("Vehicle");
    expect(output).toContain("MQ");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/animation/formatter.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement formatters**

Create `src/animation/formatter.ts`:

The `formatAgfTree` function:
1. Computes node count summary by stripping "AnimSrcNode" prefix and counting per short type name
2. For each sheet, identifies root nodes (nodes not referenced as children by any other node)
3. Recursively renders tree from each root, tracking visited nodes for cross-reference detection and cycle prevention
4. Per node type, appends relevant properties inline:
   - Source: `-> "group.column.anim"`
   - StateMachine: indented state list with StartCondition and transitions
   - ProcTransform: bone items with Op/Axis/Amount
   - Blend: weight value
   - BlendN: weight and threshold range
   - Queue: queue items summary
5. Uses box-drawing characters for tree lines

Also implement `formatAgrSummary` (mirrors current `parseAgr` output format but using the struct), `formatAstSummary`, `formatAsiSummary`, and `formatAwSummary`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/animation/formatter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/animation/formatter.ts tests/animation/formatter.test.ts
git commit -m "feat(animation): tree formatter with hierarchy rendering"
```

---

### Task 6: Wire Inspect Tool to Shared Parser

Replace inline parsers in `animation-graph-inspect.ts` with shared module. Add `.asi` support and `action`/`agrPath`/`asiPath` parameters.

**Files:**
- Modify: `src/tools/animation-graph-inspect.ts`

- [ ] **Step 1: Read current animation-graph-inspect.ts fully**

Read `src/tools/animation-graph-inspect.ts` to understand the full current structure before modifying.

- [ ] **Step 2: Replace inline helpers with shared imports**

Remove the local `extractBlocks`, `extractProp`, `extractStringArray`, `escapeRegExp`, `parseAgr`, `parseAgf`, `parseAst`, `parseAw` functions. Replace with:

```typescript
import {
  parseAgrToStruct, parseAgfToStruct, parseAstToStruct,
  parseAsiToStruct, parseAwToStruct,
} from "../animation/parser.js";
import {
  formatAgrSummary, formatAgfTree, formatAstSummary,
  formatAsiSummary, formatAwSummary,
} from "../animation/formatter.js";
```

- [ ] **Step 3: Add new parameters to the tool schema**

Update the `inputSchema` to add:
```typescript
action: z.enum(["inspect", "validate"]).default("inspect")
  .describe("Action: inspect (default) returns structured summary; validate runs pitfall checks"),
agrPath: z.string().optional()
  .describe("AGR file path for cross-reference during validate. Same source/projectPath resolution as path."),
asiPath: z.string().optional()
  .describe("ASI file path for cross-reference during validate. Same source/projectPath resolution as path."),
```

Add `.asi` to the supported extensions check.

- [ ] **Step 4: Update the handler to use parsed structs**

For `action === "inspect"`:
- Parse the file to struct (based on extension)
- Format using the corresponding formatter
- Return formatted text

For `action === "validate"`:
- Import and call `validateGraph` from `../animation/validator.js` (implemented in Task 7)
- Read AGR if `agrPath` provided, parse to struct
- Read ASI if `asiPath` provided, parse to struct
- Return validation report

- [ ] **Step 5: Run existing tests and verify no regression**

Run: `npx vitest run`
Expected: All existing tests pass. The inspect tool should produce equivalent output to before.

- [ ] **Step 6: Commit**

```bash
git add src/tools/animation-graph-inspect.ts
git commit -m "refactor(animation): wire inspect tool to shared parser and formatter"
```

---

### Task 7: Validator

Implement V01-V13 validation checks.

**Files:**
- Create: `src/animation/validator.ts`
- Create: `tests/animation/validator.test.ts`

- [ ] **Step 1: Write failing tests for each validation check**

Create `tests/animation/validator.test.ts` with one test per check. Each test constructs a minimal `ParsedAgf` / `ParsedAgr` with the specific problem and asserts the correct issue is reported:

```typescript
import { describe, it, expect } from "vitest";
import { validateGraph } from "../../src/animation/validator.js";
import type { ParsedAgf, ParsedAgr, ParsedAsi } from "../../src/animation/types.js";

// Helper to make a minimal AGF with one StateMachine
function makeAgf(nodes: Array<Record<string, unknown>>): ParsedAgf {
  return {
    sheets: [{
      name: "Main",
      nodes: nodes.map(n => ({
        type: n.type as string,
        name: n.name as string,
        children: (n.children ?? []) as string[],
        properties: (n.properties ?? {}) as Record<string, unknown>,
        editorPos: { x: 0, y: 0 },
        raw: "",
      })),
    }],
  };
}

describe("V01: Integer Duration", () => {
  it("flags transition with integer duration", () => {
    const agf = makeAgf([{
      type: "AnimSrcNodeStateMachine", name: "SM", children: [],
      properties: {
        states: [{ name: "A", startCondition: "1", timeMode: "Normtime", exit: false, child: null }],
        transitions: [{ from: "A", to: "B", condition: "x", duration: "0", postEval: false, blendFn: null, startTime: null }],
      },
    }]);
    const result = validateGraph(agf);
    expect(result.issues.some(i => i.id === "V01")).toBe(true);
    expect(result.errorCount).toBeGreaterThanOrEqual(1);
  });

  it("passes with decimal duration", () => {
    const agf = makeAgf([{
      type: "AnimSrcNodeStateMachine", name: "SM", children: [],
      properties: {
        states: [],
        transitions: [{ from: "A", to: "B", condition: "x", duration: "0.3", postEval: false, blendFn: null, startTime: null }],
      },
    }]);
    const result = validateGraph(agf);
    expect(result.issues.some(i => i.id === "V01")).toBe(false);
  });
});

describe("V02: Missing PostEval", () => {
  it("flags condition using RemainingTimeLess without PostEval", () => {
    const agf = makeAgf([{
      type: "AnimSrcNodeStateMachine", name: "SM", children: [],
      properties: {
        states: [],
        transitions: [{ from: "A", to: "B", condition: "RemainingTimeLess(0.2)", duration: "0.3", postEval: false, blendFn: null, startTime: null }],
      },
    }]);
    const result = validateGraph(agf);
    expect(result.issues.some(i => i.id === "V02")).toBe(true);
  });

  it("passes when PostEval is enabled", () => {
    const agf = makeAgf([{
      type: "AnimSrcNodeStateMachine", name: "SM", children: [],
      properties: {
        states: [],
        transitions: [{ from: "A", to: "B", condition: "RemainingTimeLess(0.2)", duration: "0.3", postEval: true, blendFn: null, startTime: null }],
      },
    }]);
    const result = validateGraph(agf);
    expect(result.issues.some(i => i.id === "V02")).toBe(false);
  });
});

describe("V03: No catch-all state", () => {
  it("flags StateMachine without StartCondition '1' as last state", () => {
    const agf = makeAgf([{
      type: "AnimSrcNodeStateMachine", name: "SM", children: [],
      properties: {
        states: [
          { name: "A", startCondition: "Speed == 0", timeMode: "Normtime", exit: false, child: null },
          { name: "B", startCondition: "Speed > 0", timeMode: "Normtime", exit: false, child: null },
        ],
        transitions: [],
      },
    }]);
    const result = validateGraph(agf);
    expect(result.issues.some(i => i.id === "V03")).toBe(true);
  });
});

describe("V04: Duplicate node names", () => {
  it("flags duplicate names within a sheet", () => {
    const agf = makeAgf([
      { type: "AnimSrcNodeBindPose", name: "Dupe", children: [] },
      { type: "AnimSrcNodeSource", name: "Dupe", children: [] },
    ]);
    const result = validateGraph(agf);
    expect(result.issues.some(i => i.id === "V04")).toBe(true);
  });
});

describe("V05: Orphan nodes", () => {
  it("flags nodes not referenced by any parent", () => {
    const agf = makeAgf([
      { type: "AnimSrcNodeQueue", name: "Root", children: ["Child1"] },
      { type: "AnimSrcNodeBindPose", name: "Child1", children: [] },
      { type: "AnimSrcNodeBindPose", name: "Orphan", children: [] },
    ]);
    const result = validateGraph(agf);
    expect(result.issues.some(i => i.id === "V05" && i.message.includes("Orphan"))).toBe(true);
  });
});

describe("V08: 2-part Source format", () => {
  it("flags Source with only 2 dot-separated parts", () => {
    const agf = makeAgf([{
      type: "AnimSrcNodeSource", name: "Src", children: [],
      properties: { source: "Group.Anim" },
    }]);
    const result = validateGraph(agf);
    expect(result.issues.some(i => i.id === "V08")).toBe(true);
  });

  it("passes with 3-part format", () => {
    const agf = makeAgf([{
      type: "AnimSrcNodeSource", name: "Src", children: [],
      properties: { source: "Group.Col.Anim" },
    }]);
    const result = validateGraph(agf);
    expect(result.issues.some(i => i.id === "V08")).toBe(false);
  });
});

describe("V09: $Time in ProcTransform", () => {
  it("flags Amount expression containing $Time", () => {
    const agf = makeAgf([{
      type: "AnimSrcNodeProcTransform", name: "PT", children: ["BP"],
      properties: {
        expression: "1",
        boneItems: [{ bone: "root", op: "Rotate", axis: null, amount: "$Time * 2.0" }],
      },
    }]);
    const result = validateGraph(agf);
    expect(result.issues.some(i => i.id === "V09")).toBe(true);
  });
});

describe("V11: BlendN threshold order", () => {
  it("flags thresholds not in ascending order", () => {
    const agf = makeAgf([{
      type: "AnimSrcNodeBlendN", name: "BN", children: [],
      properties: { thresholds: ["10", "5", "20"] },
    }]);
    const result = validateGraph(agf);
    expect(result.issues.some(i => i.id === "V11")).toBe(true);
  });
});

describe("empty graph", () => {
  it("returns PASSED with zero issues", () => {
    const result = validateGraph({ sheets: [] });
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/animation/validator.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement validateGraph**

Create `src/animation/validator.ts`:

```typescript
import type { ParsedAgf, ParsedAgr, ParsedAsi, ValidationResult, ValidationIssue } from "./types.js";

const POST_EVAL_FUNCTIONS = [
  "RemainingTimeLess", "IsEvent", "IsTag", "GetLowerTime",
  "LowerNTimePassed", "GetRemainingTime", "GetEventTime", "GetLowerRTime",
];

export function validateGraph(
  agf: ParsedAgf,
  agr?: ParsedAgr,
  asi?: ParsedAsi,
  agfPath?: string,  // needed for V07
): ValidationResult {
  const issues: ValidationIssue[] = [];

  for (const sheet of agf.sheets) {
    // V04: Duplicate node names
    const namesSeen = new Set<string>();
    for (const node of sheet.nodes) {
      if (namesSeen.has(node.name)) {
        issues.push({ id: "V04", severity: "error", message: `Duplicate node name "${node.name}" in sheet "${sheet.name}"` });
      }
      namesSeen.add(node.name);
    }

    // V05: Orphan nodes
    const allChildRefs = new Set<string>();
    for (const node of sheet.nodes) {
      for (const child of node.children) allChildRefs.add(child);
    }
    for (const node of sheet.nodes) {
      const isRootLike = node.type === "AnimSrcNodeQueue"
        || node.type === "AnimSrcNodeFunctionBegin"
        || sheet.nodes.indexOf(node) === 0;
      if (!allChildRefs.has(node.name) && !isRootLike) {
        issues.push({ id: "V05", severity: "warning", message: `Node "${node.name}" is orphaned -- not referenced by any parent node` });
      }
    }

    for (const node of sheet.nodes) {
      // StateMachine checks
      if (node.type === "AnimSrcNodeStateMachine") {
        const states = (node.properties.states ?? []) as Array<Record<string, unknown>>;
        const transitions = (node.properties.transitions ?? []) as Array<Record<string, unknown>>;

        // V03: No catch-all state
        if (states.length > 0) {
          const lastState = states[states.length - 1];
          if (lastState.startCondition !== "1") {
            issues.push({ id: "V03", severity: "warning", message: `StateMachine "${node.name}": no catch-all state (StartCondition "1")` });
          }
        }

        for (const t of transitions) {
          // V01: Integer Duration
          const dur = t.duration as string | null;
          if (dur !== null && dur !== undefined && /^\d+$/.test(dur)) {
            issues.push({ id: "V01", severity: "error", message: `Transition "${t.from} -> ${t.to}": Duration is integer (${dur}) -- must be decimal (${dur}.0)` });
          }

          // V02: Missing PostEval
          const cond = (t.condition as string) ?? "";
          if (!t.postEval && POST_EVAL_FUNCTIONS.some(fn => cond.includes(fn))) {
            const fn = POST_EVAL_FUNCTIONS.find(fn => cond.includes(fn));
            issues.push({ id: "V02", severity: "warning", message: `Transition "${t.from} -> ${t.to}": condition uses ${fn}() but PostEval is not enabled` });
          }
        }

        // V12: State Time mode mismatch
        for (const state of states) {
          const childName = state.child as string | null;
          if (childName && state.timeMode) {
            const childNode = sheet.nodes.find(n => n.name === childName);
            if (childNode) {
              const childIsSM = childNode.type === "AnimSrcNodeStateMachine";
              if (state.timeMode === "Notime" && !childIsSM) {
                issues.push({ id: "V12", severity: "warning", message: `State "${state.name}" in "${node.name}": Notime but child "${childName}" is not a StateMachine` });
              }
              if (state.timeMode !== "Notime" && childIsSM) {
                issues.push({ id: "V12", severity: "warning", message: `State "${state.name}" in "${node.name}": nested StateMachine "${childName}" should use Notime on parent state` });
              }
            }
          }
        }
      }

      // V08: 2-part Source format
      if (node.type === "AnimSrcNodeSource") {
        const src = node.properties.source as string | undefined;
        if (src) {
          const parts = src.split(".");
          if (parts.length === 2) {
            issues.push({ id: "V08", severity: "error", message: `Source "${node.name}": uses 2-part format "${src}" -- needs 3-part "Group.Column.Anim"` });
          }
        }
      }

      // V09: $Time in ProcTransform
      if (node.type === "AnimSrcNodeProcTransform") {
        const boneItems = (node.properties.boneItems ?? []) as Array<Record<string, unknown>>;
        for (const bi of boneItems) {
          const amount = (bi.amount as string) ?? "";
          if (amount.includes("$Time")) {
            issues.push({ id: "V09", severity: "error", message: `ProcTransform "${node.name}": Amount uses $Time -- should be GetUpperRTime()` });
          }
        }
      }

      // V11: BlendN threshold order
      if (node.type === "AnimSrcNodeBlendN") {
        const thresholds = (node.properties.thresholds ?? []) as string[];
        const nums = thresholds.map(Number);
        for (let i = 1; i < nums.length; i++) {
          if (nums[i] < nums[i - 1]) {
            issues.push({ id: "V11", severity: "error", message: `BlendN "${node.name}": thresholds not in ascending order` });
            break;
          }
        }
      }
    }
  }

  // Cross-reference checks (require AGR)
  if (agr) {
    // V06: DefaultRunNode mismatch
    if (agr.defaultRunNode) {
      const allQueueNames = agf.sheets.flatMap(s => s.nodes.filter(n => n.type === "AnimSrcNodeQueue").map(n => n.name));
      if (!allQueueNames.includes(agr.defaultRunNode)) {
        issues.push({ id: "V06", severity: "error", message: `DefaultRunNode "${agr.defaultRunNode}" does not match any Queue node in the AGF` });
      }
    }

    // V07: AGF not registered in AGR
    if (agfPath) {
      const registered = agr.agfReferences.some(ref => ref.includes(agfPath));
      if (!registered) {
        issues.push({ id: "V07", severity: "error", message: `AGF "${agfPath}" is not listed in AGR GraphFilesResourceNames` });
      }
    }

    // V10: IK chain mismatch
    const agrChainNames = new Set(agr.ikChains.map(c => c.name));
    for (const sheet of agf.sheets) {
      for (const node of sheet.nodes) {
        if (node.type === "AnimSrcNodeIK2") {
          const chains = (node.properties.chains ?? []) as Array<Record<string, unknown>>;
          for (const chain of chains) {
            const chainName = chain.ikChain as string;
            if (chainName && !agrChainNames.has(chainName)) {
              issues.push({ id: "V10", severity: "warning", message: `IK2 "${node.name}": references chain "${chainName}" not defined in AGR` });
            }
          }
        }
      }
    }
  }

  // V13: Unmapped Source animation (requires ASI)
  if (asi) {
    for (const sheet of agf.sheets) {
      for (const node of sheet.nodes) {
        if (node.type === "AnimSrcNodeSource") {
          const src = node.properties.source as string | undefined;
          if (src && src.split(".").length === 3) {
            const [group, column, anim] = src.split(".");
            const mapping = asi.mappings.find(
              m => m.group === group && m.column === column && m.animation === anim
            );
            if (!mapping || mapping.anmPath === null) {
              issues.push({ id: "V13", severity: "warning", message: `Source "${node.name}": animation "${src}" has no mapping in ASI` });
            }
          }
        }
      }
    }
  }

  const errorCount = issues.filter(i => i.severity === "error").length;
  const warningCount = issues.filter(i => i.severity === "warning").length;

  return { issues, errorCount, warningCount };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/animation/validator.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Add V06, V07, V10, V12, V13 tests**

Add tests for all remaining cross-reference checks:

```typescript
describe("V06: DefaultRunNode mismatch", () => {
  it("flags when DefaultRunNode doesn't match any Queue", () => {
    const agf = makeAgf([{ type: "AnimSrcNodeQueue", name: "Root", children: [] }]);
    const agr: ParsedAgr = {
      variables: [], commands: [], ikChains: [], boneMasks: [],
      globalTags: [], defaultRunNode: "NonExistent", agfReferences: [], astReference: null,
    };
    const result = validateGraph(agf, agr);
    expect(result.issues.some(i => i.id === "V06")).toBe(true);
  });
});

describe("V07: AGF not registered", () => {
  it("flags when AGF path is not in GraphFilesResourceNames", () => {
    const agf = makeAgf([{ type: "AnimSrcNodeQueue", name: "Root", children: [] }]);
    const agr: ParsedAgr = {
      variables: [], commands: [], ikChains: [], boneMasks: [],
      globalTags: [], defaultRunNode: "Root", agfReferences: ["{GUID}other.agf"], astReference: null,
    };
    const result = validateGraph(agf, agr, undefined, "my_graph.agf");
    expect(result.issues.some(i => i.id === "V07")).toBe(true);
  });
});

describe("V12: State Time mode mismatch", () => {
  it("flags Notime state with non-StateMachine child", () => {
    const agf = makeAgf([
      {
        type: "AnimSrcNodeStateMachine", name: "SM", children: ["Src"],
        properties: {
          states: [{ name: "S1", startCondition: "1", timeMode: "Notime", exit: false, child: "Src" }],
          transitions: [],
        },
      },
      { type: "AnimSrcNodeSource", name: "Src", children: [] },
    ]);
    const result = validateGraph(agf);
    expect(result.issues.some(i => i.id === "V12")).toBe(true);
  });
});

describe("V13: Unmapped Source animation", () => {
  it("flags Source with no ASI mapping", () => {
    const agf = makeAgf([{
      type: "AnimSrcNodeSource", name: "Src", children: [],
      properties: { source: "Loco.Erc.Walk" },
    }]);
    const asi: ParsedAsi = { mappings: [] };
    const result = validateGraph(agf, undefined, asi);
    expect(result.issues.some(i => i.id === "V13")).toBe(true);
  });
});
```

- [ ] **Step 6: Make all tests pass (V07, V12, V13 already implemented in Step 3)**

Run: `npx vitest run tests/animation/validator.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/animation/validator.ts tests/animation/validator.test.ts
git commit -m "feat(animation): graph validator with V01-V13 checks"
```

---

### Task 8: Wire Validate Action into Inspect Tool

Connect the validator to `animation-graph-inspect.ts` for the `validate` action.

**Files:**
- Modify: `src/tools/animation-graph-inspect.ts`

- [ ] **Step 1: Extract readFileForTool helper and add validate handler**

Extract the file-reading logic (mod/game resolution, pak fallback) from the existing handler into a reusable helper:

```typescript
function readFileForTool(
  filePath: string,
  source: "mod" | "game",
  projectPath: string | undefined,
  config: Config,
): string | null {
  try {
    if (source === "mod") {
      const basePath = projectPath || config.projectPath;
      if (!basePath) return null;
      const fullPath = validateProjectPath(basePath, filePath);
      if (!existsSync(fullPath)) return null;
      return readFileSync(fullPath, "utf-8");
    } else {
      const dataPath = join(config.gamePath, "addons", "data");
      const loosePath = validateProjectPath(dataPath, filePath);
      if (existsSync(loosePath)) {
        return readFileSync(loosePath, "utf-8");
      }
      const pakVfs = PakVirtualFS.get(config.gamePath);
      if (pakVfs && pakVfs.exists(filePath)) {
        return pakVfs.readFile(filePath).toString("utf-8");
      }
      return null;
    }
  } catch {
    return null;
  }
}
```

Then add the validate handler:

```typescript
import { validateGraph } from "../animation/validator.js";

// ... inside the handler:
if (action === "validate") {
  if (ext !== ".agf") {
    return { content: [{ type: "text", text: "Validate action requires an .agf file as the primary path." }], isError: true };
  }

  const agf = parseAgfToStruct(content);

  let agr: ParsedAgr | undefined;
  if (agrPath) {
    const agrContent = readFileForTool(agrPath, source, projectPath, config);
    if (agrContent) agr = parseAgrToStruct(agrContent);
  }

  let asi: ParsedAsi | undefined;
  if (asiPath) {
    const asiContent = readFileForTool(asiPath, source, projectPath, config);
    if (asiContent) asi = parseAsiToStruct(asiContent);
  }

  const result = validateGraph(agf, agr, asi, filePath);
  const nodeCount = agf.sheets.reduce((sum, s) => sum + s.nodes.length, 0);
  return { content: [{ type: "text", text: formatValidationReport(result, nodeCount) }] };
}
```

- [ ] **Step 2: Implement formatValidationReport**

Add to `src/animation/formatter.ts`:

```typescript
export function formatValidationReport(result: ValidationResult, nodeCount: number = 0): string {
  const lines: string[] = [];
  lines.push("=== Validation Report ===\n");

  if (result.issues.length === 0) {
    lines.push("=== PASSED (0 errors, 0 warnings) ===");
    if (nodeCount === 0) {
      lines.push("\nNote: Graph contains no nodes.");
    }
    return lines.join("\n");
  }

  lines.push(`${result.errorCount} error(s), ${result.warningCount} warning(s)\n`);

  for (const issue of result.issues) {
    const sev = issue.severity === "error" ? "[ERROR]" : "[WARN] ";
    lines.push(`${sev} ${issue.id}: ${issue.message}`);
  }

  lines.push("");
  lines.push(result.errorCount > 0 ? `=== FAILED (${result.errorCount} errors) ===` : `=== PASSED (0 errors) ===`);

  return lines.join("\n");
}
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/tools/animation-graph-inspect.ts src/animation/formatter.ts
git commit -m "feat(animation): wire validate action into inspect tool"
```

---

### Task 9: Suggest Action

Implement the suggest action for `animation-graph-setup`.

**Files:**
- Create: `src/animation/suggestions.ts`
- Create: `tests/animation/suggestions.test.ts`
- Modify: `src/tools/animation-graph-setup.ts`

- [ ] **Step 1: Write failing tests for suggestion detection**

Create `tests/animation/suggestions.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { generateSuggestions } from "../../src/animation/suggestions.js";
import type { ParsedAgf, ParsedAgr } from "../../src/animation/types.js";

describe("Performance: Blend without Optimization", () => {
  it("suggests enabling Optimization on variable-driven Blend", () => {
    const agf: ParsedAgf = {
      sheets: [{
        name: "Main",
        nodes: [{
          type: "AnimSrcNodeBlend", name: "B1",
          children: ["A", "B"],
          properties: { blendWeight: "AimWeight", optimization: false },
          editorPos: { x: 0, y: 0 }, raw: "",
        }],
      }],
    };
    const suggestions = generateSuggestions(agf);
    expect(suggestions.some(s => s.category === "Performance")).toBe(true);
  });
});

describe("Smoothing: Instant transitions", () => {
  it("suggests smoothing for Duration 0.0", () => {
    const agf: ParsedAgf = {
      sheets: [{
        name: "Main",
        nodes: [{
          type: "AnimSrcNodeStateMachine", name: "SM",
          children: [],
          properties: {
            states: [
              { name: "A", startCondition: "1", timeMode: "Normtime", exit: false, child: null },
            ],
            transitions: [
              { from: "A", to: "B", condition: "x", duration: "0.0", postEval: false, blendFn: null, startTime: null },
            ],
          },
          editorPos: { x: 0, y: 0 }, raw: "",
        }],
      }],
    };
    const suggestions = generateSuggestions(agf);
    expect(suggestions.some(s => s.category === "Smoothing")).toBe(true);
  });
});

describe("Flexibility: Hardcoded ProcTransform Amount", () => {
  it("suggests variable for hardcoded numeric Amount", () => {
    const agf: ParsedAgf = {
      sheets: [{
        name: "Main",
        nodes: [{
          type: "AnimSrcNodeProcTransform", name: "PT",
          children: ["BP"],
          properties: {
            expression: "1",
            boneItems: [{ bone: "root", op: "Rotate", axis: null, amount: "GetUpperRTime() * 2.094" }],
          },
          editorPos: { x: 0, y: 0 }, raw: "",
        }],
      }],
    };
    const suggestions = generateSuggestions(agf);
    expect(suggestions.some(s => s.category === "Flexibility")).toBe(true);
  });
});

describe("Robustness: Queue items without InterruptExpr", () => {
  it("suggests adding InterruptExpr", () => {
    const agf: ParsedAgf = {
      sheets: [{
        name: "Main",
        nodes: [{
          type: "AnimSrcNodeQueue", name: "Q",
          children: ["C"],
          properties: {
            queueItems: [{ child: "C", startExpr: "IsCommand(CMD_Reload)", interruptExpr: null, blendInTime: "0.2", blendOutTime: "0.3", enqueueMethod: "Replace", tagMainPath: null }],
          },
          editorPos: { x: 0, y: 0 }, raw: "",
        }],
      }],
    };
    const suggestions = generateSuggestions(agf);
    expect(suggestions.some(s => s.category === "Robustness")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/animation/suggestions.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement generateSuggestions**

Create `src/animation/suggestions.ts`:

```typescript
import type { ParsedAgf, ParsedAgr, Suggestion } from "./types.js";

export function generateSuggestions(agf: ParsedAgf, agr?: ParsedAgr): Suggestion[] {
  const suggestions: Suggestion[] = [];

  for (const sheet of agf.sheets) {
    for (const node of sheet.nodes) {
      // Performance: Blend without Optimization
      if (node.type === "AnimSrcNodeBlend") {
        const weight = node.properties.blendWeight as string | undefined;
        const opt = node.properties.optimization as boolean | undefined;
        if (weight && !opt) {
          suggestions.push({
            category: "Performance",
            title: `Blend "${node.name}" has no Optimization flag`,
            description: "When BlendWeight is variable-driven, enabling Optimization skips evaluating the child branch at 0% influence, saving CPU.",
            snippet: `// Add to ${node.name}:\nOptimization 1`,
          });
        }
      }

      // Smoothing: Instant transitions
      if (node.type === "AnimSrcNodeStateMachine") {
        const transitions = (node.properties.transitions ?? []) as Array<Record<string, unknown>>;
        for (const t of transitions) {
          if (t.duration === "0.0" || t.duration === "0.00") {
            suggestions.push({
              category: "Smoothing",
              title: `Transition "${t.from} -> ${t.to}" is instant (Duration 0.0)`,
              description: "Instant transitions cause visible pose snapping. Use Duration 0.2-0.3 with BlendFn S for smooth crossfade.",
              snippet: `Duration 0.3\nBlendFn S`,
            });
          }
        }
      }

      // Flexibility: Hardcoded ProcTransform Amount
      if (node.type === "AnimSrcNodeProcTransform") {
        const boneItems = (node.properties.boneItems ?? []) as Array<Record<string, unknown>>;
        for (const bi of boneItems) {
          const amount = (bi.amount as string) ?? "";
          // Detect hardcoded numeric multipliers (e.g. "GetUpperRTime() * 2.094")
          if (/\*\s*\d+\.?\d*\s*$/.test(amount) && !amount.match(/[A-Za-z_]\w*\s*$/)) {
            suggestions.push({
              category: "Flexibility",
              title: `ProcTransform "${node.name}" uses hardcoded value in Amount`,
              description: "Extract the numeric multiplier to an AGR float variable for runtime control.",
              snippet: `// AGR: Add variable\nAnimSrcGCTVarFloat SpeedMultiplier {\n DefaultValue ${amount.match(/(\d+\.?\d*)$/)?.[1] ?? "1.0"}\n}\n\n// AGF: Replace hardcoded value\nAmount "${amount.replace(/\d+\.?\d*\s*$/, "SpeedMultiplier")}"`,
            });
          }
        }
      }

      // Robustness: Queue items without InterruptExpr
      if (node.type === "AnimSrcNodeQueue") {
        const items = (node.properties.queueItems ?? []) as Array<Record<string, unknown>>;
        for (const item of items) {
          if (item.startExpr && !item.interruptExpr) {
            suggestions.push({
              category: "Robustness",
              title: `Queue item in "${node.name}" has no InterruptExpr`,
              description: "Without InterruptExpr, the queued action cannot be cancelled mid-play. Add an interrupt condition to prevent stuck animations.",
              snippet: `InterruptExpr "IsCommand(CMD_Cancel)"`,
            });
          }
        }
      }

      // Sync: Locomotion transitions without GetLowerTime
      if (node.type === "AnimSrcNodeStateMachine") {
        const transitions = (node.properties.transitions ?? []) as Array<Record<string, unknown>>;
        for (const t of transitions) {
          const dur = parseFloat(t.duration as string ?? "0");
          if (dur > 0 && !t.startTime) {
            suggestions.push({
              category: "Sync",
              title: `Transition "${t.from} -> ${t.to}" could use time sync`,
              description: "Adding GetLowerTime() as StartTime syncs the destination animation's playback position with the source, preventing foot sliding in locomotion.",
              snippet: `StartTime "GetLowerTime()"`,
            });
          }
        }
      }

      // IK completeness: TwoBoneSolver without PoleSolver
      if (node.type === "AnimSrcNodeIK2") {
        const solver = node.properties.solver as string | undefined;
        if (solver && /TwoBone/i.test(solver)) {
          // Check if there's a PoleSolver IK2 in the same sheet for the same chains
          const hasPoleSolver = sheet.nodes.some(n =>
            n.type === "AnimSrcNodeIK2" && n.name !== node.name &&
            /Pole/i.test((n.properties.solver as string) ?? "")
          );
          if (!hasPoleSolver) {
            suggestions.push({
              category: "IK completeness",
              title: `IK2 "${node.name}" uses TwoBoneSolver without PoleSolver companion`,
              description: "Without a PoleSolver, the knee/elbow direction may flip unpredictably. Add a PoleSolver IK2 node with a pole target.",
              snippet: `// Add pole target via IK2Target, then:\nAnimSrcNodeIK2 ${node.name}Pole {\n Child "..."\n Solver AnimSrcNodeIK2PoleSolver {\n }\n}`,
            });
          }
        }
      }
    }
  }

  // Architecture: turret/chassis split detection (requires AGR)
  if (agr) {
    const hasTurretMask = agr.boneMasks.some(m =>
      /turret|hull|chassis|body|upper|lower/i.test(m.name)
    );
    const hasBufferNodes = agf.sheets.some(s =>
      s.nodes.some(n => n.type === "AnimSrcNodeBufferSave" || n.type === "AnimSrcNodeBufferUse")
    );
    if (hasTurretMask && !hasBufferNodes) {
      suggestions.push({
        category: "Architecture",
        title: "Bone masks suggest upper/lower body split but no BufferSave/Use",
        description: "Use BufferSave to capture the chassis pose, then BufferUse to restore it before applying turret IK.",
        snippet: `// After chassis locomotion:\nAnimSrcNodeBufferSave SaveChassis {\n BufferName "chassis_pose"\n Child "LocomotionOutput"\n}\n\n// Before turret IK:\nAnimSrcNodeBufferUse RestoreChassis {\n BufferName "chassis_pose"\n}`,
      });
    }
  }

  return suggestions;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/animation/suggestions.test.ts`
Expected: PASS

- [ ] **Step 5: Wire suggest into animation-graph-setup.ts**

Add the `action`, `agrPath`, `agfPath` parameters to the tool schema. **Critical:** change `vehicleName` from `z.string()` to `z.string().optional()` — it is only required when `action === "setup"`. Add validation at the start of the handler:

```typescript
if (action === "setup" && !vehicleName) {
  return { content: [{ type: "text", text: "vehicleName is required for setup action." }], isError: true };
}
```

When `action === "suggest"`:
- Read and parse both AGR and AGF files using `readFileForTool` (same helper as inspect tool — extract to `src/animation/file-reader.ts` or inline)
- Call `generateSuggestions(agf, agr)`
- Format and return suggestions

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/animation/suggestions.ts tests/animation/suggestions.test.ts src/tools/animation-graph-setup.ts
git commit -m "feat(animation): suggest action with improvement recommendations"
```

---

### Task 10: Guide Presets

Implement the guide action with character, weapon, prop, and custom presets.

**Files:**
- Create: `src/animation/guides.ts`
- Create: `tests/animation/guides.test.ts`
- Modify: `src/tools/animation-graph-setup.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/animation/guides.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { generateGuide } from "../../src/animation/guides.js";

describe("character preset", () => {
  it("includes locomotion variables", () => {
    const guide = generateGuide("character");
    expect(guide).toContain("Speed");
    expect(guide).toContain("MoveDir");
    expect(guide).toContain("Stance");
  });

  it("includes IK chain guidance", () => {
    const guide = generateGuide("character");
    expect(guide).toContain("IK");
    expect(guide).toContain("foot");
  });

  it("includes prefab wiring", () => {
    const guide = generateGuide("character");
    expect(guide).toContain("AnimationControllerComponent");
  });
});

describe("weapon preset", () => {
  it("includes weapon commands", () => {
    const guide = generateGuide("weapon");
    expect(guide).toContain("Fire");
    expect(guide).toContain("Reload");
  });

  it("includes Queue pattern", () => {
    const guide = generateGuide("weapon");
    expect(guide).toContain("Queue");
  });
});

describe("prop preset", () => {
  it("includes ProcTransform patterns", () => {
    const guide = generateGuide("prop");
    expect(guide).toContain("ProcTransform");
    expect(guide).toContain("GetUpperRTime()");
  });

  it("includes BaseItemAnimationComponent", () => {
    const guide = generateGuide("prop");
    expect(guide).toContain("BaseItemAnimationComponent");
  });
});

describe("custom preset", () => {
  it("returns questionnaire", () => {
    const guide = generateGuide("custom");
    expect(guide).toContain("?");  // Contains questions
    expect(guide).toContain("bones");
    expect(guide).toContain("states");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/animation/guides.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement generateGuide**

Create `src/animation/guides.ts`. Each preset is a function that returns a Markdown-formatted guidance string. Content is compiled from knowledge base patterns (character animation, weapon animation, prop animation, vehicle animation).

Key sections per preset:
- **character**: AGR variables (Speed, MoveDir, Stance, AimX, AimY, WeaponType, IsAiming), commands (Death, Hit, Reload, ThrowGrenade, Melee), IK chains (left/right leg, arm, spine), bone masks (upper/lower body), AGF layout (Queue -> locomotion SM + aim overlay + action items + IK pipeline), prefab wiring
- **weapon**: AGR variables (FireMode, MagCount, SafetyOn), commands (Fire, Reload, Inspect, SafetyToggle), AGF layout (Queue with QueueItems), AST/ASI structure
- **prop**: ProcTransform patterns (spin, oscillate, tumble), AGR variable for speed, BaseItemAnimationComponent wiring, confirmed patterns from knowledge base
- **custom**: structured questionnaire (bones, states, inputs, IK needs, blend requirements)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/animation/guides.test.ts`
Expected: PASS

- [ ] **Step 5: Wire guide into animation-graph-setup.ts**

Add `preset` parameter. When `action === "guide"`:
- Call `generateGuide(preset)`
- Return the guide text
- For `preset === "vehicle"`, fall through to existing setup behavior

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/animation/guides.ts tests/animation/guides.test.ts src/tools/animation-graph-setup.ts
git commit -m "feat(animation): guide action with character/weapon/prop/custom presets"
```

---

### Task 11: Integration Test and Cleanup

End-to-end validation that all pieces work together.

**Files:**
- Modify: `src/tools/animation-graph-inspect.ts` (if needed)
- Modify: `src/tools/animation-graph-setup.ts` (if needed)
- Modify: `src/server.ts` (if imports changed)

- [ ] **Step 1: Verify server.ts imports are correct**

The existing `registerAnimationGraphInspect` and `registerAnimationGraphSetup` imports in `src/server.ts` should still work since we only modified the internals, not the exported function signatures. Verify no import changes are needed.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (original tests + new animation tests)

- [ ] **Step 3: Build the project**

Run: `npm run build`
Expected: Clean build with no TypeScript errors

- [ ] **Step 4: Verify tool descriptions are updated**

Read the tool registration in both modified files. Ensure the `description` field mentions the new actions:
- `animation_graph_inspect`: mention `validate` action and `.asi` support
- `animation_graph_setup`: mention `suggest` and `guide` actions

- [ ] **Step 5: Update tool descriptions if needed**

Update description strings to include new capabilities so the LLM knows when to use them.

- [ ] **Step 6: Final build and test**

Run: `npm run build && npx vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/tools/animation-graph-inspect.ts src/tools/animation-graph-setup.ts
git commit -m "feat(animation): integration cleanup and updated tool descriptions"
```
