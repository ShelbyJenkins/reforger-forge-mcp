// Fixed profile-relative activation contract. The addon remains dormant unless
// this exact file parses and passes every bounded validation below.
class RFO_ObserverAgentContract : JsonApiStruct
{
	string host;
	int port;
	string instanceId;

	void RFO_ObserverAgentContract()
	{
		RegV("host");
		RegV("port");
		RegV("instanceId");
	}
}

class RFO_ObserverLimits : JsonApiStruct
{
	int maxPendingJobs;
	int maxCaptureRatePerMinute;
	int maxArtifactBytes;
	// JsonApiStruct distinguishes integer and floating-point JSON tokens. The
	// host writes these bounded policy values as JSON integers, so keep the
	// wire fields integral and let camera/job comparisons promote them.
	int minFov;
	int maxFov;
	int maxSettleFrames;
	int maxCaptureDistance;

	void RFO_ObserverLimits()
	{
		RegV("maxPendingJobs");
		RegV("maxCaptureRatePerMinute");
		RegV("maxArtifactBytes");
		RegV("minFov");
		RegV("maxFov");
		RegV("maxSettleFrames");
		RegV("maxCaptureDistance");
	}
}

class RFO_ObserverSession : JsonApiStruct
{
	static const string CONTRACT_PATH = "$profile:" + RFO_ObserverProtocol.DIRECTORY_SESSION_ROOT + "/" + RFO_ObserverProtocol.FILE_SESSION_CONTRACT;
	static const int MAX_CONTRACT_BYTES = 65536;

	string protocolVersion;
	string addonVersion;
	string bundleDigest;
	string buildIdentity;
	string expectedRuntimeKind;
	string sessionId;
	string launchNonce;
	string sessionToken;
	string createdAt;
	string expiresAt;
	int expiresAtUnix;
	ref RFO_ObserverAgentContract agent;
	ref array<string> transportPreference;
	string profileDirectoryName;
	ref RFO_ObserverLimits limits;
	protected string m_RFO_ValidationFailure;

	void RFO_ObserverSession()
	{
		agent = new RFO_ObserverAgentContract();
		transportPreference = new array<string>();
		limits = new RFO_ObserverLimits();
		RegV("protocolVersion");
		RegV("addonVersion");
		RegV("bundleDigest");
		RegV("buildIdentity");
		RegV("expectedRuntimeKind");
		RegV("sessionId");
		RegV("launchNonce");
		RegV("sessionToken");
		RegV("createdAt");
		RegV("expiresAt");
		RegV("expiresAtUnix");
		RegV("agent");
		RegV("transportPreference");
		RegV("profileDirectoryName");
		RegV("limits");
	}

	bool LoadAndValidate()
	{
		m_RFO_ValidationFailure = "";
		if (!FileIO.FileExists(CONTRACT_PATH))
			return Reject("contract_missing");

		FileHandle file = FileIO.OpenFile(CONTRACT_PATH, FileMode.READ);
		if (!file)
			return Reject("contract_open");
		int length = file.GetLength();
		file.Close();
		if (length <= 0 || length > MAX_CONTRACT_BYTES)
			return Reject("contract_size");
		if (!LoadFromFile(CONTRACT_PATH))
			return Reject("contract_json");
		if (protocolVersion != RFO_ObserverProtocol.RUNTIME_PROTOCOL_VERSION || addonVersion != "0.1.0")
			return Reject("protocol_version");
		if (buildIdentity != RFO_ObserverBuild.IDENTITY)
			return Reject("build_identity");
		if (!RFO_ObserverTime.IsUtcTimestamp(createdAt) || !RFO_ObserverTime.IsUtcTimestamp(expiresAt))
			return Reject("timestamps");
		if (expectedRuntimeKind != "client" && expectedRuntimeKind != "listenServer" && expectedRuntimeKind != "dedicated" && expectedRuntimeKind != "testRunner")
			return Reject("runtime_kind");
		if (!IsIdentifier(sessionId) || !IsSecretIdentifier(launchNonce) || !IsSecretIdentifier(sessionToken) || !IsLowerHex64(bundleDigest))
			return Reject("identifiers");
		if (profileDirectoryName != RFO_ObserverProtocol.DIRECTORY_SESSION_ROOT)
			return Reject("profile_directory");
		if (!agent || (agent.host != "127.0.0.1" && agent.host != "::1") || !IsIdentifier(agent.instanceId))
			return Reject("agent_identity");
		if (agent.port <= 0 || agent.port > 65535)
			return Reject("agent_port");
		if (expiresAtUnix <= System.GetUnixTime())
			return Reject("expired");
		if (!transportPreference || transportPreference.Count() <= 0 || transportPreference.Count() > 2)
			return Reject("transport_count");
		for (int transportIndex = 0; transportIndex < transportPreference.Count(); transportIndex++)
		{
			if (transportPreference[transportIndex] != "rest" && transportPreference[transportIndex] != "mailbox")
				return Reject("transport_value");
		}
		if (!limits || limits.maxPendingJobs <= 0 || limits.maxPendingJobs > 64)
			return Reject("limit_pending_jobs");
		if (limits.maxCaptureRatePerMinute <= 0 || limits.maxCaptureRatePerMinute > 600)
			return Reject("limit_capture_rate");
		if (limits.maxArtifactBytes < 1024 || limits.maxArtifactBytes > 67108864)
			return Reject("limit_artifact_bytes");
		if (limits.maxSettleFrames < 0 || limits.maxSettleFrames > 30)
			return Reject("limit_settle_frames");
		if (limits.minFov < 1.0 || limits.maxFov > 179.0 || limits.minFov >= limits.maxFov)
			return Reject("limit_fov");
		if (limits.maxCaptureDistance < 1.0 || limits.maxCaptureDistance > 100000.0)
			return Reject("limit_capture_distance");
		return true;
	}

	string GetValidationFailure()
	{
		return m_RFO_ValidationFailure;
	}

	bool AllowsTransport(string name)
	{
		return transportPreference && transportPreference.Contains(name);
	}

	protected bool IsIdentifier(string value)
	{
		if (value.IsEmpty() || value.Length() > 96)
			return false;
		for (int index = 0; index < value.Length(); index++)
		{
			int character = value.ToAscii(index);
			bool valid = (character >= 48 && character <= 57) || (character >= 65 && character <= 90) || (character >= 97 && character <= 122) || character == 95 || character == 45;
			if (!valid)
				return false;
		}
		return true;
	}

	protected bool IsSecretIdentifier(string value)
	{
		return value.Length() >= 32 && value.Length() <= 256 && IsIdentifierCharacters(value);
	}

	protected bool IsIdentifierCharacters(string value)
	{
		for (int index = 0; index < value.Length(); index++)
		{
			int character = value.ToAscii(index);
			bool valid = (character >= 48 && character <= 57) || (character >= 65 && character <= 90) || (character >= 97 && character <= 122) || character == 95 || character == 45;
			if (!valid)
				return false;
		}
		return true;
	}

	protected bool IsLowerHex64(string value)
	{
		if (value.Length() != 64)
			return false;
		for (int index = 0; index < value.Length(); index++)
		{
			int character = value.ToAscii(index);
			if (!((character >= 48 && character <= 57) || (character >= 97 && character <= 102)))
				return false;
		}
		return true;
	}

	protected bool Reject(string reason)
	{
		m_RFO_ValidationFailure = reason;
		return false;
	}
}
