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
// EMCP_WB_ObserverService.Advance (which the host's Status poll calls), from its
// OnLeaseAcquiredBarrier override, and from a modded ObserverPing handler. The
// ping drain is required after cancellation because both host-side status
// layers correctly return their cached terminal result instead of calling
// Advance again. The Phase 3 runner pumps only these existing real handlers.
//
// The fixture validates the complete Phase 3 Workbench action/phase/view
// vocabulary locally. It does not invent an independent schedule: accepted
// case IDs must be the exact dotted projection of the command fields, and each
// action is constrained to the same phase set as the host catalog. Unknown or
// malformed schedules remain inert and receive a bounded refusal.

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
 * and performs no native fixture action itself. Every declared action is
 * executed by the host through the normal observer, editor-control, artifact,
 * or exact-owner lifecycle surface; this controller only observes/unblocks its
 * barrier and acknowledges the private control-channel handshake.
 */
class RFO_WBObserverMatrixControl
{
	protected static ref RFO_WBObserverMatrixControl s_Instance;

	protected static const string CONTROL_DIRECTORY = "$profile:RFOWorkbenchObserverMatrix";
	protected static const string BOOTSTRAP_PATH = CONTROL_DIRECTORY + "/bootstrap.json";
	protected static const string INBOX_DIRECTORY = CONTROL_DIRECTORY + "/inbox";
	protected static const string OUTBOX_DIRECTORY = CONTROL_DIRECTORY + "/outbox";

	protected static const string FIXTURE_ADDON_IDENTITY = "2C6B8D14F9A0473E";
	protected static const string PHASE_BEFORE_LEASE = "before_lease";
	protected static const string PHASE_LEASE_ACQUIRED = "lease_acquired";
	protected static const string PHASE_CAPTURE_IN_PROGRESS = "capture_in_progress";
	protected static const string PHASE_RESTORATION_IN_PROGRESS = "restoration_in_progress";
	protected static const string PHASE_TERMINAL_RELEASE = "terminal_release";

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
	protected ref map<string, string> m_RequestFingerprints;

	protected bool m_Terminal;
	protected string m_SelectedCaseId;
	protected string m_SelectedPhase;
	protected string m_SelectedAction;
	protected string m_SelectedView;
	protected string m_ArmedCaseId;
	protected string m_ArmedPhase;
	protected string m_ArmedAction;
	protected string m_ArmedRequestId;
	protected string m_ArmedJobId;
	protected bool m_Arrived;
	protected bool m_Released;
	protected bool m_ActionExecuted;
	// before_lease is observed by Ping because no handler job exists yet. That
	// authenticated arrival binds lifecycle/case/phase; the host's validated
	// declared capture input binds the prospective view for faults that reject
	// before Submit. Keep the selected tuple after releasing the probe so any
	// subsequent real Submit must still match instead of silently consuming a
	// different view or lifecycle. A Submit is deliberately not required for
	// terminal closeout: WORLD_CHANGED, handler loss, and owned exit may all
	// produce their declared public result before a handler job can exist.
	protected bool m_BeforeLeaseSubmitPending;
	protected bool m_BeforeLeaseSubmitBound;

	void RFO_WBObserverMatrixControl()
	{
		m_AckCache = new map<string, string>();
		m_RequestFingerprints = new map<string, string>();
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
		// Bind the passive barrier to the real handler job and lifecycle generation,
		// not only to values copied from the host command. A restarted Workbench or
		// a different retained job cannot consume an old bootstrap capability.
		if (job.lifecycleGeneration != m_Bootstrap.binding.lifecycleGeneration ||
			(!m_ArmedJobId.IsEmpty() && m_ArmedJobId != job.jobId))
		{
			Refuse(m_ArmedRequestId, m_ArmedCaseId, m_ArmedPhase, REASON_LIFECYCLE_MISMATCH);
			m_Terminal = true;
			m_ArmedCaseId = string.Empty;
			m_ArmedJobId = string.Empty;
			return true;
		}
		if (m_ArmedJobId.IsEmpty())
			m_ArmedJobId = job.jobId;
		// Hook invocation alone is not phase evidence. Reject a delayed arm if
		// the real job has already crossed the selected product boundary.
		if (!BarrierStateMatches(phase, job))
		{
			Refuse(m_ArmedRequestId, m_ArmedCaseId, m_ArmedPhase, REASON_PHASE_MISMATCH);
			m_Terminal = true;
			ClearBarrier();
			return true;
		}
		if (!m_Arrived)
		{
			m_Arrived = true;
			SendAcknowledgement("arrived", m_ArmedRequestId, m_ArmedCaseId, m_ArmedPhase, string.Empty);
		}
		if (!m_Released)
			return false;
		ClearBarrier();
		return true;
	}

	protected bool BarrierStateMatches(string phase, EMCP_WB_ObserverJob job)
	{
		if (!job)
			return false;
		if (phase == PHASE_LEASE_ACQUIRED)
			return job.cameraLeaseHeld && !job.restorationConfirmed && !job.screenshotIssued &&
				(job.state == EMCP_WB_ObserverProtocol.STATE_ACCEPTED || job.state == EMCP_WB_ObserverProtocol.STATE_SETTLING);
		if (phase == PHASE_CAPTURE_IN_PROGRESS)
			return job.cameraLeaseHeld && !job.restorationConfirmed && job.screenshotIssued &&
				(job.state == EMCP_WB_ObserverProtocol.STATE_CAPTURING || job.state == EMCP_WB_ObserverProtocol.STATE_AWAITING_ARTIFACT);
		if (phase == PHASE_RESTORATION_IN_PROGRESS)
			return job.cameraLeaseHeld && !job.restorationConfirmed && job.screenshotIssued &&
				job.artifactBytes > 33 && job.state == EMCP_WB_ObserverProtocol.STATE_RESTORING;
		if (phase == PHASE_TERMINAL_RELEASE)
			return job.IsTerminal() && !job.cameraLeaseHeld && job.restorationConfirmed;
		return false;
	}

	// before_lease is observed through the existing Ping handler before the
	// host dispatches Submit. The production Submit hook calls this again and is
	// admitted only after the host has executed and released the armed action.
	bool CheckBeforeLeaseProbe(EMCP_WB_ObserverService service)
	{
		if (m_Terminal || m_ArmedCaseId.IsEmpty() || m_ArmedPhase != PHASE_BEFORE_LEASE)
			return true;
		if (!service || service.HasJob())
		{
			Refuse(m_ArmedRequestId, m_ArmedCaseId, m_ArmedPhase, REASON_LIFECYCLE_MISMATCH);
			m_Terminal = true;
			ClearBarrier();
			return true;
		}
		if (!m_Arrived)
		{
			m_Arrived = true;
			SendAcknowledgement("arrived", m_ArmedRequestId, m_ArmedCaseId, m_ArmedPhase, string.Empty);
		}
		if (!m_Released)
			return false;
		ClearBarrier();
		return true;
	}

	bool CheckBeforeLeaseSubmit(
		EMCP_WB_ObserverService service,
		string jobId,
		string lifecycleGeneration,
		string canonicalTarget,
		string viewKind)
	{
		// A Submit that races the still-held probe remains blocked. Arrival is
		// emitted only by the Ping probe, where absence of a retained job can be
		// observed without allowing Submit to acquire camera state.
		if (!m_ArmedCaseId.IsEmpty() && m_ArmedPhase == PHASE_BEFORE_LEASE)
			return CheckBeforeLeaseProbe(service);
		if (!m_BeforeLeaseSubmitPending)
			return true;

		string submittedView = viewKind;
		if (submittedView == "lookAt")
			submittedView = "lookat";
		bool matches = !m_Terminal && service && !service.HasJob() && !jobId.IsEmpty() &&
			!canonicalTarget.IsEmpty() && m_SelectedPhase == PHASE_BEFORE_LEASE &&
			lifecycleGeneration == m_Bootstrap.binding.lifecycleGeneration && submittedView == m_SelectedView;
		m_BeforeLeaseSubmitPending = false;
		if (!matches)
		{
			// No control request is pending after the release acknowledgement, so
			// fail the real Submit and seal the case instead of fabricating another
			// acknowledgement for an already-completed handshake.
			m_Terminal = true;
			return false;
		}
		m_BeforeLeaseSubmitBound = true;
		return true;
	}

	protected void ClearBarrier()
	{
		m_ArmedCaseId = string.Empty;
		m_ArmedPhase = string.Empty;
		m_ArmedAction = string.Empty;
		m_ArmedRequestId = string.Empty;
		m_ArmedJobId = string.Empty;
		m_Arrived = false;
		m_Released = false;
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
			!IsSha256(bootstrap.fixtureContentIdentity) || !IsSha256(bootstrap.generatedProjectIdentity) ||
			bootstrap.generatedAddonIdentity != FIXTURE_ADDON_IDENTITY ||
			!bootstrap.binding || bootstrap.binding.fixtureId.IsEmpty() ||
			bootstrap.binding.fixtureId != bootstrap.generatedProjectIdentity ||
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

		RFO_WBFaultControlCommand command = new RFO_WBFaultControlCommand();
		if (!command.LoadFromFile(INBOX_DIRECTORY + "/" + name))
			// The host may still have the newly-created mailbox file open. Do not
			// consume its sequence until one complete JSON document can be read.
			return;
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
			if (m_RequestFingerprints.Get(command.requestId) == CommandFingerprint(command))
				WriteOutbox(m_AckCache.Get(command.requestId));
			else
				WriteOutbox(AcknowledgementJson("refused", command.requestId, command.caseId, command.phase, REASON_REPLAY_REFUSED));
			return;
		}
		m_RequestFingerprints.Set(command.requestId, CommandFingerprint(command));

		if (m_Terminal)
		{
			Refuse(command.requestId, command.caseId, command.phase, REASON_CASE_TERMINAL);
			return;
		}
		if (command.kind == "terminal")
		{
			if (command.caseId != m_SelectedCaseId || command.phase != m_SelectedPhase ||
				!IsDeclaredSchedule(command.caseId, m_SelectedAction, command.phase))
			{
				Refuse(command.requestId, command.caseId, command.phase, REASON_MATRIX_MISMATCH);
				return;
			}
			HandleTerminal(command);
			return;
		}
		if (!IsDeclaredSchedule(command.caseId, command.action, command.phase))
		{
			Refuse(command.requestId, command.caseId, command.phase, REASON_MATRIX_MISMATCH);
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
		if (m_ActionExecuted || !m_ArmedCaseId.IsEmpty())
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
		m_SelectedCaseId = command.caseId;
		m_SelectedPhase = command.phase;
		m_SelectedAction = command.action;
		m_SelectedView = DeclaredView(command.caseId, command.action, command.phase);
		m_ArmedRequestId = command.requestId;
		m_ArmedJobId = string.Empty;
		m_Arrived = false;
		m_Released = false;
		m_BeforeLeaseSubmitPending = false;
		m_BeforeLeaseSubmitBound = false;
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
		m_ActionExecuted = true;
		if (m_ArmedPhase == PHASE_BEFORE_LEASE)
			m_BeforeLeaseSubmitPending = true;
		SendAcknowledgement("executed", command.requestId, command.caseId, command.phase, string.Empty);
		ClearBarrier();
	}

	protected void HandleTerminal(RFO_WBFaultControlCommand command)
	{
		if (!m_ActionExecuted || !m_ArmedCaseId.IsEmpty())
		{
			Refuse(command.requestId, command.caseId, command.phase, REASON_REPLAY_REFUSED);
			return;
		}
		m_Terminal = true;
		ClearBarrier();
		SendAcknowledgement("terminalled", command.requestId, command.caseId, command.phase, string.Empty);
	}

	protected bool IsDeclaredSchedule(string caseId, string action, string phase)
	{
		if (caseId.IsEmpty() || caseId.Length() > 192 || action.IsEmpty() || phase.IsEmpty())
			return false;
		string view = string.Empty;
		string prefix = "workbench." + action + "." + phase + ".";
		if (!caseId.StartsWith(prefix))
			return false;
		view = caseId.Substring(prefix.Length(), caseId.Length() - prefix.Length());
		if (view != "current" && view != "pose" && view != "lookat")
			return false;

		if (action == "complete_capture" || action == "release_twice")
			return phase == PHASE_TERMINAL_RELEASE;
		if (action == "cancel_capture")
			return phase == PHASE_LEASE_ACQUIRED || phase == PHASE_CAPTURE_IN_PROGRESS ||
				phase == PHASE_RESTORATION_IN_PROGRESS || phase == PHASE_TERMINAL_RELEASE;
		if (action == "submit_competing_capture")
			return phase == PHASE_LEASE_ACQUIRED;
		if (action == "write_truncated_artifact" || action == "write_crc_artifact" || action == "write_mismatched_artifact")
			return phase == PHASE_CAPTURE_IN_PROGRESS && view == "pose";
		if (action == "disable_fixture_handler" || action == "replace_fixture_world" || action == "stop_owned_workbench")
			return phase == PHASE_BEFORE_LEASE || phase == PHASE_LEASE_ACQUIRED ||
				phase == PHASE_CAPTURE_IN_PROGRESS || phase == PHASE_RESTORATION_IN_PROGRESS ||
				phase == PHASE_TERMINAL_RELEASE;
		return false;
	}

	protected string DeclaredView(string caseId, string action, string phase)
	{
		string prefix = "workbench." + action + "." + phase + ".";
		if (!caseId.StartsWith(prefix))
			return string.Empty;
		return caseId.Substring(prefix.Length(), caseId.Length() - prefix.Length());
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
		string json = AcknowledgementJson(kind, requestId, caseId, phase, reason);
		if (!requestId.IsEmpty())
			m_AckCache.Set(requestId, json);
		WriteOutbox(json);
	}

	protected string AcknowledgementJson(string kind, string requestId, string caseId, string phase, string reason)
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
		return json;
	}

	protected string CommandFingerprint(RFO_WBFaultControlCommand command)
	{
		return command.kind + "|" + command.runId + "|" + command.caseId + "|" + command.phase + "|" + command.action + "|" +
			command.binding.fixtureId + "|" + command.binding.lifecycleId + "|" + command.binding.lifecycleGeneration;
	}

	protected void WriteOutbox(string json)
	{
		FileIO.MakeDirectory(OUTBOX_DIRECTORY);
		string name = Pad(m_NextOutboxSequence, 12) + "-" + m_Bootstrap.capability + ".json";
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

	protected bool IsSha256(string value)
	{
		if (value.Length() != 64)
			return false;
		for (int index = 0; index < 64; index++)
		{
			int character = value.ToAscii(index);
			bool hex = (character >= 48 && character <= 57) ||
				(character >= 97 && character <= 102) || (character >= 65 && character <= 70);
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
	// short-circuit inside super.Advance. Status drives the active barrier; after
	// the host caches a terminal result, the ObserverPing hook below takes over.
	override bool Advance(string jobId, string leaseId, string lifecycleGeneration, string canonicalTarget, out string message)
	{
		RFO_WBObserverMatrixControl.GetInstance().Drain();
		return super.Advance(jobId, leaseId, lifecycleGeneration, canonicalTarget, message);
	}

	override protected event bool OnBeforeLeaseBarrier(string jobId, string lifecycleGeneration, string canonicalTarget, string viewKind)
	{
		if (!super.OnBeforeLeaseBarrier(jobId, lifecycleGeneration, canonicalTarget, viewKind))
			return false;
		RFO_WBObserverMatrixControl control = RFO_WBObserverMatrixControl.GetInstance();
		control.Drain();
		return control.CheckBeforeLeaseSubmit(this, jobId, lifecycleGeneration, canonicalTarget, viewKind);
	}

	override protected event bool OnLeaseAcquiredBarrier(EMCP_WB_ObserverJob job)
	{
		if (!super.OnLeaseAcquiredBarrier(job))
			return false;
		RFO_WBObserverMatrixControl control = RFO_WBObserverMatrixControl.GetInstance();
		control.Drain();
		return control.CheckBarrier("lease_acquired", job);
	}

	override protected event bool OnCaptureInProgressBarrier(EMCP_WB_ObserverJob job)
	{
		if (!super.OnCaptureInProgressBarrier(job))
			return false;
		RFO_WBObserverMatrixControl control = RFO_WBObserverMatrixControl.GetInstance();
		control.Drain();
		return control.CheckBarrier("capture_in_progress", job);
	}

	override protected event bool OnRestorationInProgressBarrier(EMCP_WB_ObserverJob job)
	{
		if (!super.OnRestorationInProgressBarrier(job))
			return false;
		RFO_WBObserverMatrixControl control = RFO_WBObserverMatrixControl.GetInstance();
		control.Drain();
		return control.CheckBarrier("restoration_in_progress", job);
	}

	override protected event bool OnTerminalReleaseBarrier(EMCP_WB_ObserverJob job)
	{
		if (!super.OnTerminalReleaseBarrier(job))
			return false;
		RFO_WBObserverMatrixControl control = RFO_WBObserverMatrixControl.GetInstance();
		control.Drain();
		return control.CheckBarrier("terminal_release", job);
	}
}

// Fixture-only liveness hook for control closeout after a job is terminal.
// This does not expose a new handler or alter the production helper payload;
// it layers one private inbox drain over the existing observer ping.
modded class EMCP_WB_ObserverPing
{
	override JsonApiStruct GetResponse(JsonApiStruct request)
	{
		RFO_WBObserverMatrixControl control = RFO_WBObserverMatrixControl.GetInstance();
		control.Drain();
		control.CheckBeforeLeaseProbe(EMCP_WB_ObserverService.Get());
		return super.GetResponse(request);
	}
}

[WorkbenchPluginAttribute(
	name: "RFO Workbench Observer Matrix",
	description: "Bootstraps the disposable Workbench observer failure-matrix fixture",
	wbModules: { "ScriptEditor" })]
class RFO_WorkbenchObserverMatrixPlugin : WorkbenchPlugin
{
	override void Run()
	{
		RFO_WBObserverMatrixControl.GetInstance().Drain();
	}

	override void RunCommandline()
	{
		// Matrix Workbench must remain alive for real NET API calls; unlike a
		// standalone autotest plugin this bootstrap deliberately does not exit.
		RFO_WBObserverMatrixControl.GetInstance().Drain();
	}
}
