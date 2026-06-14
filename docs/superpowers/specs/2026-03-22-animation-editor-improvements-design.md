# Animation Editor Improvements — Design Spec

**Date:** 2026-03-22
**Status:** Draft
**Scope:** Improve animation graph inspection, validation, and guidance in Enfusion MCP

## Summary

Enhance the existing `animation_graph_inspect` and `animation_graph_setup` tools to provide deep graph parsing, automated pitfall detection, and expanded guidance beyond vehicles. No new tools are created — existing tools gain new actions and richer output.

## Motivation

The current animation tools are shallow:
- `animation_graph_inspect` parses AGF files but only extracts node type, name, and single `Child` reference — missing transition conditions, blend weights, ProcTransform expressions, IK bindings, queue items, state machine structure, and more.
- `animation_graph_setup` only generates vehicle AGR/AST scaffolds. No guidance for characters, weapons, or props.
- No validation exists — common mistakes (integer Duration, missing PostEval, orphan nodes) go undetected.
- ASI files are not parsed at all.

The knowledge base already documents 25+ node types with rich property schemas, common pitfalls, and design patterns. This design connects that knowledge to the tools.

## Design

### 1. Deep AGF Parser

Replace the shallow `parseAgf()` with a parser that extracts all meaningful properties per node type.

**Node types and their extracted properties:**

| Node Type | Properties Extracted |
|---|---|
| Queue | Child, QueueItems (Child, StartExpr, InterruptExpr, BlendInTime, BlendOutTime, EnqueueMethod, CacheOnEnqueue, TagMainPath) |
| StateMachine | States (name, StartCondition, Time mode, Exit), Transitions (Condition, Duration, PostEval, BlendFn, StartTime) |
| Source | Source (group.column.anim reference), Tags |
| BindPose | (leaf node, no special properties) |
| Blend | Child0, Child1, BlendWeight, BlendFn, MotionVectors, Optimization, SelectMainPath |
| BlendN | BlendWeight, Thresholds (ordered list), IsCyclic, children, SelectMainPath |
| BlendT | Child0, Child1, BlendTime, TriggerOn, TriggerOff, Condition, PostEval, SelectMainPath |
| BlendTAdd | Child0, Child1, BlendTime, TriggerOn, TriggerOff, Condition, AdditiveAlways |
| BlendTW | Child0, Child1, TargetWeight, BlendTime, BlendTimeFn, OptimizeMin, OptimizeMax |
| ProcTransform | Child, Expression, Bones (bone name, Op, Axis, Amount expression per BoneItem) |
| IK2 | Child, Weight, Chains (IkTarget, IkChain bindings), Solver type |
| IK2Target | Child, Chains (IkTarget, IkChain, offsets), Bones (IkTarget, Bone) |
| IK2Plane | Child, Weight, Chains, ActiveDistance, ThresholdSmoothness, SnapRotation |
| IKLock | Child, IsLocked, BlendinTime, BlendoutTime, SnapRotation, World, Chains |
| IKRotation | Child, Weight, Chains |
| Switch | BlendTime, FirstProbabilities, SwitchItems (Child, NextProbabilities) |
| Filter | Child, BoneMask, Condition |
| BufferSave | Child, BufferName, BoneMask |
| BufferUse | BufferName, BoneMask |
| Tag | (Tags property from common properties) |
| Sleep | (no special properties beyond common) |
| VarUpdate | (variable update expressions) |
| CtxBegin | Child |
| CtxEnd | Child |
| FunctionBegin | Child, EndsCount |
| FunctionCall | Method, Child0-Child7 |
| FunctionEnd | EndIndex |
| GroupSelect | Group, Column |
| Attachment | Binding |
| Pose | Source animation reference, frame expression |
| Pose2 | Two source references, frame expressions |
| SourceInLoopOut | Intro/Loop/Outro child references, transition conditions |
| SourceSync | Synchronized source reference |
| State | StartCondition, Time mode (Notime/Realtime/Normtime), Exit |
| TimeSave | Child, TimeStorage mode, save name |
| TimeScale | Child, TimeStorage mode, scale expression |
| TimeUse | Child, saved time name |
| VarReset | Variable name, reset value |
| VarSet | Variable name, set expression |
| Memory | Child, memory operation |
| Constraint | Child, constraint type and parameters |
| RBF | Radial basis function weights and targets |
| WeaponIK | Weapon-specific IK bindings |
| AnimSrcEventGeneric | Name, UserString, UserInt, Condition, Once, MainPathOnly |
| AnimSrcEventAudio | Name, Condition, Once, MainPathOnly |

**Unknown node types:** Any `AnimSrcNode*` type not in this table falls back to generic extraction (type, name, Child reference only). This ensures forward compatibility with new node types.

**Node hierarchy tree:** Build a connection map from all child references and output a readable tree showing the full graph structure with indentation. Nodes that appear in multiple parents get a `(see above)` cross-reference marker instead of being expanded again. Circular references (e.g., FunctionCall loops) are detected and marked with `(cycle)` to prevent infinite recursion.

**Multi-sheet handling:** Each sheet is rendered as its own tree. Cross-sheet references (e.g., FunctionCall referencing a FunctionBegin in another sheet) are shown as `-> SheetName.NodeName`.

**Summary header:** Show sheet count, total node count, and breakdown by type.

**Output example:**

```
=== AGF Summary ===

Sheets: 1 | Nodes: 14 (3 StateMachine, 4 Source, 2 Blend, 2 ProcTransform, 1 Queue, 1 BindPose, 1 IK2)

Sheet: MainSheet
  Queue "MasterQueue"
    └─ StateMachine "LocomotionSM"
        ├─ State "Idle" (StartCondition: "Speed == 0") [Normtime]
        │   └─ Source "IdleAnim" -> "Locomotion.Erc.Idle"
        │   Transitions:
        │     -> "Walk" when "Speed > 0.1" (Duration: 0.3, BlendFn: S)
        ├─ State "Walk" (StartCondition: "Speed > 0") [Realtime]
        │   └─ BlendN "WalkDirectional" (weight: MoveDir, thresholds: -180..180)
        │       ├─ Source "WalkFwd" -> "Locomotion.Erc.WalkF"
        │       └─ Source "WalkBwd" -> "Locomotion.Erc.WalkB"
        └─ State "Fallback" (StartCondition: "1") [Normtime]
            └─ BindPose "Rest"
```

### 2. ASI File Parsing

Add `.asi` to supported file types, handled by the existing `inspect` action (same as `.agr`, `.agf`, etc.).

**ASI file format:** The ASI uses the same Enfusion text format as AGR/AGF. Top-level block is `AnimSetInstance`. Inside it, animation mappings are stored as named blocks of type `AnimSetInstanceSource_AnimationGroup` (mirroring the AST's `AnimSetTemplateSource_AnimationGroup`). Each group contains `AnimationNames` (string array of abstract names) and `ColumnInstances` blocks that map column+anim combinations to `.anm` file resource paths. The parser extracts group names, column names, animation names, and their resolved `.anm` paths.

**Parsed data:**
- Each mapping: `group.column.anim` -> `.anm` file path
- Count of filled vs total slots (when AST is available for cross-reference)
- Unmapped slots flagged explicitly

**Output example:**

```
=== ASI Summary ===

Mappings (24 of 30 slots filled, 6 unmapped):

  Group: Locomotion
    Locomotion.Erc.Idle -> Anims/Characters/idle_erc.anm
    Locomotion.Erc.WalkF -> Anims/Characters/walk_fwd_erc.anm
    Locomotion.Erc.WalkB -> (unmapped)

  Group: Actions
    Actions.Default.Reload -> Anims/Weapons/reload_mag.anm
```

### 3. Graph Validation

New `validate` action on `animation_graph_inspect`. The `path` parameter must point to the AGF file being validated. The `agrPath` parameter provides the AGR for cross-reference checks (V06, V07, V10). The `asiPath` parameter enables V13 checks. If `agrPath` is omitted, cross-reference checks that require it are skipped (not errors).

**Validation checks:**

| ID | Check | Severity | Description |
|---|---|---|---|
| V01 | Integer Duration | Error | Transition `Duration` is integer (e.g., `0`) instead of decimal (`0.0`) |
| V02 | Missing PostEval | Warning | Transition condition uses `RemainingTimeLess`, `IsEvent`, `IsTag`, `GetLowerTime`, `LowerNTimePassed`, `GetRemainingTime`, `GetEventTime`, `GetLowerRTime` without PostEval enabled |
| V03 | No catch-all state | Warning | StateMachine has no state with `StartCondition "1"` as the last state |
| V04 | Duplicate node names | Error | Two nodes in the same sheet share a name |
| V05 | Orphan nodes | Warning | Node not referenced as child by any other node and is not the root Queue |
| V06 | DefaultRunNode mismatch | Error | AGR `DefaultRunNode` value doesn't match any Queue node name in the AGF |
| V07 | AGF not registered | Error | AGF file not listed in AGR `GraphFilesResourceNames` |
| V08 | 2-part Source format | Error | Source node uses `"Group.Anim"` instead of `"Group.Column.Anim"` — fails silently at runtime |
| V09 | $Time in ProcTransform | Error | ProcTransform Amount expression contains `$Time` — should be `GetUpperRTime()` |
| V10 | IK chain mismatch | Warning | IK2 node references a chain name not defined in AGR `IkChains` |
| V11 | BlendN threshold order | Error | Thresholds not ordered lowest-to-highest |
| V12 | State Time mode mismatch | Warning | State uses `Notime` but child is not a StateMachine, or nested StateMachine under non-Notime state |

**Cross-reference checks (when asiPath provided):**

| ID | Check | Severity | Description |
|---|---|---|---|
| V13 | Unmapped Source animation | Warning | Source node references a `group.column.anim` that has no mapping in the ASI |

**Output format:**

```
=== Validation Report ===

2 errors, 3 warnings

[ERROR] V01: Transition "Idle -> Walk": Duration is integer (0) -- must be decimal (0.0)
[ERROR] V08: Source "ReloadAnim": uses 2-part format "Actions.Reload" -- needs 3-part "Actions.Column.Reload"
[WARN]  V03: StateMachine "LocomotionSM": no catch-all state (StartCondition "1")
[WARN]  V02: Transition "Walk -> Run": condition uses RemainingTimeLess() but PostEval is not enabled
[WARN]  V05: Node "OldBlend" is orphaned -- not referenced by any parent node

=== PASSED (0 errors) ===  or  === FAILED (N errors) ===
```

### 4. Suggest Action (animation_graph_setup)

New `suggest` action that analyzes an existing graph and recommends improvements.

**Suggestion categories:**

| Category | What it detects | Recommendation |
|---|---|---|
| Performance | Blend nodes without `Optimization` flag that have variable-driven weights | Enable Optimization to skip branches at 0% influence |
| Smoothing | Instant transitions (Duration 0.0) between locomotion states | Use Duration 0.2-0.3 with S or SStart blend function |
| Flexibility | ProcTransform Amount with hardcoded values | Extract to AGR variable for runtime control |
| IK completeness | TwoBoneSolver without PoleSolver companion | Add PoleSolver to control knee/elbow direction |
| Robustness | Queue items without InterruptExpr | Add interrupt condition to prevent stuck items |
| Architecture | AGR bone masks contain groups named with turret/chassis/hull/body keywords, or IK chains suggest upper/lower body split, but no BufferSave/Use nodes exist in the AGF | Suggest turret decoupling pattern |
| Sync | Locomotion transitions without `GetLowerTime()` in StartTime | Sync animation cycles on transition |

Each suggestion includes: what was found, why it matters, and a code snippet showing the fix.

### 5. Guide Action (animation_graph_setup)

New `guide` action with preset-based guidance.

**Presets:**

**`vehicle`** — Existing behavior, unchanged. Generates AGR/AST scaffold + Workbench instructions.

**`character`** — Returns guidance for:
- AGR variables needed: Speed, MoveDir, Stance, AimX, AimY, WeaponType, IsAiming, etc.
- AGR commands: Death, Hit, Reload, ThrowGrenade, Melee
- AGR IK chains: left/right leg (foot IK), left/right arm (hand IK), spine (aim IK)
- AGR bone masks: upper body, lower body, spine, head
- AGF layout: master Queue -> locomotion SM (idle/walk/run/sprint per stance) + aim overlay (BlendTAdd) + action queue items (reload, throw) + IK pipeline (IK2Target -> IK2Plane -> IKLock -> IK2)
- Prefab wiring: MeshObject, AnimationControllerComponent, RagdollComponent, CharacterAnimationComponent

**`weapon`** — Returns guidance for:
- AGR variables: FireMode, MagCount, SafetyOn
- AGR commands: Fire, Reload, Inspect, SafetyToggle
- AGF layout: master Queue with queue items per action -> Source nodes per animation
- AST/ASI structure for weapon animation variants

**`prop`** — Returns guidance for:
- Simple ProcTransform graphs (spinning, oscillating, bobbing)
- AGR variable for runtime speed control
- Confirmed working patterns from knowledge base (spin, tumble, multi-axis)
- BaseItemAnimationComponent prefab wiring

**`custom`** — Returns a structured questionnaire (what bones, what states, what inputs, what IK needs) as a single response. The LLM interprets the answers and calls `guide` again with the appropriate preset or combines guidance from multiple presets. This is single-request/single-response — the tool returns the questionnaire, and the LLM handles the multi-turn interaction with the user before making a second tool call.

### 6. Tool Interface

**`animation_graph_inspect` parameter changes:**

```typescript
inputSchema: {
  path: z.string(),           // existing
  source: z.enum(["mod", "game"]).default("mod"),  // existing
  projectPath: z.string().optional(),              // existing
  action: z.enum(["inspect", "validate"]).default("inspect"),  // NEW
  agrPath: z.string().optional(),  // NEW - for validate cross-reference
  asiPath: z.string().optional(),  // NEW - for ASI cross-reference
}
```

Supported extensions: `.agr`, `.agf`, `.ast`, `.asi`, `.aw` (`.asi` is new).

**`animation_graph_setup` parameter changes:**

```typescript
inputSchema: {
  action: z.enum(["setup", "suggest", "guide"]).default("setup"),  // NEW
  // For "guide" action:
  preset: z.enum(["vehicle", "character", "weapon", "prop", "custom"]).optional(),
  // For "suggest" action:
  agrPath: z.string().optional(),  // AGR path to analyze
  agfPath: z.string().optional(),  // corresponding AGF
  // Existing vehicle params (for "setup" action):
  vehicleName: z.string().optional(),
  vehicleType: z.string().optional(),
  // ... rest unchanged
}
```

**`animation_graph_author`** — no changes.

### 7. Implementation Notes

- The deep AGF parser is the foundation — validation and suggest both depend on it producing a structured in-memory representation (not just formatted text).
- Internal representation should be a typed node tree: `ParsedNode { type, name, properties, children, editorPos }` with type-specific property interfaces.
- Validation checks operate on this tree, not on raw text.
- Suggest also operates on the tree + AGR parsed data.
- Guide presets are static knowledge, compiled from the knowledge base patterns into structured response templates.
- The existing parser helpers (`extractBlocks`, `extractProp`, `extractStringArray`) are reusable but will need additional helpers for nested structures (QueueItems inside Queue, States inside StateMachine, BoneItems inside ProcTransform).
- The deep parser module should be a shared internal module (e.g., `src/animation/parser.ts`) imported by both `animation-graph-inspect` and `animation-graph-setup` (for the `suggest` action). This avoids duplicating parser code across tools.
- **Error resilience:** Malformed or binary files are caught by the existing try/catch in the tool handler. The parser itself should be tolerant of missing properties (return `null`/defaults) rather than throwing. If a file parses to zero nodes, the inspect action returns an empty summary; the validate action reports "0 errors, 0 warnings" (a valid empty graph is not an error).
- **Empty graphs:** Validation of a graph with 0 nodes returns PASSED with a note: "Graph contains no nodes."

### 8. Non-Goals

- AGF file generation (writing node graphs programmatically)
- Code duplication fix between `animation-graph-author.ts` and `animation-graph-setup.ts` (C6 issue — separate refactor)
- IDA reverse engineering for Animation Editor Workbench APIs (follow-up session)
- Particle effects tooling (separate design)
- Workbench live integration (reading graph state at runtime)
- Changes to `animation_graph_author`
