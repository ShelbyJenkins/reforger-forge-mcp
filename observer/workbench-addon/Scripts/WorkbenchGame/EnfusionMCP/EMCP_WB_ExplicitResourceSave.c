/**
 * EMCP_WB_ExplicitResourceSave.c - Save only a World Editor session whose
 * target was supplied at process startup with an immutable target marker.
 *
 * This handler deliberately does not try to discover the current document.
 * The host creates a fresh target-bound Workbench process and passes the same
 * canonical absolute .ent or .et path in the marker and expectedPath. A .ent
 * is loaded at process startup; a .et is opened through WorldEditor only after
 * the private helper endpoint is attested, because passing a prefab to -load
 * creates an unsaved temporary world. The exact process command line is
 * attested outside the NET API before this handler is called.
 */

class EMCP_WB_ExplicitResourceSaveRequest : JsonApiStruct
{
	string action;
	string expectedPath;
	// Repository acceptance only. No public MCP tool supplies this field; the
	// disposable live harness injects it through its raw test transport to
	// prove that a real Workbench-native modal taints the save session.
	bool testNativeModal;

	void EMCP_WB_ExplicitResourceSaveRequest()
	{
		RegV("action");
		RegV("expectedPath");
		RegV("testNativeModal");
	}
}

class EMCP_WB_ExplicitResourceSaveResponse : JsonApiStruct
{
	string status;
	string action;
	string message;
	string startupLoadPath;
	string openedResource;
	bool saved;

	void EMCP_WB_ExplicitResourceSaveResponse()
	{
		RegV("status");
		RegV("action");
		RegV("message");
		RegV("startupLoadPath");
		RegV("openedResource");
		RegV("saved");
	}
}

class EMCP_WB_ExplicitResourceSave : NetApiHandler
{
	override JsonApiStruct GetRequest()
	{
		return new EMCP_WB_ExplicitResourceSaveRequest();
	}

	override JsonApiStruct GetResponse(JsonApiStruct request)
	{
		EMCP_WB_ExplicitResourceSaveRequest req = EMCP_WB_ExplicitResourceSaveRequest.Cast(request);
		EMCP_WB_ExplicitResourceSaveResponse resp = new EMCP_WB_ExplicitResourceSaveResponse();
		resp.action = req.action;

		if (req.expectedPath == "")
		{
			resp.status = "error";
			resp.message = "expectedPath is required for an explicit target-bound save";
			return resp;
		}

		if (req.action != "probe" && req.action != "openPrefab" && req.action != "save")
		{
			resp.status = "error";
			resp.message = "Unknown explicit resource action: " + req.action + ". Valid actions: probe, openPrefab, save";
			return resp;
		}

		WorldEditor worldEditor = Workbench.GetModule(WorldEditor);
		if (!worldEditor)
		{
			resp.status = "error";
			resp.message = "WorldEditor module not available";
			return resp;
		}

		// WorldEditor.GetCmdLine does not expose built-in module arguments in
		// Workbench 1.7. The host has already re-read the exact owned process
		// command line, including the inert target marker. Echo the host-attested
		// expected path so its NET response can be tied to that verification
		// without pretending this is an active-document API.
		resp.startupLoadPath = req.expectedPath;

		ResourceManager resourceManager = Workbench.GetModule(ResourceManager);
		if (!resourceManager)
		{
			resp.status = "error";
			resp.message = "ResourceManager module not available";
			return resp;
		}
		MetaFile metaFile = resourceManager.GetMetaFile(req.expectedPath);
		if (!metaFile)
		{
			resp.status = "error";
			resp.message = "Resource metadata not found for the explicit target";
			return resp;
		}

		WorldEditorAPI api = worldEditor.GetApi();
		if (!api)
		{
			resp.status = "error";
			resp.message = "WorldEditorAPI not available (editor is not in edit mode)";
			return resp;
		}

		if (req.action == "probe")
		{
			resp.status = "ok";
			resp.message = "Explicit target launch and registered metadata verified";
			return resp;
		}

		if (req.action == "openPrefab")
		{
			// A prefab passed to Workbench -load is treated as an unsaved world.
			// Open the already-metadata-verified target only inside this fresh,
			// exact-marker session, then prove that the Prefab Edit root resolves
			// to the same resource identity before the host binds save authority.
			ResourceName expectedResource = metaFile.GetResourceID();
			if (!worldEditor.SetOpenedResource(expectedResource))
			{
				resp.status = "error";
				resp.message = "SetOpenedResource returned false for the explicit prefab target";
				return resp;
			}
			if (!worldEditor.IsPrefabEditMode() || api.GetEditorEntityCount() != 2)
			{
				resp.status = "error";
				resp.message = "Explicit prefab target did not enter the expected two-entity Prefab Edit Mode";
				return resp;
			}
			IEntitySource prefabSource = api.GetEditorEntity(1);
			if (!prefabSource)
			{
				resp.status = "error";
				resp.message = "Prefab Edit Mode did not expose its target entity source";
				return resp;
			}
			// The edit entity source itself has the generated instance name
			// (for example Sedan_Red1), not the prefab asset identity. Workbench's
			// own SCR_WorldEditorToolHelper resolves the active prefab through this
			// source's ancestor for exactly that reason.
			BaseContainer prefabAncestor = prefabSource.GetAncestor();
			if (!prefabAncestor)
			{
				resp.status = "error";
				resp.message = "Prefab Edit Mode target entity has no prefab resource ancestor";
				return resp;
			}
			ResourceName openedResource = prefabAncestor.GetResourceName();
			resp.openedResource = openedResource;
			if (openedResource.GetPath() != expectedResource.GetPath())
			{
				resp.status = "error";
				resp.message = "Prefab Edit Mode opened a different resource than the explicit target. Expected: " + expectedResource + "; actual: " + openedResource;
				return resp;
			}
			resp.status = "ok";
			resp.message = "Explicit prefab target opened and resource identity verified";
			return resp;
		}

	// Workbench.ScriptDialog is intentionally exercised only by the
	// repository's disposable live acceptance harness. It is a synchronous,
	// native Workbench confirmation dialog (not an in-game UI). The host's
	// watchdog is already active before this NET request is dispatched; it must
	// observe the dialog, attempt only the narrowly safe close path, and taint
	// the target session rather than trusting any later native save completion.
	if (req.testNativeModal)
	{
		Workbench.ScriptDialog(
			"Reforger Forge explicit-save acceptance",
			"Injected native Workbench confirmation; the save watchdog must dismiss this dialog.",
			new WorkbenchDialog_OKCancel()
		);
	}

		// This is the sole native save call in the helper. In prefab edit mode
		// WorldEditor.Save() is a world-save operation and opens "Save world as".
		// The dedicated template operation must instead receive the actual prefab
		// ancestor, not the generated edit instance exposed by GetEditorEntity(1).
		if (worldEditor.IsPrefabEditMode())
		{
			if (api.GetEditorEntityCount() != 2)
			{
				resp.status = "error";
				resp.message = "Prefab save refused because Prefab Edit Mode no longer has the expected two entities";
				return resp;
			}
			IEntitySource prefabSource = api.GetEditorEntity(1);
			if (!prefabSource)
			{
				resp.status = "error";
				resp.message = "Prefab save refused because the Prefab Edit Mode target entity is unavailable";
				return resp;
			}
			BaseContainer prefabAncestor = prefabSource.GetAncestor();
			if (!prefabAncestor)
			{
				resp.status = "error";
				resp.message = "Prefab save refused because the target entity has no prefab resource ancestor";
				return resp;
			}
			ResourceName expectedResource = metaFile.GetResourceID();
			ResourceName openedResource = prefabAncestor.GetResourceName();
			resp.openedResource = openedResource;
			if (openedResource.GetPath() != expectedResource.GetPath())
			{
				resp.status = "error";
				resp.message = "Prefab save refused because the active prefab differs from the explicit target. Expected: " + expectedResource + "; actual: " + openedResource;
				return resp;
			}
			IEntitySource prefabTemplate = IEntitySource.Cast(prefabAncestor);
			if (!prefabTemplate)
			{
				resp.status = "error";
				resp.message = "Prefab save refused because the target prefab ancestor is not an entity template";
				return resp;
			}
			if (!api.SaveEntityTemplate(prefabTemplate))
			{
				resp.status = "error";
				resp.message = "SaveEntityTemplate returned false for the explicit prefab target";
				return resp;
			}
		}
		else if (!worldEditor.Save())
		{
			resp.status = "error";
			resp.message = "WorldEditor.Save returned false for the explicit startup target";
			return resp;
		}
		resp.saved = true;
		resp.status = "ok";
		resp.message = "Save requested for the explicit startup target";
		return resp;
	}
}
