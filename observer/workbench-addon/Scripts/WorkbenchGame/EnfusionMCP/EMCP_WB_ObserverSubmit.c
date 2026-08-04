/** Validate, bind, snapshot, and acquire the single handler-side camera lease. */

class EMCP_WB_ObserverSubmitRequest : JsonApiStruct
{
	string jobId;
	string leaseId;
	string lifecycleGeneration;
	string canonicalTarget;
	string expectedWorldIdentity;
	string viewKind;
	string matrix0;
	string matrix1;
	string matrix2;
	string matrix3;
	string fovText;
	int settlePolls;
	int maxWidth;
	int maxHeight;

	void EMCP_WB_ObserverSubmitRequest()
	{
		RegV("jobId");
		RegV("leaseId");
		RegV("lifecycleGeneration");
		RegV("canonicalTarget");
		RegV("expectedWorldIdentity");
		RegV("viewKind");
		RegV("matrix0");
		RegV("matrix1");
		RegV("matrix2");
		RegV("matrix3");
		RegV("fovText");
		RegV("settlePolls");
		RegV("maxWidth");
		RegV("maxHeight");
	}
}

class EMCP_WB_ObserverSubmit : NetApiHandler
{
	override JsonApiStruct GetRequest()
	{
		return new EMCP_WB_ObserverSubmitRequest();
	}

	override JsonApiStruct GetResponse(JsonApiStruct request)
	{
		EMCP_WB_ObserverSubmitRequest req = EMCP_WB_ObserverSubmitRequest.Cast(request);
		EMCP_WB_ObserverService service = EMCP_WB_ObserverService.Get();
		EMCP_WB_ObserverJobResponse resp = new EMCP_WB_ObserverJobResponse();
		string leaseId;
		string message;
		string errorCode;
		array<string> matrixRows = { req.matrix0, req.matrix1, req.matrix2, req.matrix3 };
		bool accepted = service.Submit(req.jobId, req.leaseId, req.lifecycleGeneration, req.canonicalTarget, req.expectedWorldIdentity, req.viewKind, matrixRows, req.fovText, req.settlePolls, req.maxWidth, req.maxHeight, leaseId, message, errorCode);
		string status = "error";
		if (accepted)
			status = "ok";
		resp.Fill(service, service.GetJob(), status, message);
		if (!accepted && !errorCode.IsEmpty())
			resp.terminalErrorCode = errorCode;
		return resp;
	}
}
