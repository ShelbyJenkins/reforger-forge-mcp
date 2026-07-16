class RFO_ObserverTransport
{
	string GetName() { return "unavailable"; }
	bool Initialize(RFO_ObserverSession session, RFO_ObserverService service) { return false; }
	void Update() {}
	bool RegisterInstance(string registrationJson) { return false; }
	bool Heartbeat(string heartbeatJson) { return false; }
	bool PollCommand() { return false; }
	bool SubmitStatus(string statusJson) { return false; }
	bool SubmitArtifact(string manifestJson) { return false; }
	void Shutdown() {}
}
