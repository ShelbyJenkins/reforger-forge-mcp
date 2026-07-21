// Disposable, maintainer-only Workbench acceptance fixture. It exists only
// inside this generated fixture add-on directory, is never shipped with the
// production Workbench helper, exposes no NET API handler of its own, and is
// never listed in package.json files or the production helper payload. It
// reads a private per-run control mailbox and pauses one declared job's local
// state machine at one canonical lease phase, then reports back to the
// launching host.
//
// Unlike the graphical runtime (which polls a control inbox every frame from a
// modded ArmaReforgerScripted.OnUpdate), a Workbench helper add-on has no
// autonomous per-frame tick: helper Enforce code runs only when the host makes
// a NET API call. This fixture therefore drains its control inbox from a modded
// EMCP_WB_ObserverService.Advance (which the host's Status poll calls) and from
// its OnLeaseAcquiredBarrier override. The drain runs at the top of Advance,
// before the terminal short-circuit, so a release/cancel acknowledgement can
// still be produced after the host has cancelled the job. The Phase 3 runner
// keeps polling Status for the duration of a case so these drain points keep
// getting called.
//
// The fixture currently knows only the single Phase 3 vertical-slice
// declaration (workbench.cancel_capture.lease_acquired.pose). Its command/case
// validation is intentionally hardcoded to that one case rather than a general
// port of the host-side FaultControlAuthorizer
// (scripts/observer-fault-matrix-support.ts): Enforce Script cannot import that
// TypeScript module, and porting its full generality is unwarranted before the
// slice has a retained live result.

class RFO_WBFaultControlBinding : JsonApiStruct
{
	string fixtureId;
	string lifecycleId;
	string lifecycleGeneration;

	void RFO_WBFaultControlBinding()
	{
		RegV("fixtureId");
		RegV("lifecycleId");
		RegV("lifecycleGeneration");
	}
}

class RFO_WBFaultControlBootstrap : JsonApiStruct
{
	int schemaVersion;
	string runId;
	string backend;
	string capability;
	string fixtureContentIdentity;
	string generatedProjectIdentity;
	string generatedAddonIdentity;
	ref RFO_WBFaultControlBinding binding;

	void RFO_WBFaultControlBootstrap()
	{
		binding = new RFO_WBFaultControlBinding();
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

class RFO_WBFaultControlCommand : JsonApiStruct
{
	int schemaVersion;
	string kind;
	string runId;
	string requestId;
	string caseId;
	string phase;
	string action;
	ref RFO_WBFaultControlBinding binding;

	void RFO_WBFaultControlCommand()
	{
		binding = new RFO_WBFaultControlBinding();
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
 * Capability-gated fixture controller. Singleton, drained on demand from the
 * modded observer service (see file header). It emits phase acknowledgements
 * and performs no native fixture action itself: the one declared vertical-slice
 * action (cancel_capture) is host-runner executed through the normal observer
 * Cancel NET API, so this controller only needs to unblock its own barrier and
 * acknowledge the control-channel handshake.
 */
class RFO_WBObserverMatrixControl
{
	protected static ref RFO_WBObserverMatrixControl s_Instance;

	protected static const string CONTROL_DIRECTORY = "$profile:RFOWorkbenchObserverMatrix";
	protected static const string BOOTSTRAP_PATH = CONTROL_DIRECTORY + "/bootstrap.json";
	protected static const string INBOX_DIRECTORY = CONTROL_DIRECTORY + "/inbox";
	protected static const string OUTBOX_DIRECTORY = CONTROL_DIRECTORY + "/outbox";

	protected static const string SLICE_CASE_ID = "workbench.cancel_capture.lease_acquired.pose";
	protected static const string SLICE_PHASE = "lease_acquired";
	protected static const string SLICE_ACTION = "cancel_capture";

	protected static const string REASON_MALFORMED = "MALFORMED";
	protected static const string REASON_RUN_MISMATCH = "RUN_MISMATCH";
	protected static const string REASON_LIFECYCLE_MISMATCH = "LIFECYCLE_MISMATCH";
	protected static const string REASON_MATRIX_MISMATCH = "MATRIX_MISMATCH";
	protected static const string REASON_PHASE_MISMATCH = "PHASE_MISMATCH";
	protected static const string REASON_REPLAY_REFUSED = "REPLAY_REFUSED";
	protected static const string REASON_CASE_TERMINAL = "CASE_TERMINAL";

	protected bool m_BootstrapValid;
	protected ref RFO_WBFaultControlBootstrap m_Bootstrap;
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

	void RFO_WBObserverMatrixControl()
	{
		m_AckCache = new map<string, string>();
	}

	static RFO_WBObserverMatrixControl GetInstance()
	{
		if (!s_Instance)
			s_Instance = new RFO_WBObserverMatrixControl();
		return s_Instance;
	}

	// Called from the modded observer service on each host NET API call so the
	// control inbox keeps draining even while a job's local state machine is
	// paused at the barrier or has already reached a terminal state.
	void Drain()
	{
		if (m_Terminal)
			return;
		if (!m_BootstrapValid)
		{
			// Retry until the launcher has written bootstrap.json. A Workbench
			// helper has no autonomous tick, so the first Drain may run before or
			// after the launcher stages the control root; a missing file must not
			// permanently disable the fixture.
			TryLoadBootstrap();
			if (!m_BootstrapValid)
				return;
		}
		PollInbox();
	}

	/**
	 * The barrier boundary called from the modded EMCP_WB_ObserverService.
	 * Returns true to let production logic proceed unmodified (the default when
	 * nothing is armed for this phase, or once a release/cancel has been
	 * observed). Returns false to hold the job at this phase for one more Advance
	 * cycle while the host's Status polling continues.
	 */
	bool CheckBarrier(string phase, EMCP_WB_ObserverJob job)
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
		// Only give up retrying once the file exists but cannot be parsed/validated;
		// a not-yet-written bootstrap simply reattempts on the next Drain.
		if (!FileIO.FileExists(BOOTSTRAP_PATH))
			return;
		RFO_WBFaultControlBootstrap bootstrap = new RFO_WBFaultControlBootstrap();
		if (!bootstrap.LoadFromFile(BOOTSTRAP_PATH))
			return;
		if (bootstrap.schemaVersion != 1 || bootstrap.backend != "workbench" ||
			!IsUuidLike(bootstrap.capability) || bootstrap.runId.IsEmpty() || bootstrap.runId.Length() > 160 ||
			!bootstrap.binding || bootstrap.binding.fixtureId.IsEmpty() ||
			bootstrap.binding.lifecycleId.IsEmpty() || bootstrap.binding.lifecycleGeneration.IsEmpty())
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
		m_LastProcessedInboxSequence = sequence;

		RFO_WBFaultControlCommand command = new RFO_WBFaultControlCommand();
		if (!command.LoadFromFile(INBOX_DIRECTORY + "/" + name))
			return;
		if (command.schemaVersion != 1 || command.runId != m_Bootstrap.runId || command.requestId.IsEmpty())
			return;
		if (!command.binding || command.binding.fixtureId != m_Bootstrap.binding.fixtureId ||
			command.binding.lifecycleId != m_Bootstrap.binding.lifecycleId ||
			command.binding.lifecycleGeneration != m_Bootstrap.binding.lifecycleGeneration)
		{
			RefuseIfKnownRequest(command.requestId, command.caseId, command.phase, REASON_LIFECYCLE_MISMATCH);
			return;
		}
		if (command.runId != m_Bootstrap.runId)
		{
			RefuseIfKnownRequest(command.requestId, command.caseId, command.phase, REASON_RUN_MISMATCH);
			return;
		}

		if (m_AckCache.Contains(command.requestId))
		{
			WriteOutbox(m_AckCache.Get(command.requestId));
			return;
		}

		if (command.kind == "terminal")
		{
			HandleTerminal(command);
			return;
		}
		if (m_Terminal)
		{
			Refuse(command.requestId, command.caseId, command.phase, REASON_CASE_TERMINAL);
			return;
		}
		if (command.caseId != SLICE_CASE_ID)
		{
			Refuse(command.requestId, command.caseId, command.phase, REASON_MATRIX_MISMATCH);
			return;
		}
		if (command.phase != SLICE_PHASE)
		{
			Refuse(command.requestId, command.caseId, command.phase, REASON_PHASE_MISMATCH);
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

	protected void HandleArm(RFO_WBFaultControlCommand command)
	{
		if (command.action != SLICE_ACTION)
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

	protected void HandleRelease(RFO_WBFaultControlCommand command)
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

	protected void HandleTerminal(RFO_WBFaultControlCommand command)
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
		string json = "{\"schemaVersion\":1,\"kind\":" + Quote(kind);
		json += ",\"requestId\":" + Quote(requestId);
		json += ",\"caseId\":" + Quote(caseId);
		json += ",\"phase\":" + Quote(phase);
		json += ",\"disposition\":" + Quote(kind);
		if (reason.IsEmpty())
			json += ",\"reason\":null";
		else
			json += ",\"reason\":" + Quote(reason);
		json += "}";
		if (!requestId.IsEmpty())
			m_AckCache.Set(requestId, json);
		WriteOutbox(json);
	}

	protected void WriteOutbox(string json)
	{
		FileIO.MakeDirectory(OUTBOX_DIRECTORY);
		string name = Pad(m_NextOutboxSequence, 12) + "-" + m_Bootstrap.capability + ".json";
		m_NextOutboxSequence++;
		FileHandle file = FileIO.OpenFile(OUTBOX_DIRECTORY + "/" + name, FileMode.WRITE);
		if (!file)
			return;
		file.Write(json, json.Length());
		file.Close();
	}

	// The control vocabulary (fixed acknowledgement kinds, canonical phase and
	// case IDs, a UUID capability, and refusal codes) contains only characters
	// that are safe to emit verbatim inside a JSON string. Reject anything else
	// rather than shipping a general escaper this fixture does not need.
	protected string Quote(string value)
	{
		for (int index = 0; index < value.Length(); index++)
		{
			int character = value.ToAscii(index);
			bool safe = (character >= 48 && character <= 57) || (character >= 65 && character <= 90) ||
				(character >= 97 && character <= 122) || character == 95 || character == 45 || character == 46;
			if (!safe)
				return "\"\"";
		}
		return "\"" + value + "\"";
	}

	protected string Pad(int value, int width)
	{
		string text = value.ToString();
		while (text.Length() < width)
			text = "0" + text;
		return text;
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

modded class EMCP_WB_ObserverService
{
	// Drain the control inbox at the top of every Advance, before the terminal
	// short-circuit inside super.Advance, so a release/cancel acknowledgement is
	// still produced after the host cancels the job. The Status NET API poll is
	// what calls Advance, so as long as the host keeps polling, the inbox keeps
	// draining regardless of job state.
	override bool Advance(string jobId, string leaseId, string lifecycleGeneration, string canonicalTarget, out string message)
	{
		RFO_WBObserverMatrixControl.GetInstance().Drain();
		return super.Advance(jobId, leaseId, lifecycleGeneration, canonicalTarget, message);
	}

	override protected event bool OnLeaseAcquiredBarrier(EMCP_WB_ObserverJob job)
	{
		if (!super.OnLeaseAcquiredBarrier(job))
			return false;
		RFO_WBObserverMatrixControl control = RFO_WBObserverMatrixControl.GetInstance();
		control.Drain();
		return control.CheckBarrier("lease_acquired", job);
	}
}
