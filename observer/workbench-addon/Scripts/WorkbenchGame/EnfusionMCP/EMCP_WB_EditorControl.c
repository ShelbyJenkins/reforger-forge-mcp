/**
 * EMCP_WB_EditorControl.c - Editor mode control handler
 *
 * Supports unattended actions: stop, undo, redo, openResource.
 * play/save/saveAs are explicitly refused before any editor operation.
 * Called via NET API TCP protocol: APIFunc = "EMCP_WB_EditorControl"
 */

class EMCP_WB_EditorControlRequest : JsonApiStruct
{
	string action;
	bool debugMode;
	bool fullScreen;
	string path;

	void EMCP_WB_EditorControlRequest()
	{
		RegV("action");
		RegV("debugMode");
		RegV("fullScreen");
		RegV("path");
	}
}

class EMCP_WB_EditorControlResponse : JsonApiStruct
{
	string status;
	string action;
	string message;

	void EMCP_WB_EditorControlResponse()
	{
		RegV("status");
		RegV("action");
		RegV("message");
	}
}

class EMCP_WB_EditorControl : NetApiHandler
{
	override JsonApiStruct GetRequest()
	{
		return new EMCP_WB_EditorControlRequest();
	}

	override JsonApiStruct GetResponse(JsonApiStruct request)
	{
		EMCP_WB_EditorControlRequest req = EMCP_WB_EditorControlRequest.Cast(request);
		EMCP_WB_EditorControlResponse resp = new EMCP_WB_EditorControlResponse();
		resp.action = req.action;
		if (req.action == "play")
		{
			resp.status = "error";
			resp.message = "In-editor Play is disabled for unattended automation because it can compile scripts in a live editor process. Use a standalone diagnostic runtime launcher.";
			return resp;
		}
		if (req.action == "save" || req.action == "saveAs")
		{
			resp.status = "error";
			resp.message = "Unattended save is disabled because Workbench may open a modal dialog. Save manually.";
			return resp;
		}

		if (req.action == "openResource")
		{
			if (req.path == "")
			{
				resp.status = "error";
				resp.message = "path parameter required for openResource action";
				return resp;
			}

			// Workbench.OpenResource chooses the editor for the registered resource
			// class. A WorldEditor instance is intentionally not required here: a
			// generic no-document session must still be able to open a .ptc in the
			// Particle Editor.
			ResourceManager resourceManager = Workbench.GetModule(ResourceManager);
			if (!resourceManager)
			{
				resp.status = "error";
				resp.message = "ResourceManager module not available";
				return resp;
			}
			MetaFile metaFile = resourceManager.GetMetaFile(req.path);
			if (!metaFile)
			{
				resp.status = "error";
				resp.message = "Resource metadata not found for: " + req.path;
				return resp;
			}

			bool opened = Workbench.OpenResource(req.path);
			if (opened)
			{
				resp.status = "ok";
				resp.message = "Opened resource through Workbench routing: " + req.path;
			}
			else
			{
				resp.status = "error";
				resp.message = "Workbench.OpenResource returned false for: " + req.path;
			}
			return resp;
		}

		WorldEditor worldEditor = Workbench.GetModule(WorldEditor);
		if (!worldEditor)
		{
			resp.status = "error";
			resp.message = "WorldEditor module not available";
			return resp;
		}

		if (req.action == "stop")
		{
			worldEditor.SwitchToEditMode();
			resp.status = "ok";
			resp.message = "Switched to edit mode";
		}
		else if (req.action == "undo")
		{
			WorldEditorAPI api = worldEditor.GetApi();
			if (api)
			{
				// Undo is available via GameWorldEditor or WorldEditorIngame
				// Use ExecuteAction as a safe fallback
				array<string> menuPath = {};
				menuPath.Insert("Edit");
				menuPath.Insert("Undo");
				worldEditor.ExecuteAction(menuPath);
				resp.status = "ok";
				resp.message = "Undo executed";
			}
			else
			{
				resp.status = "error";
				resp.message = "WorldEditorAPI not available for undo";
			}
		}
		else if (req.action == "redo")
		{
			array<string> menuPath = {};
			menuPath.Insert("Edit");
			menuPath.Insert("Redo");
			worldEditor.ExecuteAction(menuPath);
			resp.status = "ok";
			resp.message = "Redo executed";
		}
		else
		{
			resp.status = "error";
			resp.message = "Unknown action: " + req.action + ". Valid unattended actions: stop, undo, redo, openResource";
		}

		return resp;
	}
}
