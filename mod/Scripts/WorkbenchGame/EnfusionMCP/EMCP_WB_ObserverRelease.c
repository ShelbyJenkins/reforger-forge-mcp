/** Release only a terminal/restored job; replay its retained exact receipt. */

class EMCP_WB_ObserverReleaseRequest : JsonApiStruct
{
	string jobId;
	string leaseId;
	string lifecycleGeneration;
	string canonicalTarget;

	void EMCP_WB_ObserverReleaseRequest()
	{
		RegV("jobId");
		RegV("leaseId");
		RegV("lifecycleGeneration");
		RegV("canonicalTarget");
	}
}

class EMCP_WB_ObserverReleaseResponse : JsonApiStruct
{
	string status;
	string message;
	string adapterProtocol;
	string jobId;
	bool restorationConfirmed;
	bool artifactRemoved;

	void EMCP_WB_ObserverReleaseResponse()
	{
		RegV("status");
		RegV("message");
		RegV("adapterProtocol");
		RegV("jobId");
		RegV("restorationConfirmed");
		RegV("artifactRemoved");
	}
}

class EMCP_WB_ObserverRelease : NetApiHandler
{
	override JsonApiStruct GetRequest()
	{
		return new EMCP_WB_ObserverReleaseRequest();
	}

	override JsonApiStruct GetResponse(JsonApiStruct request)
	{
		EMCP_WB_ObserverReleaseRequest req = EMCP_WB_ObserverReleaseRequest.Cast(request);
		EMCP_WB_ObserverService service = EMCP_WB_ObserverService.Get();
		EMCP_WB_ObserverReleaseResponse resp = new EMCP_WB_ObserverReleaseResponse();
		resp.adapterProtocol = service.GetProtocol();
		resp.jobId = req.jobId;
		bool restored;
		bool removed;
		string message;
		bool matched = service.Release(req.jobId, req.leaseId, req.lifecycleGeneration, req.canonicalTarget, restored, removed, message);
		resp.status = "error";
		if (matched)
			resp.status = "ok";
		resp.message = message;
		resp.restorationConfirmed = restored;
		resp.artifactRemoved = removed;
		return resp;
	}
}
