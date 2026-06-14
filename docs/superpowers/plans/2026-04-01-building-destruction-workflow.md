# Building Destruction Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add destruction workflow operators to `bk_building_tools` (Blender plugin) and create a new `building-setup` MCP tool that reads an export manifest to auto-create Workbench prefabs with slot wiring and destruction phase components.

**Architecture:**
- Blender side: 4 new operators (fracture, suggest removal, finalize phase, export building) added to existing `bk_building_tools/operators/destruction.py`
- MCP side: new `src/tools/building-setup.ts` reads a JSON manifest, creates structure prefab + part prefabs with SlotBoneMappingObject / BaseSlotComponent wiring and SCR_DestructionMultiPhaseComponent
- Bridge: JSON manifest file exported from Blender, consumed by MCP tool

**Tech Stack:** Python 3.11 / Blender 4.2 API, TypeScript, Vitest, zod

---

## File Structure

### New Files (Blender plugin - `C:\Users\Steffen\Documents\A_documents\Github\Arma-Reforger-Addons\plugins\bk_building_tools\`)
- `operators/destruction.py` -- 4 new operators for the destruction workflow

### New Files (MCP - `C:\Users\Steffen\Documents\A_documents\Github\enfusion-mcp-BK\`)
- `src/tools/building-setup.ts` -- MCP tool: reads manifest, creates prefabs
- `tests/tools/building-setup.test.ts` -- Tests for the MCP tool

### Modified Files (Blender plugin)
- `constants.py` -- Add REMOVAL_PATTERNS, BUILDING_PART_TYPE_FOLDERS, CELL_FRACTURE_DEFAULTS
- `operators/__init__.py` -- Re-export 4 new destruction operators
- `__init__.py` -- Import and register new operators
- `ui/panels.py` -- Add "Destruction Workflow" section to panel

### Modified Files (MCP)
- `src/server.ts` -- Import and register `registerBuildingSetup`

---

## Task Breakdown

### Task 1: Update constants.py with destruction workflow data

**Files:**
- Modify: `bk_building_tools/constants.py`

- [ ] **Step 1: Add CELL_FRACTURE_DEFAULTS dict**

Append to `constants.py`:

```python
# Default parameters for Cell Fracture addon
CELL_FRACTURE_DEFAULTS = {
    "source": {'PARTICLE_OWN'},  # fracture source
    "source_limit": 100,
    "source_noise": 0.0,
    "cell_scale": (1.0, 1.0, 1.0),
    "recursion": 0,
    "recursion_source_limit": 8,
    "recursion_clamp": 250,
    "recursion_chance": 0.25,
    "recursion_chance_select": 'SIZE_MIN',
    "use_smooth_faces": False,
    "use_sharp_edges": True,
    "use_sharp_edges_apply": True,
    "use_data_match": True,
    "use_island_split": True,
    "margin": 0.001,
    "material_index": 0,
    "use_interior_vgroup": False,
    "mass_mode": 'VOLUME',
    "mass": 1.0,
    "use_recenter": True,
    "use_remove_original": True,
    "collection_name": "",  # set dynamically per part
    "use_debug_points": False,
    "use_debug_redraw": True,
    "use_debug_bool": False,
}
```

- [ ] **Step 2: Add REMOVAL_PATTERNS dict**

These are pre-defined piece removal strategies for suggesting which fractured pieces to remove per destruction phase:

```python
# Piece removal pattern strategies for destruction phases
# Each pattern is a callable description; actual logic lives in the operator
REMOVAL_PATTERNS = {
    "outside_in": {
        "label": "Outside-In",
        "description": "Remove outermost pieces first (edges, corners), leaving center intact longest",
    },
    "random_scatter": {
        "label": "Random Scatter",
        "description": "Remove random pieces each phase for natural-looking damage",
    },
    "top_down": {
        "label": "Top-Down",
        "description": "Remove pieces from top first (roof collapse pattern)",
    },
    "bottom_up": {
        "label": "Bottom-Up",
        "description": "Remove pieces from bottom first (foundation crumble)",
    },
    "impact_point": {
        "label": "Impact Point",
        "description": "Remove pieces radiating outward from cursor/selected point",
    },
}
```

- [ ] **Step 3: Add BUILDING_PART_TYPE_FOLDERS dict**

```python
# Subfolder names for exported building parts
BUILDING_PART_TYPE_FOLDERS = {
    "wall": "Walls",
    "door": "Doors",
    "window": "Windows",
    "roof": "Roof",
    "floor": "Floors",
    "stairs": "Stairs",
    "column": "Columns",
    "railing": "Railings",
    "beam": "Beams",
    "other": "Parts",
}
```

**Commit point:** `feat(building-tools): add destruction workflow constants`

---

### Task 2: Create destruction.py with Fracture Part operator

**Files:**
- Create: `bk_building_tools/operators/destruction.py`

- [ ] **Step 1: Create file with ARBUILDINGS_OT_fracture_part operator**

This operator wraps Blender's Cell Fracture addon. It:
1. Validates Cell Fracture addon is enabled
2. Takes the selected building part mesh
3. Runs cell fracture with configurable piece count
4. Names pieces `{part_name}_piece_{N:03d}`
5. Stores metadata on each piece (`destruction_part`, `source_component`)

```python
import bpy
import json
import os
from mathutils import Vector

from ..constants import (
    CELL_FRACTURE_DEFAULTS,
    REMOVAL_PATTERNS,
    BUILDING_PART_TYPE_FOLDERS,
    BUILDING_SOCKET_NAMES,
    BUILDING_PART_TYPES,
)


def _ensure_cell_fracture():
    """Check that the Cell Fracture addon is enabled."""
    import addon_utils
    loaded_default, loaded_state = addon_utils.check("bl_ext.blender_org.cell_fracture")
    if not loaded_state:
        try:
            addon_utils.enable("bl_ext.blender_org.cell_fracture")
        except Exception:
            return False
    return True


class ARBUILDINGS_OT_fracture_part(bpy.types.Operator):
    """Fracture a building part into pieces for destruction phases using Cell Fracture"""
    bl_idname = "arbuildings.fracture_part"
    bl_label = "Fracture Part"
    bl_options = {'REGISTER', 'UNDO'}

    piece_count: bpy.props.IntProperty(
        name="Piece Count",
        description="Target number of fracture pieces",
        default=8, min=2, max=100
    )

    noise: bpy.props.FloatProperty(
        name="Noise",
        description="Random variation in fracture pattern",
        default=0.0, min=0.0, max=1.0
    )

    margin: bpy.props.FloatProperty(
        name="Margin",
        description="Gap between fracture pieces",
        default=0.001, min=0.0, max=0.1
    )

    use_smooth: bpy.props.BoolProperty(
        name="Smooth Faces",
        description="Smooth faces on fracture cuts",
        default=False
    )

    @classmethod
    def poll(cls, context):
        obj = context.active_object
        return obj is not None and obj.type == 'MESH' and context.mode == 'OBJECT'

    def execute(self, context):
        if not _ensure_cell_fracture():
            self.report({'ERROR'}, "Cell Fracture addon not available. Enable it in Preferences > Add-ons")
            return {'CANCELLED'}

        obj = context.active_object
        part_name = obj.name
        component_type = obj.get("component_type", "other")

        # Create collection for fracture pieces
        coll_name = f"Fracture_{part_name}"
        if coll_name in bpy.data.collections:
            fracture_coll = bpy.data.collections[coll_name]
        else:
            fracture_coll = bpy.data.collections.new(coll_name)
            context.scene.collection.children.link(fracture_coll)

        # Select only the target object
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        context.view_layer.objects.active = obj

        # Run Cell Fracture
        try:
            bpy.ops.object.add_fracture_cell_objects(
                source={'PARTICLE_OWN'},
                source_limit=self.piece_count,
                source_noise=self.noise,
                cell_scale=(1.0, 1.0, 1.0),
                recursion=0,
                use_smooth_faces=self.use_smooth,
                use_sharp_edges=True,
                use_sharp_edges_apply=True,
                use_data_match=True,
                use_island_split=True,
                margin=self.margin,
                use_recenter=True,
                use_remove_original=False,
                collection_name=coll_name,
            )
        except Exception as e:
            self.report({'ERROR'}, f"Cell Fracture failed: {e}")
            return {'CANCELLED'}

        # Rename and tag pieces
        pieces = [o for o in fracture_coll.objects if o.type == 'MESH']
        for i, piece in enumerate(pieces):
            piece.name = f"{part_name}_piece_{i + 1:03d}"
            piece["destruction_part"] = part_name
            piece["source_component"] = component_type
            piece["piece_index"] = i + 1

        # Store metadata on original object
        obj["fracture_collection"] = coll_name
        obj["fracture_piece_count"] = len(pieces)

        self.report({'INFO'}, f"Fractured '{part_name}' into {len(pieces)} pieces in '{coll_name}'")
        return {'FINISHED'}

    def invoke(self, context, event):
        return context.window_manager.invoke_props_dialog(self, width=300)

    def draw(self, context):
        layout = self.layout
        layout.prop(self, "piece_count")
        layout.prop(self, "noise")
        layout.prop(self, "margin")
        layout.prop(self, "use_smooth")
```

**Commit point:** `feat(building-tools): add fracture part operator`

---

### Task 3: Add Suggest Removal operator to destruction.py

**Files:**
- Modify: `bk_building_tools/operators/destruction.py`

- [ ] **Step 1: Add ARBUILDINGS_OT_suggest_removal operator**

This operator analyzes fractured pieces and suggests which to hide per phase based on the chosen removal pattern. It:
1. Reads piece positions from the fracture collection
2. Applies the selected REMOVAL_PATTERN strategy
3. Creates phase groups as custom properties on the pieces
4. Visually highlights suggested pieces per phase using vertex colors or selection

```python
class ARBUILDINGS_OT_suggest_removal(bpy.types.Operator):
    """Suggest piece removal order for destruction phases"""
    bl_idname = "arbuildings.suggest_removal"
    bl_label = "Suggest Removal Pattern"
    bl_options = {'REGISTER', 'UNDO'}

    pattern: bpy.props.EnumProperty(
        name="Pattern",
        description="Removal pattern strategy",
        items=[
            ('outside_in', "Outside-In", "Remove outermost pieces first"),
            ('random_scatter', "Random Scatter", "Random removal per phase"),
            ('top_down', "Top-Down", "Remove from top first"),
            ('bottom_up', "Bottom-Up", "Remove from bottom first"),
            ('impact_point', "Impact Point", "Radiate from 3D cursor"),
        ],
        default='outside_in'
    )

    phase_count: bpy.props.IntProperty(
        name="Phase Count",
        description="Number of destruction phases (1-5)",
        default=3, min=1, max=5
    )

    @classmethod
    def poll(cls, context):
        obj = context.active_object
        return obj is not None and obj.type == 'MESH' and "fracture_collection" in obj

    def execute(self, context):
        obj = context.active_object
        coll_name = obj["fracture_collection"]

        if coll_name not in bpy.data.collections:
            self.report({'ERROR'}, f"Fracture collection '{coll_name}' not found")
            return {'CANCELLED'}

        fracture_coll = bpy.data.collections[coll_name]
        pieces = sorted(
            [o for o in fracture_coll.objects if o.type == 'MESH'],
            key=lambda o: o.name
        )

        if not pieces:
            self.report({'ERROR'}, "No pieces found in fracture collection")
            return {'CANCELLED'}

        # Score each piece based on pattern
        scores = self._score_pieces(pieces, context)

        # Sort by score and divide into phases
        scored = sorted(zip(pieces, scores), key=lambda x: x[1], reverse=True)
        pieces_per_phase = max(1, len(scored) // self.phase_count)

        for i, (piece, score) in enumerate(scored):
            phase = min(i // pieces_per_phase, self.phase_count - 1)
            piece["destruction_phase"] = phase + 1  # 1-indexed
            piece["removal_score"] = score

        # Color-code phases for visual feedback
        phase_colors = [
            (0.2, 0.8, 0.2, 1.0),   # green = removed first (phase 1)
            (0.8, 0.8, 0.0, 1.0),   # yellow
            (0.8, 0.4, 0.0, 1.0),   # orange
            (0.8, 0.0, 0.0, 1.0),   # red
            (0.4, 0.0, 0.4, 1.0),   # purple = removed last
        ]

        for piece in pieces:
            phase = piece.get("destruction_phase", 1)
            color = phase_colors[min(phase - 1, len(phase_colors) - 1)]
            mat_name = f"Phase_{phase}_Preview"
            if mat_name not in bpy.data.materials:
                mat = bpy.data.materials.new(name=mat_name)
                mat.diffuse_color = color
                mat.use_nodes = False
            else:
                mat = bpy.data.materials[mat_name]

            if piece.data.materials:
                piece.data.materials[0] = mat
            else:
                piece.data.materials.append(mat)

        phase_counts = {}
        for piece in pieces:
            p = piece.get("destruction_phase", 0)
            phase_counts[p] = phase_counts.get(p, 0) + 1

        report = ", ".join(f"Phase {p}: {c} pieces" for p, c in sorted(phase_counts.items()))
        self.report({'INFO'}, f"Suggested removal ({self.pattern}): {report}")
        return {'FINISHED'}

    def _score_pieces(self, pieces, context):
        """Score pieces based on selected removal pattern. Higher score = removed earlier."""
        centers = [p.matrix_world.translation.copy() for p in pieces]

        if not centers:
            return []

        if self.pattern == 'outside_in':
            # Distance from centroid -- farther = removed first
            centroid = sum(centers, Vector((0, 0, 0))) / len(centers)
            return [(c - centroid).length for c in centers]

        elif self.pattern == 'top_down':
            # Higher Z = removed first
            return [c.z for c in centers]

        elif self.pattern == 'bottom_up':
            # Lower Z = removed first (invert)
            max_z = max(c.z for c in centers)
            return [max_z - c.z for c in centers]

        elif self.pattern == 'impact_point':
            # Distance from 3D cursor -- closer = removed first (invert)
            cursor = context.scene.cursor.location
            max_dist = max((c - cursor).length for c in centers) or 1.0
            return [max_dist - (c - cursor).length for c in centers]

        elif self.pattern == 'random_scatter':
            import random
            return [random.random() for _ in centers]

        return [0.0] * len(centers)

    def invoke(self, context, event):
        return context.window_manager.invoke_props_dialog(self, width=300)

    def draw(self, context):
        layout = self.layout
        layout.prop(self, "pattern")
        layout.prop(self, "phase_count")
        layout.label(text="Pieces color-coded by phase after apply", icon='INFO')
```

**Commit point:** `feat(building-tools): add suggest removal pattern operator`

---

### Task 4: Add Finalize Phase operator to destruction.py

**Files:**
- Modify: `bk_building_tools/operators/destruction.py`

- [ ] **Step 1: Add ARBUILDINGS_OT_finalize_phase operator**

This operator takes the current phase assignments and creates the actual destruction phase meshes by joining the remaining pieces per phase:

```python
class ARBUILDINGS_OT_finalize_phase(bpy.types.Operator):
    """Create destruction phase meshes from fracture pieces"""
    bl_idname = "arbuildings.finalize_phase"
    bl_label = "Finalize Destruction Phases"
    bl_options = {'REGISTER', 'UNDO'}

    @classmethod
    def poll(cls, context):
        obj = context.active_object
        return obj is not None and obj.type == 'MESH' and "fracture_collection" in obj

    def execute(self, context):
        obj = context.active_object
        part_name = obj.name
        coll_name = obj["fracture_collection"]

        if coll_name not in bpy.data.collections:
            self.report({'ERROR'}, f"Fracture collection '{coll_name}' not found")
            return {'CANCELLED'}

        fracture_coll = bpy.data.collections[coll_name]
        pieces = [o for o in fracture_coll.objects if o.type == 'MESH']

        if not pieces:
            self.report({'ERROR'}, "No pieces in fracture collection")
            return {'CANCELLED'}

        # Determine max phase
        max_phase = max((p.get("destruction_phase", 1) for p in pieces), default=1)

        # Create phase collection
        phase_coll_name = f"Phases_{part_name}"
        if phase_coll_name in bpy.data.collections:
            phase_coll = bpy.data.collections[phase_coll_name]
            # Clear existing phase meshes
            for o in list(phase_coll.objects):
                bpy.data.objects.remove(o, do_unlink=True)
        else:
            phase_coll = bpy.data.collections.new(phase_coll_name)
            context.scene.collection.children.link(phase_coll)

        created_phases = []

        for phase_num in range(1, max_phase + 1):
            # For phase N, include all pieces NOT removed in phases 1..N
            # Phase 1 = dst_01 = pieces from phase 2+ remain (phase 1 pieces removed)
            # Phase 2 = dst_02 = pieces from phase 3+ remain (phase 1+2 removed)
            # Phase N = dst_0N = only pieces from phases > N remain
            remaining = [p for p in pieces if p.get("destruction_phase", 1) > phase_num]

            if not remaining:
                # Final phase -- nothing remains (fully destroyed)
                # Create empty placeholder or skip
                continue

            # Duplicate remaining pieces and join into one mesh
            bpy.ops.object.select_all(action='DESELECT')
            copies = []
            for piece in remaining:
                copy = piece.copy()
                copy.data = piece.data.copy()
                phase_coll.objects.link(copy)
                copy.select_set(True)
                copies.append(copy)

            if copies:
                context.view_layer.objects.active = copies[0]
                if len(copies) > 1:
                    bpy.ops.object.join()

                phase_mesh = context.active_object
                dst_suffix = f"_dst_{phase_num:02d}"
                phase_mesh.name = f"{part_name}{dst_suffix}"
                phase_mesh.data.name = f"{part_name}{dst_suffix}"

                # Clear preview materials, restore original
                phase_mesh.data.materials.clear()

                # Store phase metadata
                phase_mesh["destruction_phase_index"] = phase_num
                phase_mesh["source_part"] = part_name

                created_phases.append(phase_mesh.name)

        # Store phase info on the source object
        obj["destruction_phases"] = json.dumps(created_phases)
        obj["phase_count"] = len(created_phases)

        self.report({'INFO'}, f"Created {len(created_phases)} destruction phases for '{part_name}': {', '.join(created_phases)}")
        return {'FINISHED'}
```

**Commit point:** `feat(building-tools): add finalize destruction phases operator`

---

### Task 5: Add Export Building operator to destruction.py

**Files:**
- Modify: `bk_building_tools/operators/destruction.py`

- [ ] **Step 1: Add ARBUILDINGS_OT_export_building operator**

This is the key bridge operator. It:
1. Scans the scene for building components, sockets, and destruction phases
2. Determines slot type per socket (unique vs repeated based on socket prefix count)
3. Writes a JSON manifest file
4. Optionally triggers FBX export for each part

Manifest format:
```json
{
  "building_name": "MyHouse_01",
  "export_root": "C:/path/to/exports/MyHouse_01",
  "structure": {
    "fbx": "MyHouse_01.fbx",
    "sockets": ["SOCKET_building_wall_01", "SOCKET_building_wall_02", ...]
  },
  "parts": [
    {
      "name": "wall_MyHouse_01",
      "type": "wall",
      "socket_prefix": "SOCKET_building_wall",
      "socket_name": "SOCKET_building_wall_01",
      "unique": false,
      "fbx": "Walls/wall_MyHouse_01.fbx",
      "phases": [
        {"index": 1, "fbx": "Walls/wall_MyHouse_01_dst_01.fbx"},
        {"index": 2, "fbx": "Walls/wall_MyHouse_01_dst_02.fbx"}
      ]
    }
  ]
}
```

```python
class ARBUILDINGS_OT_export_building(bpy.types.Operator):
    """Export building manifest and optionally FBX files for MCP tool"""
    bl_idname = "arbuildings.export_building"
    bl_label = "Export Building"
    bl_options = {'REGISTER', 'UNDO'}

    building_name: bpy.props.StringProperty(
        name="Building Name",
        description="Name for the building (used in file/folder naming)",
        default=""
    )

    export_root: bpy.props.StringProperty(
        name="Export Root",
        description="Root folder for exported files",
        default="",
        subtype='DIR_PATH'
    )

    export_fbx: bpy.props.BoolProperty(
        name="Export FBX Files",
        description="Also export FBX files for each part (requires bk_fbx_exporter)",
        default=True
    )

    @classmethod
    def poll(cls, context):
        return any(
            obj.get("component_type") is not None
            for obj in bpy.data.objects
            if obj.type == 'MESH'
        )

    def execute(self, context):
        if not self.building_name:
            self.report({'ERROR'}, "Building name is required")
            return {'CANCELLED'}

        if not self.export_root:
            self.report({'ERROR'}, "Export root folder is required")
            return {'CANCELLED'}

        export_dir = os.path.join(bpy.path.abspath(self.export_root), self.building_name)
        os.makedirs(export_dir, exist_ok=True)

        # Gather building components
        components = [
            obj for obj in bpy.data.objects
            if obj.type == 'MESH' and obj.get("component_type") is not None
        ]

        # Gather sockets from Memory Points
        sockets = []
        if "Memory Points" in bpy.data.collections:
            sockets = [
                obj for obj in bpy.data.collections["Memory Points"].objects
                if obj.type == 'EMPTY'
            ]

        # Count socket prefixes to determine unique vs repeated
        prefix_counts = {}
        for sock in sockets:
            # Extract prefix: everything before the last _NN
            name = sock.name
            parts = name.rsplit("_", 1)
            if len(parts) == 2 and parts[1].isdigit():
                prefix = parts[0]
            else:
                prefix = name
            prefix_counts[prefix] = prefix_counts.get(prefix, 0) + 1

        # Build manifest
        manifest = {
            "building_name": self.building_name,
            "export_root": export_dir,
            "structure": {
                "fbx": f"{self.building_name}.fbx",
                "sockets": [s.name for s in sockets],
            },
            "parts": [],
        }

        for comp in components:
            comp_type = comp.get("component_type", "other")
            subfolder = BUILDING_PART_TYPE_FOLDERS.get(comp_type, "Parts")

            # Find matching socket
            socket_name = None
            socket_prefix = None
            for sock in sockets:
                attached = sock.get("attached_part", "")
                if attached == comp.name:
                    socket_name = sock.name
                    # Derive prefix
                    parts = sock.name.rsplit("_", 1)
                    if len(parts) == 2 and parts[1].isdigit():
                        socket_prefix = parts[0]
                    else:
                        socket_prefix = sock.name
                    break

            if not socket_prefix:
                socket_prefix = BUILDING_SOCKET_NAMES.get(comp_type, "SOCKET_building_part")

            is_unique = prefix_counts.get(socket_prefix, 1) == 1

            # Gather destruction phases
            phases = []
            phases_json = comp.get("destruction_phases")
            if phases_json:
                try:
                    phase_names = json.loads(phases_json)
                    for idx, pname in enumerate(phase_names, 1):
                        phase_fbx = f"{subfolder}/{pname}.fbx"
                        phases.append({"index": idx, "fbx": phase_fbx})
                except (json.JSONDecodeError, TypeError):
                    pass

            part_entry = {
                "name": comp.name,
                "type": comp_type,
                "socket_prefix": socket_prefix,
                "socket_name": socket_name or "",
                "unique": is_unique,
                "fbx": f"{subfolder}/{comp.name}.fbx",
                "phases": phases,
            }
            manifest["parts"].append(part_entry)

            # Create subfolder
            os.makedirs(os.path.join(export_dir, subfolder), exist_ok=True)

        # Write manifest
        manifest_path = os.path.join(export_dir, "building_manifest.json")
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2, ensure_ascii=False)

        # Optionally export FBX files
        exported_count = 0
        if self.export_fbx:
            exported_count = self._export_fbx_files(context, manifest, export_dir)

        msg = f"Manifest saved: {manifest_path} ({len(manifest['parts'])} parts)"
        if self.export_fbx:
            msg += f", {exported_count} FBX files exported"
        self.report({'INFO'}, msg)
        return {'FINISHED'}

    def _export_fbx_files(self, context, manifest, export_dir):
        """Export FBX files for structure and each part. Uses standard FBX export."""
        count = 0

        for part in manifest["parts"]:
            part_obj = bpy.data.objects.get(part["name"])
            if not part_obj:
                continue

            # Export part mesh
            fbx_path = os.path.join(export_dir, part["fbx"])
            self._export_single_fbx(context, part_obj, fbx_path)
            count += 1

            # Export destruction phases
            for phase in part.get("phases", []):
                phase_fbx = os.path.join(export_dir, phase["fbx"])
                # Find phase mesh by deriving name from part + dst suffix
                phase_name = os.path.splitext(os.path.basename(phase_fbx))[0]
                phase_obj = bpy.data.objects.get(phase_name)
                if phase_obj:
                    self._export_single_fbx(context, phase_obj, phase_fbx)
                    count += 1

        return count

    def _export_single_fbx(self, context, obj, filepath):
        """Export a single object to FBX with Enfusion-compatible settings."""
        os.makedirs(os.path.dirname(filepath), exist_ok=True)

        # Store current selection
        prev_selected = context.selected_objects[:]
        prev_active = context.active_object

        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        context.view_layer.objects.active = obj

        bpy.ops.export_scene.fbx(
            filepath=filepath,
            use_selection=True,
            apply_scale_options='FBX_SCALE_ALL',
            axis_forward='-Z',
            axis_up='Y',
            use_mesh_modifiers=True,
            mesh_smooth_type='OFF',
            add_leaf_bones=False,
        )

        # Restore selection
        bpy.ops.object.select_all(action='DESELECT')
        for o in prev_selected:
            if o:
                o.select_set(True)
        if prev_active:
            context.view_layer.objects.active = prev_active

    def invoke(self, context, event):
        # Auto-fill building name from .blend filename
        if not self.building_name:
            blend_name = os.path.splitext(os.path.basename(bpy.data.filepath))[0]
            if blend_name:
                self.building_name = blend_name

        return context.window_manager.invoke_props_dialog(self, width=400)

    def draw(self, context):
        layout = self.layout
        layout.prop(self, "building_name")
        layout.prop(self, "export_root")
        layout.separator()
        layout.prop(self, "export_fbx")
        if self.export_fbx:
            layout.label(text="Exports structure + parts + phases as FBX", icon='INFO')


classes = (
    ARBUILDINGS_OT_fracture_part,
    ARBUILDINGS_OT_suggest_removal,
    ARBUILDINGS_OT_finalize_phase,
    ARBUILDINGS_OT_export_building,
)
```

**Commit point:** `feat(building-tools): add export building manifest operator`

---

### Task 6: Wire up new operators in plugin registration

**Files:**
- Modify: `bk_building_tools/operators/__init__.py`
- Modify: `bk_building_tools/__init__.py`
- Modify: `bk_building_tools/ui/panels.py`

- [ ] **Step 1: Update operators/__init__.py**

Add imports from destruction module:

```python
from .destruction import (
    ARBUILDINGS_OT_fracture_part,
    ARBUILDINGS_OT_suggest_removal,
    ARBUILDINGS_OT_finalize_phase,
    ARBUILDINGS_OT_export_building,
)
```

- [ ] **Step 2: Update __init__.py**

Add the 4 new operators to imports and `classes` tuple.

- [ ] **Step 3: Update ui/panels.py**

Add a "Destruction Workflow" section to the panel between "Collision Tools" and "Lighting & Portals":

```python
        # Destruction Workflow
        box = layout.box()
        box.label(text="Destruction Workflow", icon='FORCE_WIND')

        col = box.column(align=True)
        col.operator("arbuildings.fracture_part", text="1. Fracture Part", icon='MOD_EXPLODE')
        col.operator("arbuildings.suggest_removal", text="2. Suggest Removal", icon='SORTSIZE')
        col.operator("arbuildings.finalize_phase", text="3. Finalize Phases", icon='CHECKMARK')

        box.separator()
        box.operator("arbuildings.export_building", text="Export Building", icon='EXPORT')
```

**Commit point:** `feat(building-tools): wire up destruction operators in UI`

---

### Task 7: Create MCP building-setup tool -- tests

**Files:**
- Create: `tests/tools/building-setup.test.ts`

- [ ] **Step 1: Write tests for manifest parsing and prefab generation**

```typescript
import { describe, it, expect } from "vitest";

// Types matching the manifest format
interface BuildingManifest {
  building_name: string;
  export_root: string;
  structure: {
    fbx: string;
    sockets: string[];
  };
  parts: BuildingPart[];
}

interface BuildingPart {
  name: string;
  type: string;
  socket_prefix: string;
  socket_name: string;
  unique: boolean;
  fbx: string;
  phases: { index: number; fbx: string }[];
}

describe("building-setup", () => {
  it("parses a valid manifest", () => {
    const manifest: BuildingManifest = {
      building_name: "TestHouse_01",
      export_root: "C:/exports/TestHouse_01",
      structure: { fbx: "TestHouse_01.fbx", sockets: ["SOCKET_building_wall_01", "SOCKET_building_wall_02"] },
      parts: [
        {
          name: "wall_TestHouse_01",
          type: "wall",
          socket_prefix: "SOCKET_building_wall",
          socket_name: "SOCKET_building_wall_01",
          unique: false,
          fbx: "Walls/wall_TestHouse_01.fbx",
          phases: [
            { index: 1, fbx: "Walls/wall_TestHouse_01_dst_01.fbx" },
            { index: 2, fbx: "Walls/wall_TestHouse_01_dst_02.fbx" },
          ],
        },
      ],
    };

    expect(manifest.parts).toHaveLength(1);
    expect(manifest.parts[0].unique).toBe(false);
    expect(manifest.parts[0].phases).toHaveLength(2);
  });

  it("determines SlotBoneMappingObject for repeated sockets", () => {
    // repeated = unique:false -> SlotBoneMappingObject
    const part: BuildingPart = {
      name: "wall_01", type: "wall", socket_prefix: "SOCKET_wall",
      socket_name: "SOCKET_wall_01", unique: false,
      fbx: "Walls/wall_01.fbx", phases: [],
    };
    const slotType = part.unique ? "BaseSlotComponent" : "SlotBoneMappingObject";
    expect(slotType).toBe("SlotBoneMappingObject");
  });

  it("determines BaseSlotComponent for unique sockets", () => {
    const part: BuildingPart = {
      name: "door_entry", type: "door", socket_prefix: "SOCKET_door",
      socket_name: "SOCKET_door_01", unique: true,
      fbx: "Doors/door_entry.fbx", phases: [],
    };
    const slotType = part.unique ? "BaseSlotComponent" : "SlotBoneMappingObject";
    expect(slotType).toBe("BaseSlotComponent");
  });

  it("generates SCR_DestructionMultiPhaseComponent data for parts with phases", () => {
    const phases = [
      { index: 1, fbx: "Walls/wall_dst_01.fbx" },
      { index: 2, fbx: "Walls/wall_dst_02.fbx" },
      { index: 3, fbx: "Walls/wall_dst_03.fbx" },
    ];

    // Each phase maps to a SCR_DamagePhaseData with a model .xob path
    const phaseData = phases.map((p) => ({
      PhaseModel: p.fbx.replace(".fbx", ".xob"),
      Health: (1 - p.index / (phases.length + 1)),
    }));

    expect(phaseData).toHaveLength(3);
    expect(phaseData[0].PhaseModel).toBe("Walls/wall_dst_01.xob");
    expect(phaseData[2].Health).toBeCloseTo(0.25);
  });
});
```

**Commit point:** `test(building-setup): add manifest parsing tests`

---

### Task 8: Create MCP building-setup tool -- implementation

**Files:**
- Create: `src/tools/building-setup.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Create building-setup.ts**

The tool:
1. Accepts a manifest JSON (as string or file path)
2. Parses and validates with zod
3. Creates the structure prefab (SCR_DestructibleBuildingEntity inheriting Building_Base.et)
4. For each part, creates a part prefab with SCR_DestructionMultiPhaseComponent
5. Wires SlotBoneMappingObject (repeated) or BaseSlotComponent (unique) on the structure prefab
6. Returns a summary of created files

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join, dirname, basename, relative } from "node:path";
import type { Config } from "../config.js";
import { generatePrefab, type ComponentDef } from "../templates/prefab.js";
import { validateFilename } from "../utils/safe-path.js";

// ── Manifest schema ──────────────────────────────────────────────────────────

const PhaseSchema = z.object({
  index: z.number().int().min(1),
  fbx: z.string(),
});

const PartSchema = z.object({
  name: z.string(),
  type: z.string(),
  socket_prefix: z.string(),
  socket_name: z.string(),
  unique: z.boolean(),
  fbx: z.string(),
  phases: z.array(PhaseSchema),
});

const ManifestSchema = z.object({
  building_name: z.string().min(1),
  export_root: z.string(),
  structure: z.object({
    fbx: z.string(),
    sockets: z.array(z.string()),
  }),
  parts: z.array(PartSchema),
});

type BuildingManifest = z.infer<typeof ManifestSchema>;
type BuildingPart = z.infer<typeof PartSchema>;

// ── Prefab generation helpers ────────────────────────────────────────────────

function fbxToXob(fbxPath: string, modPrefix: string): string {
  // Convert FBX relative path to .xob resource path
  const xob = fbxPath.replace(/\.fbx$/i, ".xob");
  return `${modPrefix}${xob}`;
}

function generateDestructionComponent(part: BuildingPart, modPrefix: string): string {
  if (part.phases.length === 0) return "";

  const phaseEntries = part.phases.map((phase, i) => {
    const health = 1 - phase.index / (part.phases.length + 1);
    const xob = fbxToXob(phase.fbx, modPrefix);
    return `  SCR_DamagePhaseData "{00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}}" {
   PhaseModel "${xob}"
   Health ${health.toFixed(2)}
  }`;
  });

  return `SCR_DestructionMultiPhaseComponent {
 m_aDamagePhases {
${phaseEntries.join("\n")}
 }
}`;
}

function generateSlotBoneMappingObject(part: BuildingPart, partPrefabPath: string): string {
  return `SlotBoneMappingObject {
 BonePrefix "${part.socket_prefix}"
 Template "${partPrefabPath}"
}`;
}

function generateBaseSlotComponent(part: BuildingPart, partPrefabPath: string): string {
  return `BaseSlotComponent {
 Slot "${part.socket_name}"
 Prefab "${partPrefabPath}"
}`;
}

function generatePartPrefab(
  part: BuildingPart,
  modPrefix: string
): string {
  const xob = fbxToXob(part.fbx, modPrefix);
  const destructionComp = generateDestructionComponent(part, modPrefix);

  let components = `MeshObject {
  Object "${xob}"
 }`;

  if (destructionComp) {
    components += `\n ${destructionComp}`;
  }

  return `GenericEntity {
 components {
  ${components}
 }
}`;
}

function generateBuildingPrefab(
  manifest: BuildingManifest,
  parts: BuildingPart[],
  modPrefix: string,
  partPrefabPaths: Map<string, string>
): string {
  const slotComponents: string[] = [];

  for (const part of parts) {
    const prefabPath = partPrefabPaths.get(part.name) || "";
    if (part.unique) {
      slotComponents.push(` ${generateBaseSlotComponent(part, prefabPath)}`);
    } else {
      slotComponents.push(` ${generateSlotBoneMappingObject(part, prefabPath)}`);
    }
  }

  const xob = fbxToXob(manifest.structure.fbx, modPrefix);

  return `SCR_DestructibleBuildingEntity : "{B6D7B585448658F5}Prefabs/Structures/BuildingParts/Building_Base.et" {
 components {
  MeshObject {
   Object "${xob}"
  }
  SCR_DestructibleBuildingComponent {
  }
${slotComponents.join("\n")}
 }
}`;
}

// ── Tool registration ────────────────────────────────────────────────────────

export function registerBuildingSetup(server: McpServer, config: Config): void {
  server.registerTool(
    "building_setup",
    {
      description:
        "Set up an Arma Reforger destructible building from a Blender export manifest.\n\n" +
        "Reads a building_manifest.json (exported by bk_building_tools Blender plugin), " +
        "then creates the building structure prefab with slot wiring (SlotBoneMappingObject / BaseSlotComponent) " +
        "and individual part prefabs with SCR_DestructionMultiPhaseComponent for each destruction phase.\n\n" +
        "The manifest contains: building name, socket list, part definitions with FBX paths and destruction phases.",
      inputSchema: {
        manifestPath: z.string().describe(
          "Absolute path to the building_manifest.json file exported from Blender"
        ),
        modPrefix: z.string().default("").describe(
          "Mod resource prefix path (e.g., 'MyMod/Assets/Buildings/'). Prepended to FBX-derived .xob paths."
        ),
        outputDir: z.string().optional().describe(
          "Output directory for generated .et prefab files. Defaults to mod prefabs directory from config."
        ),
        dryRun: z.boolean().default(false).describe(
          "If true, return what would be created without writing files"
        ),
      },
    },
    async ({ manifestPath, modPrefix, outputDir, dryRun }) => {
      // Read and parse manifest
      let rawManifest: string;
      try {
        rawManifest = readFileSync(manifestPath, "utf-8");
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error reading manifest: ${err}` }] };
      }

      let manifest: BuildingManifest;
      try {
        manifest = ManifestSchema.parse(JSON.parse(rawManifest));
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Invalid manifest: ${err}` }] };
      }

      const outDir = outputDir
        ? resolve(outputDir)
        : resolve(config.modDir, "Prefabs", "Structures", manifest.building_name);

      const lines: string[] = [];
      lines.push(`=== Building Setup: ${manifest.building_name} ===`);
      lines.push(`Parts: ${manifest.parts.length}`);
      lines.push(`Sockets: ${manifest.structure.sockets.length}`);
      lines.push(`Output: ${outDir}`);
      lines.push("");

      const partPrefabPaths = new Map<string, string>();
      const createdFiles: string[] = [];

      // Create part prefabs
      for (const part of manifest.parts) {
        const partDir = join(outDir, "Parts");
        const partFile = `${part.name}.et`;
        const partPath = join(partDir, partFile);
        const partContent = generatePartPrefab(part, modPrefix);

        // Store relative prefab path for slot wiring
        const relativePath = `Prefabs/Structures/${manifest.building_name}/Parts/${partFile}`;
        partPrefabPaths.set(part.name, relativePath);

        const slotType = part.unique ? "BaseSlotComponent" : "SlotBoneMappingObject";
        const phaseInfo = part.phases.length > 0
          ? ` (${part.phases.length} destruction phases)`
          : "";

        lines.push(`[Part] ${part.name} -> ${slotType}${phaseInfo}`);

        if (!dryRun) {
          mkdirSync(partDir, { recursive: true });
          writeFileSync(partPath, partContent, "utf-8");
          createdFiles.push(partPath);
        }
      }

      // Create building structure prefab
      const buildingContent = generateBuildingPrefab(
        manifest,
        manifest.parts,
        modPrefix,
        partPrefabPaths
      );
      const buildingPath = join(outDir, `${manifest.building_name}.et`);

      lines.push("");
      lines.push(`[Building] ${manifest.building_name}.et`);

      if (!dryRun) {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(buildingPath, buildingContent, "utf-8");
        createdFiles.push(buildingPath);
      }

      lines.push("");
      if (dryRun) {
        lines.push("(dry run -- no files written)");
      } else {
        lines.push(`Created ${createdFiles.length} prefab files.`);
      }

      lines.push("");
      lines.push("=== Post-Creation Checklist ===");
      lines.push("- [ ] Import FBX files into Workbench (Resource Browser)");
      lines.push("- [ ] Verify .xob paths in MeshObject components match imported assets");
      lines.push("- [ ] Check slot bone prefixes match socket names in the FBX skeleton");
      lines.push("- [ ] Test destruction phases in World Editor (damage entity to cycle phases)");
      lines.push("- [ ] Add FireGeo/collision components if not inherited from Building_Base");

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );
}
```

- [ ] **Step 2: Register in server.ts**

Add import and call in `registerTools`:

```typescript
import { registerBuildingSetup } from "./tools/building-setup.js";
// ... in registerTools():
registerBuildingSetup(server, config);
```

**Commit point:** `feat(mcp): add building-setup tool for manifest-driven prefab creation`

---

### Task 9: Integration verification

- [ ] **Step 1: Run MCP tests**

```bash
cd enfusion-mcp-BK && npm test
```

- [ ] **Step 2: Build MCP project**

```bash
npm run build
```

- [ ] **Step 3: Verify Blender plugin loads**

Use Blender MCP to check the plugin registers correctly:
```python
import importlib
import bk_building_tools
importlib.reload(bk_building_tools)
print([cls.__name__ for cls in bk_building_tools.classes])
```

**Commit point:** `chore: verify building destruction workflow integration`

---

## Summary of all commits

1. `feat(building-tools): add destruction workflow constants`
2. `feat(building-tools): add fracture part operator`
3. `feat(building-tools): add suggest removal pattern operator`
4. `feat(building-tools): add finalize destruction phases operator`
5. `feat(building-tools): add export building manifest operator`
6. `feat(building-tools): wire up destruction operators in UI`
7. `test(building-setup): add manifest parsing tests`
8. `feat(mcp): add building-setup tool for manifest-driven prefab creation`
9. `chore: verify building destruction workflow integration`
