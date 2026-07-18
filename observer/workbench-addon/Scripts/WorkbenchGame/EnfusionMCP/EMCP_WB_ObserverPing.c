/** Advertise only Workbench observer capabilities proven in this process. */

class EMCP_WB_ObserverPingRequest : JsonApiStruct
{
}

class EMCP_WB_ObserverPingResponse : JsonApiStruct
{
	string status;
	string message;
	string adapterProtocol;
	string projectFile;
	string worldIdentity;
	string activeJobId;
	bool captureCurrent;
	bool restorationApiAvailable;
	bool cameraEditor;

	void EMCP_WB_ObserverPingResponse()
	{
		RegV("status");
		RegV("message");
		RegV("adapterProtocol");
		RegV("projectFile");
		RegV("worldIdentity");
		RegV("activeJobId");
		RegV("captureCurrent");
		RegV("restorationApiAvailable");
		RegV("cameraEditor");
	}
}

class EMCP_WB_ObserverPing : NetApiHandler
{
	override JsonApiStruct GetRequest()
	{
		return new EMCP_WB_ObserverPingRequest();
	}

	override JsonApiStruct GetResponse(JsonApiStruct request)
	{
		EMCP_WB_ObserverService service = EMCP_WB_ObserverService.Get();
		EMCP_WB_ObserverPingResponse resp = new EMCP_WB_ObserverPingResponse();
		resp.adapterProtocol = service.GetProtocol();
		resp.projectFile = service.CurrentProjectFile();
		resp.worldIdentity = service.CurrentWorldIdentity();
		resp.restorationApiAvailable = service.InspectEnvironment(resp.message);
		resp.captureCurrent = resp.restorationApiAvailable;
		resp.cameraEditor = service.IsCameraEditorProven();
		if (service.GetJob())
			resp.activeJobId = service.GetJob().jobId;
		resp.status = "ok";
		return resp;
	}
}
