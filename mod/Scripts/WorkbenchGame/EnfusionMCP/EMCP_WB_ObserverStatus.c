/** Advance bounded settle and artifact polling without blocking the NET API. */

class EMCP_WB_ObserverStatusRequest : JsonApiStruct
{
	string jobId;
	string leaseId;
	string lifecycleGeneration;
	string canonicalTarget;

	void EMCP_WB_ObserverStatusRequest()
	{
		RegV("jobId");
		RegV("leaseId");
		RegV("lifecycleGeneration");
		RegV("canonicalTarget");
	}
}

class EMCP_WB_ObserverStatus : NetApiHandler
{
	override JsonApiStruct GetRequest()
	{
		return new EMCP_WB_ObserverStatusRequest();
	}

	override JsonApiStruct GetResponse(JsonApiStruct request)
	{
		EMCP_WB_ObserverStatusRequest req = EMCP_WB_ObserverStatusRequest.Cast(request);
		EMCP_WB_ObserverService service = EMCP_WB_ObserverService.Get();
		EMCP_WB_ObserverJobResponse resp = new EMCP_WB_ObserverJobResponse();
		string message;
		bool matched = service.Advance(req.jobId, req.leaseId, req.lifecycleGeneration, req.canonicalTarget, message);
		string status = "error";
		if (matched)
			status = "ok";
		resp.Fill(service, service.GetJob(), status, message);
		return resp;
	}
}
