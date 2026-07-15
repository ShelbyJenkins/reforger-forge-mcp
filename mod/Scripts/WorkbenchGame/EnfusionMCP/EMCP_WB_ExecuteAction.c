/**
 * EMCP_WB_ExecuteAction.c - Disabled generic menu action endpoint
 *
 * Arbitrary Workbench menu actions have no nonmodal safety contract, so the
 * endpoint retains protocol compatibility but never touches an editor module.
 * Called via NET API TCP protocol: APIFunc = "EMCP_WB_ExecuteAction"
 */

class EMCP_WB_ExecuteActionRequest : JsonApiStruct
{
	string menuPath;

	void EMCP_WB_ExecuteActionRequest()
	{
		RegV("menuPath");
	}
}

class EMCP_WB_ExecuteActionResponse : JsonApiStruct
{
	string status;
	string menuPath;
	string message;

	void EMCP_WB_ExecuteActionResponse()
	{
		RegV("status");
		RegV("menuPath");
		RegV("message");
	}
}

class EMCP_WB_ExecuteAction : NetApiHandler
{
	override JsonApiStruct GetRequest()
	{
		return new EMCP_WB_ExecuteActionRequest();
	}

	override JsonApiStruct GetResponse(JsonApiStruct request)
	{
		EMCP_WB_ExecuteActionRequest req = EMCP_WB_ExecuteActionRequest.Cast(request);
		EMCP_WB_ExecuteActionResponse resp = new EMCP_WB_ExecuteActionResponse();
		resp.menuPath = req.menuPath;

		if (req.menuPath == "")
		{
			resp.status = "error";
			resp.message = "menuPath parameter required (comma-separated, e.g. 'Edit,Select All')";
			return resp;
		}

		resp.status = "error";
		resp.message = "Generic menu execution is disabled because arbitrary Workbench actions have no nonmodal safety contract. Use a dedicated wb_* tool.";
		return resp;
	}
}
