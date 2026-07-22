// Disposable, maintainer-only acceptance fixture. It exists only inside this
// generated fixture add-on directory, is never shipped with the production
// observer add-on, and exposes no public MCP surface. It reads a private
// per-run control mailbox and pauses one declared job's local state machine
// at one canonical lease phase, then reports back to the launching host.
//
// The fixture currently knows only the single Phase 2 pilot declaration
// (runtime.cancel_capture.lease_acquired.pose). Its command/case validation
// is intentionally hardcoded to that one case rather than a general port of
// the host-side FaultControlAuthorizer (scripts/observer-fault-matrix-support.ts):
// Enforce Script cannot import that TypeScript module, and porting its full
// generality is unwarranted before the pilot has a retained live result.

class RFO_FaultControlBinding : JsonApiStruct
{
	string fixtureId;
	string lifecycleId;
	string lifecycleGeneration;

	void RFO_FaultControlBinding()
	{
		RegV("fixtureId");
		RegV("lifecycleId");
		RegV("lifecycleGeneration");
	}
}

class RFO_FaultControlBootstrap : JsonApiStruct
{
	int schemaVersion;
	string runId;
	string backend;
	string capability;
	string fixtureContentIdentity;
	string generatedProjectIdentity;
	string generatedAddonIdentity;
	ref RFO_FaultControlBinding binding;

	void RFO_FaultControlBootstrap()
	{
		binding = new RFO_FaultControlBinding();
		RegV("schemaVersion");
		RegV("runId");
		RegV("backend");
		RegV("capability");
		RegV("fixtureContentIdentity");
		RegV("generatedProjectIdentity");
		RegV("generatedAddonIdentity");
		RegV("binding");
	}
}

class RFO_FaultControlCommand : JsonApiStruct
{
	int schemaVersion;
	string kind;
	string runId;
	string requestId;
	string caseId;
	string phase;
	string action;
	ref RFO_FaultControlBinding binding;

	void RFO_FaultControlCommand()
	{
		binding = new RFO_FaultControlBinding();
		RegV("schemaVersion");
		RegV("kind");
		RegV("runId");
		RegV("requestId");
		RegV("caseId");
		RegV("phase");
		RegV("action");
		RegV("binding");
	}
}

/**
 * Capability-gated fixture controller. Singleton, polled once per frame from
 * a modded ArmaReforgerScripted.OnUpdate. It emits phase acknowledgements and
 * performs no native fixture action itself: the one declared pilot action
 * (cancel_capture) is host-runner executed through the normal observer
 * transport, so this controller only needs to unblock its own barrier and
 * acknowledge the control-channel handshake.
 */
class RFO_RuntimeMatrixControl
{
	protected static ref RFO_RuntimeMatrixControl s_Instance;

	protected static const string CONTROL_DIRECTORY = "$profile:RFOFaultMatrixControl";
	protected static const string BOOTSTRAP_PATH = CONTROL_DIRECTORY + "/bootstrap.json";
	protected static const string INBOX_DIRECTORY = CONTROL_DIRECTORY + "/inbox";
	protected static const string OUTBOX_DIRECTORY = CONTROL_DIRECTORY + "/outbox";

	protected static const string PILOT_CASE_ID = "runtime.cancel_capture.lease_acquired.pose";
	protected static const string PILOT_PHASE = "lease_acquired";
	protected static const string PILOT_ACTION = "cancel_capture";
	protected static const string FIXTURE_ADDON_GUID = "1155E9DCA4074C7A";

	protected static const string REASON_MALFORMED = "MALFORMED";
	protected static const string REASON_RUN_MISMATCH = "RUN_MISMATCH";
	protected static const string REASON_LIFECYCLE_MISMATCH = "LIFECYCLE_MISMATCH";
	protected static const string REASON_MATRIX_MISMATCH = "MATRIX_MISMATCH";
	protected static const string REASON_PHASE_MISMATCH = "PHASE_MISMATCH";
	protected static const string REASON_REPLAY_REFUSED = "REPLAY_REFUSED";
	protected static const string REASON_CASE_TERMINAL = "CASE_TERMINAL";

	protected bool m_BootstrapValid;
	protected ref RFO_FaultControlBootstrap m_Bootstrap;
	protected int m_NextOutboxSequence;
	protected int m_LastProcessedInboxSequence = -1;
	protected ref map<string, string> m_AckCache;

	protected bool m_Terminal;
	protected string m_ArmedCaseId;
	protected string m_ArmedPhase;
	protected string m_ArmedAction;
	protected string m_ArmedRequestId;
	protected bool m_Arrived;
	protected bool m_Released;

	void RFO_RuntimeMatrixControl()
	{
		m_AckCache = new map<string, string>();
	}

	static RFO_RuntimeMatrixControl GetInstance()
	{
		if (!s_Instance)
			s_Instance = new RFO_RuntimeMatrixControl();
		return s_Instance;
	}

	// Called once per frame regardless of barrier state so the control inbox
	// keeps draining even while a job's local state machine is paused.
	void Poll()
	{
		if (!m_BootstrapValid)
		{
			// OwnedRuntimeManager must start the exact process before the host can
			// derive its lifecycle generation and write bootstrap.json. Retry until
			// that bounded host setup has completed; one early frame must not
			// permanently disable the disposable fixture.
			TryLoadBootstrap();
			if (!m_BootstrapValid)
				return;
		}
		PollInbox();
	}

	/**
	 * The barrier boundary called from a modded RFO_ObserverService. Returns
	 * true to let production logic proceed unmodified (the default when
	 * nothing is armed for this phase, or once a release/cancel has been
	 * observed). Returns false to hold the job at this phase for one more
	 * frame while the rest of Update() (transport, cancellation handling,
	 * and this controller's own Poll) continues normally.
	 */
	bool CheckBarrier(string phase, RFO_ObserverJob job)
	{
		if (m_Terminal || m_ArmedCaseId.IsEmpty() || m_ArmedPhase != phase || !job)
			return true;
		if (!m_Arrived)
		{
			m_Arrived = true;
			SendAcknowledgement("arrived", m_ArmedRequestId, m_ArmedCaseId, m_ArmedPhase, string.Empty);
		}
		if (!m_Released)
			return false;
		m_ArmedCaseId = string.Empty;
		m_ArmedPhase = string.Empty;
		m_ArmedAction = string.Empty;
		m_ArmedRequestId = string.Empty;
		m_Arrived = false;
		m_Released = false;
		return true;
	}

	protected void TryLoadBootstrap()
	{
		if (!FileIO.FileExists(BOOTSTRAP_PATH))
			return;
		RFO_FaultControlBootstrap bootstrap = new RFO_FaultControlBootstrap();
		if (!bootstrap.LoadFromFile(BOOTSTRAP_PATH))
			return;
		if (bootstrap.schemaVersion != 1 || bootstrap.backend != "runtime" ||
			!IsUuidLike(bootstrap.capability) || bootstrap.runId.IsEmpty() || bootstrap.runId.Length() > 160 ||
			!IsSha256(bootstrap.fixtureContentIdentity) ||
			bootstrap.generatedProjectIdentity != FIXTURE_ADDON_GUID ||
			bootstrap.generatedAddonIdentity != FIXTURE_ADDON_GUID ||
			!bootstrap.binding || bootstrap.binding.fixtureId != FIXTURE_ADDON_GUID ||
			bootstrap.binding.lifecycleId.IsEmpty() || bootstrap.binding.lifecycleId.Length() > 160 ||
			bootstrap.binding.lifecycleGeneration.IsEmpty() || bootstrap.binding.lifecycleGeneration.Length() > 160)
			return;
		m_Bootstrap = bootstrap;
		m_BootstrapValid = true;
	}

	protected void PollInbox()
	{
		array<string> files = {};
		if (!FileIO.FindFiles(files.Insert, INBOX_DIRECTORY, ".json"))
			return;
		files.Sort();
		foreach (string path : files)
			HandleInboxFile(BaseName(path));
	}

	protected void HandleInboxFile(string name)
	{
		int sequence;
		string capability;
		if (!ParseControlFilename(name, sequence, capability))
			return;
		if (capability != m_Bootstrap.capability)
			return;
		if (sequence <= m_LastProcessedInboxSequence)
			return;

		RFO_FaultControlCommand command = new RFO_FaultControlCommand();
		if (!command.LoadFromFile(INBOX_DIRECTORY + "/" + name))
			return;
		// Do not permanently discard a command if a non-atomic external writer
		// was observed before its JSON body was complete.
		m_LastProcessedInboxSequence = sequence;
		if (command.schemaVersion != 1 || command.requestId.IsEmpty())
			return;
		if (command.runId != m_Bootstrap.runId)
		{
			RefuseIfKnownRequest(command.requestId, command.caseId, command.phase, REASON_RUN_MISMATCH);
			return;
		}
		if (!command.binding || command.binding.fixtureId != m_Bootstrap.binding.fixtureId ||
			command.binding.lifecycleId != m_Bootstrap.binding.lifecycleId ||
			command.binding.lifecycleGeneration != m_Bootstrap.binding.lifecycleGeneration)
		{
			RefuseIfKnownRequest(command.requestId, command.caseId, command.phase, REASON_LIFECYCLE_MISMATCH);
			return;
		}
		if (m_AckCache.Contains(command.requestId))
		{
			WriteOutbox(m_AckCache.Get(command.requestId));
			return;
		}

		if (m_Terminal)
		{
			Refuse(command.requestId, command.caseId, command.phase, REASON_CASE_TERMINAL);
			return;
		}
		if (command.caseId != PILOT_CASE_ID)
		{
			Refuse(command.requestId, command.caseId, command.phase, REASON_MATRIX_MISMATCH);
			return;
		}
		if (command.phase != PILOT_PHASE)
		{
			Refuse(command.requestId, command.caseId, command.phase, REASON_PHASE_MISMATCH);
			return;
		}
		if (command.kind == "terminal")
		{
			HandleTerminal(command);
			return;
		}
		if (command.kind == "arm")
		{
			HandleArm(command);
			return;
		}
		if (command.kind == "release" || command.kind == "cancel")
		{
			HandleRelease(command);
			return;
		}
		Refuse(command.requestId, command.caseId, command.phase, REASON_MALFORMED);
	}

	protected void HandleArm(RFO_FaultControlCommand command)
	{
		if (command.action != PILOT_ACTION)
		{
			Refuse(command.requestId, command.caseId, command.phase, REASON_MATRIX_MISMATCH);
			return;
		}
		if (!m_ArmedCaseId.IsEmpty())
		{
			if (m_ArmedRequestId == command.requestId)
				// A resend of the still-pending arm while awaiting barrier arrival.
				// The eventual "arrived" acknowledgement will carry this same
				// request ID, so no separate reply is needed here.
				return;
			Refuse(command.requestId, command.caseId, command.phase, REASON_REPLAY_REFUSED);
			return;
		}
		m_ArmedCaseId = command.caseId;
		m_ArmedPhase = command.phase;
		m_ArmedAction = command.action;
		m_ArmedRequestId = command.requestId;
		m_Arrived = false;
		m_Released = false;
	}

	protected void HandleRelease(RFO_FaultControlCommand command)
	{
		if (m_ArmedCaseId.IsEmpty() || m_ArmedCaseId != command.caseId || m_ArmedPhase != command.phase ||
			command.action != m_ArmedAction || !m_Arrived || m_Released)
		{
			Refuse(command.requestId, command.caseId, command.phase, REASON_REPLAY_REFUSED);
			return;
		}
		m_Released = true;
		SendAcknowledgement("executed", command.requestId, command.caseId, command.phase, string.Empty);
	}

	protected void HandleTerminal(RFO_FaultControlCommand command)
	{
		m_Terminal = true;
		m_ArmedCaseId = string.Empty;
		m_ArmedPhase = string.Empty;
		m_ArmedAction = string.Empty;
		m_ArmedRequestId = string.Empty;
		m_Arrived = false;
		m_Released = false;
		SendAcknowledgement("terminalled", command.requestId, command.caseId, command.phase, string.Empty);
	}

	protected void RefuseIfKnownRequest(string requestId, string caseId, string phase, string reason)
	{
		if (requestId.IsEmpty())
			return;
		Refuse(requestId, caseId, phase, reason);
	}

	protected void Refuse(string requestId, string caseId, string phase, string reason)
	{
		SendAcknowledgement("refused", requestId, caseId, phase, reason);
	}

	protected void SendAcknowledgement(string kind, string requestId, string caseId, string phase, string reason)
	{
		string json = "{\"schemaVersion\":1,\"kind\":" + RFO_ObserverJson.Quote(kind);
		json += ",\"requestId\":" + RFO_ObserverJson.Quote(requestId);
		json += ",\"caseId\":" + RFO_ObserverJson.Quote(caseId);
		json += ",\"phase\":" + RFO_ObserverJson.Quote(phase);
		json += ",\"disposition\":" + RFO_ObserverJson.Quote(kind);
		if (reason.IsEmpty())
			json += ",\"reason\":null";
		else
			json += ",\"reason\":" + RFO_ObserverJson.Quote(reason);
		json += "}";
		if (!requestId.IsEmpty())
			m_AckCache.Set(requestId, json);
		WriteOutbox(json);
	}

	protected void WriteOutbox(string json)
	{
		FileIO.MakeDirectory(OUTBOX_DIRECTORY);
		string name = RFO_ObserverTime.Pad(m_NextOutboxSequence, 12) + "-" + m_Bootstrap.capability + ".json";
		m_NextOutboxSequence++;
		string complete = OUTBOX_DIRECTORY + "/" + name;
		string temporary = complete + ".tmp";
		FileHandle file = FileIO.OpenFile(temporary, FileMode.WRITE);
		if (!file)
			return;
		file.Write(json, json.Length());
		file.Close();
		if (!FileIO.CopyFile(temporary, complete))
		{
			FileIO.DeleteFile(temporary);
			return;
		}
		FileHandle marker = FileIO.OpenFile(complete + ".complete", FileMode.WRITE);
		if (!marker)
		{
			FileIO.DeleteFile(complete);
			FileIO.DeleteFile(temporary);
			return;
		}
		marker.Close();
		FileIO.DeleteFile(temporary);
	}

	protected bool ParseControlFilename(string name, out int sequence, out string capability)
	{
		sequence = -1;
		capability = string.Empty;
		// "<12-digit sequence>-<36-char UUID capability>.json"
		if (name.Length() != 54 || !name.EndsWith(".json") || name.Substring(12, 1) != "-")
			return false;
		string sequencePart = name.Substring(0, 12);
		for (int index = 0; index < 12; index++)
		{
			int character = sequencePart.ToAscii(index);
			if (character < 48 || character > 57)
				return false;
		}
		string capabilityPart = name.Substring(13, 36);
		if (!IsUuidLike(capabilityPart))
			return false;
		sequence = sequencePart.ToInt();
		capability = capabilityPart;
		return true;
	}

	protected bool IsUuidLike(string value)
	{
		if (value.Length() != 36)
			return false;
		for (int index = 0; index < 36; index++)
		{
			if (index == 8 || index == 13 || index == 18 || index == 23)
			{
				if (value.Substring(index, 1) != "-")
					return false;
				continue;
			}
			int character = value.ToAscii(index);
			bool hex = (character >= 48 && character <= 57) || (character >= 97 && character <= 102) || (character >= 65 && character <= 70);
			if (!hex)
				return false;
		}
		return true;
	}

	protected bool IsSha256(string value)
	{
		if (value.Length() != 64)
			return false;
		for (int index = 0; index < 64; index++)
		{
			int character = value.ToAscii(index);
			bool hex = (character >= 48 && character <= 57) || (character >= 97 && character <= 102);
			if (!hex)
				return false;
		}
		return true;
	}

	protected string BaseName(string path)
	{
		int separator = path.LastIndexOf("/");
		int windowsSeparator = path.LastIndexOf("\\");
		if (windowsSeparator > separator)
			separator = windowsSeparator;
		if (separator >= 0)
			return path.Substring(separator + 1, path.Length() - separator - 1);
		return path;
	}
}

modded class ArmaReforgerScripted
{
	override void OnUpdate(BaseWorld world, float timeslice)
	{
		super.OnUpdate(world, timeslice);
		RFO_RuntimeMatrixControl.GetInstance().Poll();
	}
}

modded class RFO_ObserverService
{
	override protected event bool OnBeforeLeaseBarrier(RFO_ObserverJob job)
	{
		if (!super.OnBeforeLeaseBarrier(job))
			return false;
		return RFO_RuntimeMatrixControl.GetInstance().CheckBarrier("before_lease", job);
	}

	override protected event bool OnLeaseAcquiredBarrier(RFO_ObserverJob job)
	{
		if (!super.OnLeaseAcquiredBarrier(job))
			return false;
		return RFO_RuntimeMatrixControl.GetInstance().CheckBarrier("lease_acquired", job);
	}

	override protected event bool OnCaptureInProgressBarrier(RFO_ObserverJob job)
	{
		if (!super.OnCaptureInProgressBarrier(job))
			return false;
		return RFO_RuntimeMatrixControl.GetInstance().CheckBarrier("capture_in_progress", job);
	}

	override protected event bool OnRestorationInProgressBarrier(RFO_ObserverJob job)
	{
		if (!super.OnRestorationInProgressBarrier(job))
			return false;
		return RFO_RuntimeMatrixControl.GetInstance().CheckBarrier("restoration_in_progress", job);
	}

	override protected event bool OnTerminalReleaseBarrier(RFO_ObserverJob job)
	{
		if (!super.OnTerminalReleaseBarrier(job))
			return false;
		return RFO_RuntimeMatrixControl.GetInstance().CheckBarrier("terminal_release", job);
	}
}
