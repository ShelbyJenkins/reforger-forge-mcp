/** Cancellation always passes through exact camera restoration. */

class EMCP_WB_ObserverCancelRequest : JsonApiStruct
{
	string jobId;
	string leaseId;
	string lifecycleGeneration;
	string canonicalTarget;

	void EMCP_WB_ObserverCancelRequest()
	{
		RegV("jobId");
		RegV("leaseId");
		RegV("lifecycleGeneration");
		RegV("canonicalTarget");
	}
}

class EMCP_WB_ObserverCancel : NetApiHandler
{
	override JsonApiStruct GetRequest()
	{
		return new EMCP_WB_ObserverCancelRequest();
	}

	override JsonApiStruct GetResponse(JsonApiStruct request)
	{
		EMCP_WB_ObserverCancelRequest req = EMCP_WB_ObserverCancelRequest.Cast(request);
		EMCP_WB_ObserverService service = EMCP_WB_ObserverService.Get();
		EMCP_WB_ObserverJobResponse resp = new EMCP_WB_ObserverJobResponse();
		string message;
		bool matched = service.Cancel(req.jobId, req.leaseId, req.lifecycleGeneration, req.canonicalTarget, message);
		string status = "error";
		if (matched)
			status = "ok";
		resp.Fill(service, service.GetJob(), status, message);
		return resp;
	}
}
