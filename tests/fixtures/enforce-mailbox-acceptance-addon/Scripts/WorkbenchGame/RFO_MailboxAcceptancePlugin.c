#ifdef WORKBENCH

class RFO_MailboxAcceptanceCaseResult : JsonApiStruct
{
	string caseId;
	bool passed;
	string message;
	int commandsCreated;
	int commandsAccepted;
	int quarantineFiles;
	int quarantineBytes;
	int statusDataFiles;
	int statusMarkerFiles;
	int statusTemporaryFiles;
	bool ingressRetainedWhileLocked;
	bool egressUsableWhileIngressLocked;
	bool recoveredAfterUnlock;
	bool dataCopiedBeforeMarker;
	bool hostCleanerObserved;
	bool hostCleanerPreserved;
	bool markerPublishedAfterRelease;
	bool payloadIntact;
	bool exactlyOnce;
	int acceptedAfterFirstPoll;
	int acceptedAfterLaterPoll;
	bool recordBoundExercised;
	bool byteBoundExercised;
	bool evidenceValid;
	bool egressCapBlocked;
	bool egressCapRecovered;

	void RFO_MailboxAcceptanceCaseResult()
	{
		RegV("caseId");
		RegV("passed");
		RegV("message");
		RegV("commandsCreated");
		RegV("commandsAccepted");
		RegV("quarantineFiles");
		RegV("quarantineBytes");
		RegV("statusDataFiles");
		RegV("statusMarkerFiles");
		RegV("statusTemporaryFiles");
		RegV("ingressRetainedWhileLocked");
		RegV("egressUsableWhileIngressLocked");
		RegV("recoveredAfterUnlock");
		RegV("dataCopiedBeforeMarker");
		RegV("hostCleanerObserved");
		RegV("hostCleanerPreserved");
		RegV("markerPublishedAfterRelease");
		RegV("payloadIntact");
		RegV("exactlyOnce");
		RegV("acceptedAfterFirstPoll");
		RegV("acceptedAfterLaterPoll");
		RegV("recordBoundExercised");
		RegV("byteBoundExercised");
		RegV("evidenceValid");
		RegV("egressCapBlocked");
		RegV("egressCapRecovered");
	}
}

class RFO_MailboxAcceptanceResult : JsonApiStruct
{
	int schemaVersion;
	string suite;
	string selectedCase;
	string runId;
	bool passed;
	int startedAtUnix;
	int finishedAtUnix;
	ref array<ref RFO_MailboxAcceptanceCaseResult> cases;

	void RFO_MailboxAcceptanceResult()
	{
		cases = new array<ref RFO_MailboxAcceptanceCaseResult>();
		RegV("schemaVersion");
		RegV("suite");
		RegV("selectedCase");
		RegV("runId");
		RegV("passed");
		RegV("startedAtUnix");
		RegV("finishedAtUnix");
		RegV("cases");
	}
}

class RFO_MailboxAcceptanceHostCleanerResult : JsonApiStruct
{
	int schemaVersion;
	string caseId;
	bool hostCleanerObserved;
	bool preserved;
	string message;

	void RFO_MailboxAcceptanceHostCleanerResult()
	{
		RegV("schemaVersion");
		RegV("caseId");
		RegV("hostCleanerObserved");
		RegV("preserved");
		RegV("message");
	}
}

class RFO_MailboxAcceptanceTransport : RFO_ObserverMailboxTransport
{
	int m_RFO_AcceptedCommands;
	protected RFO_MailboxAcceptancePlugin m_RFO_AcceptancePlugin;
	protected bool m_RFO_PauseBeforeMarker;

	bool ConfigureForAcceptance()
	{
		m_RFO_AcceptedCommands = 0;
		RFO_ObserverSession session = new RFO_ObserverSession();
		session.transportPreference.Insert("mailbox");
		return Initialize(session, new RFO_ObserverService());
	}

	bool ForcePoll()
	{
		m_RFO_NextPollMs = 0;
		return PollCommand();
	}

	bool WriteAcceptanceStatus(string payload)
	{
		return SubmitStatus(payload);
	}

	bool WriteAcceptanceRegistration(string payload)
	{
		return WriteOwned("registration", payload);
	}

	void PauseBeforeMarker(RFO_MailboxAcceptancePlugin plugin)
	{
		m_RFO_AcceptancePlugin = plugin;
		m_RFO_PauseBeforeMarker = true;
	}

	override protected event string GetRuntimeInstanceId()
	{
		return "acceptance-instance";
	}

	override protected event bool DispatchRuntimeCommand(RFO_ObserverRuntimeCommand command)
	{
		m_RFO_AcceptedCommands++;
		return true;
	}

	override protected event bool OnDataCopiedBeforeCompletionMarker(string dataPath, string markerPath)
	{
		if (!m_RFO_PauseBeforeMarker || !m_RFO_AcceptancePlugin)
			return true;
		m_RFO_PauseBeforeMarker = false;
		return m_RFO_AcceptancePlugin.CoordinateWriterPause(dataPath, markerPath);
	}
}

[WorkbenchPluginAttribute(
	name: "RFO Mailbox Acceptance",
	description: "Executes the production observer mailbox transport acceptance suite",
	wbModules: { "ScriptEditor" })]
class RFO_MailboxAcceptancePlugin : WorkbenchPlugin
{
	static const string RESULT_DEFAULT = "$profile:RFOAcceptance/result.json";
	static const string CONTROL_DIRECTORY = "$profile:RFOAcceptance/control";
	static const string LOCK_REQUEST = "$profile:RFOAcceptance/control/lock-request.json";
	static const string LOCK_HELD = "$profile:RFOAcceptance/control/lock-held";
	static const string LOCK_OBSERVED = "$profile:RFOAcceptance/control/lock-observed";
	static const string LOCK_RELEASE = "$profile:RFOAcceptance/control/lock-release";
	static const string WRITER_PAUSE = "$profile:RFOAcceptance/control/writer-pause.json";
	static const string WRITER_RELEASE = "$profile:RFOAcceptance/control/writer-release";
	static const string WRITER_CLEANER_RESULT = "$profile:RFOAcceptance/control/writer-cleaner-result.json";
	static const int CONTROL_TIMEOUT_MS = 30000;

	protected bool m_RFO_DataCopiedBeforeMarker;
	protected bool m_RFO_HostCleanerObserved;
	protected bool m_RFO_HostCleanerPreserved;
	protected bool m_RFO_MarkerReleased;
	protected string m_RFO_PausedDataPath;
	protected string m_RFO_PausedMarkerPath;

	override void Run()
	{
		RunAcceptance();
	}

	override void RunCommandline()
	{
		bool passed = RunAcceptance();
		if (passed)
			Workbench.Exit(0);
		else
			Workbench.Exit(1);
	}

	bool CoordinateWriterPause(string dataPath, string markerPath)
	{
		m_RFO_PausedDataPath = dataPath;
		m_RFO_PausedMarkerPath = markerPath;
		m_RFO_DataCopiedBeforeMarker = FileIO.FileExists(dataPath) && !FileIO.FileExists(markerPath);
		string request = "{\"schemaVersion\":1,\"caseId\":\"writer_pause\",\"dataProfilePath\":" + RFO_ObserverJson.Quote(ProfileRelative(dataPath));
		request += ",\"markerProfilePath\":" + RFO_ObserverJson.Quote(ProfileRelative(markerPath)) + "}";
		if (!WriteText(WRITER_PAUSE, request) || !WaitForFile(WRITER_CLEANER_RESULT, CONTROL_TIMEOUT_MS))
			return false;
		RFO_MailboxAcceptanceHostCleanerResult hostResult = new RFO_MailboxAcceptanceHostCleanerResult();
		if (!hostResult.LoadFromFile(WRITER_CLEANER_RESULT) || hostResult.schemaVersion != 1 || hostResult.caseId != "writer_pause")
			return false;
		m_RFO_HostCleanerObserved = hostResult.hostCleanerObserved;
		m_RFO_HostCleanerPreserved = hostResult.preserved && FileIO.FileExists(dataPath) && !FileIO.FileExists(markerPath);
		if (!WaitForFile(WRITER_RELEASE, CONTROL_TIMEOUT_MS))
			return false;
		m_RFO_MarkerReleased = true;
		return m_RFO_HostCleanerObserved && m_RFO_HostCleanerPreserved;
	}

	protected bool RunAcceptance()
	{
		FileIO.MakeDirectory("$profile:RFOAcceptance");
		FileIO.MakeDirectory(CONTROL_DIRECTORY);
		string selectedCase = "all";
		string resultPath = RESULT_DEFAULT;
		string runId;
		ScriptEditor scriptEditor = Workbench.GetModule(ScriptEditor);
		if (scriptEditor)
		{
			scriptEditor.GetCmdLine("-rfoCase", selectedCase);
			scriptEditor.GetCmdLine("-rfoResult", resultPath);
			scriptEditor.GetCmdLine("-rfoRunId", runId);
		}
		if (selectedCase.IsEmpty())
			selectedCase = "all";
		if (resultPath.IsEmpty())
			resultPath = RESULT_DEFAULT;

		RFO_MailboxAcceptanceResult result = new RFO_MailboxAcceptanceResult();
		result.schemaVersion = 1;
		result.suite = "reforger_forge_observer_mailbox_enforce";
		result.selectedCase = selectedCase;
		result.runId = runId;
		result.startedAtUnix = System.GetUnixTime();
		result.passed = true;

		if (Selected(selectedCase, "fairness"))
			AddCase(result, RunFairnessCase());
		if (Selected(selectedCase, "deletion_failure"))
			AddCase(result, RunDeletionFailureCase());
		if (Selected(selectedCase, "egress_reclamation"))
			AddCase(result, RunEgressReclamationCase());
		if (Selected(selectedCase, "bounded_quarantine"))
			AddCase(result, RunBoundedQuarantineCase());
		// Keep writer_pause last so the host can consume its published message
		// after Workbench exits and prove a second poll cannot redeliver it.
		if (Selected(selectedCase, "writer_pause"))
			AddCase(result, RunWriterPauseCase());
		if (result.cases.Count() == 0)
		{
			RFO_MailboxAcceptanceCaseResult unknown = NewCase(selectedCase);
			unknown.message = "unknown_case";
			AddCase(result, unknown);
		}

		result.finishedAtUnix = System.GetUnixTime();
		if (!result.SaveToFile(resultPath))
		{
			Print("RFO mailbox acceptance could not write result: " + resultPath, LogLevel.ERROR);
			return false;
		}
		if (result.passed)
			Print(string.Format("RFO mailbox acceptance complete passed=true result=%1", resultPath), LogLevel.NORMAL);
		else
			Print(string.Format("RFO mailbox acceptance complete passed=false result=%1", resultPath), LogLevel.ERROR);
		return result.passed;
	}

	protected RFO_MailboxAcceptanceCaseResult RunFairnessCase()
	{
		ResetMailbox();
		ClearControl();
		RFO_MailboxAcceptanceCaseResult result = NewCase("fairness");
		RFO_MailboxAcceptanceTransport transport;
		if (!NewTransport(transport))
		{
			result.message = "transport_initialization_failed";
			return result;
		}
		bool setupComplete = true;
		string lockedName;
		string lockedPath;
		for (int index = 0; index < 257; index++)
		{
			string poison = "000000" + RFO_ObserverTime.Pad(index, 6) + "-capture-poison-" + RFO_ObserverTime.Pad(index, 6) + ".json";
			string poisonPath = RFO_ObserverMailboxTransport.COMMAND_DIRECTORY + "/" + poison;
			setupComplete = WriteText(poisonPath, "{}") && setupComplete;
			if (index == 0)
			{
				lockedName = poison;
				lockedPath = poisonPath;
			}
		}
		string validName = "999999999999-capture-valid-command.json";
		setupComplete = WriteText(RFO_ObserverMailboxTransport.COMMAND_DIRECTORY + "/" + validName, ValidCommandJson()) && setupComplete;
		result.commandsCreated = 258;
		string request = "{\"schemaVersion\":1,\"caseId\":\"fairness\",\"targetProfilePath\":" + RFO_ObserverJson.Quote(ProfileRelative(lockedPath)) + "}";
		if (!setupComplete || CountFiles(RFO_ObserverMailboxTransport.COMMAND_DIRECTORY, ".json") != 258 || !WriteText(LOCK_REQUEST, request) || !WaitForFile(LOCK_HELD, CONTROL_TIMEOUT_MS) || !WaitForFile(LOCK_OBSERVED, CONTROL_TIMEOUT_MS))
		{
			result.message = "fairness_fixture_or_lock_failed";
			transport.Shutdown();
			return result;
		}
		transport.ForcePoll();
		result.acceptedAfterFirstPoll = transport.m_RFO_AcceptedCommands;
		result.ingressRetainedWhileLocked = FileIO.FileExists(lockedPath);
		transport.ForcePoll();
		result.acceptedAfterLaterPoll = transport.m_RFO_AcceptedCommands;
		result.egressUsableWhileIngressLocked = transport.WriteAcceptanceStatus("{\"case\":\"fairness\",\"phase\":\"locked\"}");
		FileIO.DeleteFile(LOCK_REQUEST);
		if (!WaitForFile(LOCK_RELEASE, CONTROL_TIMEOUT_MS))
		{
			result.message = "fairness_lock_release_failed";
			transport.Shutdown();
			return result;
		}
		for (int cleanupPoll = 0; cleanupPoll < 3 && FileIO.FileExists(lockedPath); cleanupPoll++)
			transport.ForcePoll();
		result.commandsAccepted = transport.m_RFO_AcceptedCommands;
		result.quarantineFiles = CountEvidenceFiles();
		result.quarantineBytes = EvidenceBytes();
		result.recoveredAfterUnlock = !FileIO.FileExists(lockedPath) && CountEvidenceForSource(lockedName) == 1;
		result.evidenceValid = ValidateQuarantineEvidence(result.quarantineFiles);
		result.passed = result.acceptedAfterFirstPoll == 0 && result.acceptedAfterLaterPoll == 1 && result.commandsAccepted == 1 && result.ingressRetainedWhileLocked && result.egressUsableWhileIngressLocked && result.recoveredAfterUnlock && !FileIO.FileExists(RFO_ObserverMailboxTransport.COMMAND_DIRECTORY + "/" + validName) && result.quarantineFiles == RFO_ObserverMailboxTransport.MAX_QUARANTINE_FILES && result.quarantineBytes > 0 && result.quarantineBytes <= RFO_ObserverMailboxTransport.MAX_QUARANTINE_BYTES && result.evidenceValid;
		if (result.passed)
			result.message = "valid_command_consumed_after_more_than_one_batch";
		else
			result.message = "fairness_or_quarantine_bound_failed";
		transport.Shutdown();
		return result;
	}

	protected RFO_MailboxAcceptanceCaseResult RunDeletionFailureCase()
	{
		ResetMailbox();
		ClearControl();
		RFO_MailboxAcceptanceCaseResult result = NewCase("deletion_failure");
		RFO_MailboxAcceptanceTransport transport;
		if (!NewTransport(transport))
		{
			result.message = "transport_initialization_failed";
			return result;
		}
		string name = "000000000001-capture-locked-poison.json";
		string commandPath = RFO_ObserverMailboxTransport.COMMAND_DIRECTORY + "/" + name;
		WriteText(commandPath, "{}");
		string request = "{\"schemaVersion\":1,\"caseId\":\"deletion_failure\",\"targetProfilePath\":" + RFO_ObserverJson.Quote(ProfileRelative(commandPath)) + "}";
		if (!WriteText(LOCK_REQUEST, request) || !WaitForFile(LOCK_HELD, CONTROL_TIMEOUT_MS) || !WaitForFile(LOCK_OBSERVED, CONTROL_TIMEOUT_MS))
		{
			result.message = "external_lock_not_acquired";
			transport.Shutdown();
			return result;
		}
		for (int lockedPoll = 0; lockedPoll < RFO_ObserverMailboxTransport.MAX_TRANSIENT_ATTEMPTS + 1; lockedPoll++)
			transport.ForcePoll();
		result.ingressRetainedWhileLocked = FileIO.FileExists(commandPath) && CountEvidenceForSource(name) == 1;
		result.egressUsableWhileIngressLocked = transport.WriteAcceptanceStatus("{\"case\":\"deletion_failure\",\"phase\":\"locked\"}");
		FileIO.DeleteFile(LOCK_REQUEST);
		if (!WaitForFile(LOCK_RELEASE, CONTROL_TIMEOUT_MS))
		{
			result.message = "external_lock_not_released";
			transport.Shutdown();
			return result;
		}
		for (int poll = 0; poll < 3 && FileIO.FileExists(commandPath); poll++)
			transport.ForcePoll();
		result.recoveredAfterUnlock = !FileIO.FileExists(commandPath) && CountEvidenceForSource(name) == 1;
		result.quarantineFiles = CountEvidenceFiles();
		result.quarantineBytes = EvidenceBytes();
		result.evidenceValid = ValidateQuarantineEvidence(result.quarantineFiles);
		result.passed = result.ingressRetainedWhileLocked && result.egressUsableWhileIngressLocked && result.recoveredAfterUnlock && result.quarantineFiles == 1 && result.quarantineBytes > 0 && result.quarantineBytes <= RFO_ObserverMailboxTransport.MAX_QUARANTINE_BYTES && result.evidenceValid;
		if (result.passed)
			result.message = "locked_ingress_retried_without_disabling_egress";
		else
			result.message = "deletion_failure_recovery_failed";
		transport.Shutdown();
		return result;
	}

	protected RFO_MailboxAcceptanceCaseResult RunEgressReclamationCase()
	{
		ResetMailbox();
		RFO_MailboxAcceptanceCaseResult result = NewCase("egress_reclamation");
		RFO_MailboxAcceptanceTransport transport;
		if (!NewTransport(transport))
		{
			result.message = "transport_initialization_failed";
			return result;
		}
		for (int index = 0; index < 513; index++)
		{
			string orphan = RFO_ObserverMailboxTransport.STATUS_DIRECTORY + "/" + RFO_ObserverTime.Pad(index, 12) + "-orphan.json";
			WriteText(orphan, "{\"orphan\":true}");
		}
		for (int temporaryIndex = 0; temporaryIndex < 17; temporaryIndex++)
		{
			string temporary = RFO_ObserverMailboxTransport.STATUS_DIRECTORY + "/" + RFO_ObserverTime.Pad(temporaryIndex, 12) + "-orphan.json.tmp";
			WriteText(temporary, "partial");
		}
		string payload = "{\"case\":\"egress_reclamation\",\"payload\":\"intact\"}";
		bool wrote = transport.WriteAcceptanceStatus(payload);
		result.statusDataFiles = CountFiles(RFO_ObserverMailboxTransport.STATUS_DIRECTORY, ".json");
		result.statusMarkerFiles = CountFiles(RFO_ObserverMailboxTransport.STATUS_DIRECTORY, ".complete");
		result.statusTemporaryFiles = CountFiles(RFO_ObserverMailboxTransport.STATUS_DIRECTORY, ".tmp");
		result.payloadIntact = PublishedPayloadEquals(payload);
		result.exactlyOnce = result.statusDataFiles == 1 && result.statusMarkerFiles == 1;
		bool reclaimedOrphans = wrote && result.exactlyOnce && result.payloadIntact && result.statusTemporaryFiles == 0;

		ResetMailbox();
		bool committedSetup = true;
		for (int committed = 0; committed < RFO_ObserverMailboxTransport.MAX_STATUS_FILES; committed++)
		{
			string committedName = RFO_ObserverTime.Pad(committed, 12) + "-status-committed-" + RFO_ObserverTime.Pad(committed, 6) + ".json";
			committedSetup = WriteText(RFO_ObserverMailboxTransport.STATUS_DIRECTORY + "/" + committedName, "{\"committed\":true}") && committedSetup;
			committedSetup = WriteText(RFO_ObserverMailboxTransport.STATUS_DIRECTORY + "/" + committedName + ".complete", "ready") && committedSetup;
		}
		bool blocked = !transport.WriteAcceptanceStatus("{\"case\":\"egress_reclamation\",\"phase\":\"blocked\"}");
		result.egressCapBlocked = committedSetup && blocked && CountFiles(RFO_ObserverMailboxTransport.STATUS_DIRECTORY, ".json") == RFO_ObserverMailboxTransport.MAX_STATUS_FILES && CountFiles(RFO_ObserverMailboxTransport.STATUS_DIRECTORY, ".tmp") == 0;
		string firstCommitted = "000000000000-status-committed-000000.json";
		FileIO.DeleteFile(RFO_ObserverMailboxTransport.STATUS_DIRECTORY + "/" + firstCommitted + ".complete");
		FileIO.DeleteFile(RFO_ObserverMailboxTransport.STATUS_DIRECTORY + "/" + firstCommitted);
		bool recovered = transport.WriteAcceptanceStatus("{\"case\":\"egress_reclamation\",\"phase\":\"recovered\"}");
		result.egressCapRecovered = recovered && CountFiles(RFO_ObserverMailboxTransport.STATUS_DIRECTORY, ".json") == RFO_ObserverMailboxTransport.MAX_STATUS_FILES && CountFiles(RFO_ObserverMailboxTransport.STATUS_DIRECTORY, ".complete") == RFO_ObserverMailboxTransport.MAX_STATUS_FILES && CountFiles(RFO_ObserverMailboxTransport.STATUS_DIRECTORY, ".tmp") == 0;
		result.passed = reclaimedOrphans && result.egressCapBlocked && result.egressCapRecovered;
		if (result.passed)
			result.message = "markerless_513_plus_temporary_orphans_reclaimed";
		else
			result.message = "egress_reclamation_failed";
		transport.Shutdown();
		return result;
	}

	protected RFO_MailboxAcceptanceCaseResult RunWriterPauseCase()
	{
		ResetMailbox();
		ClearControl();
		m_RFO_DataCopiedBeforeMarker = false;
		m_RFO_HostCleanerObserved = false;
		m_RFO_HostCleanerPreserved = false;
		m_RFO_MarkerReleased = false;
		RFO_MailboxAcceptanceCaseResult result = NewCase("writer_pause");
		RFO_MailboxAcceptanceTransport transport;
		if (!NewTransport(transport))
		{
			result.message = "transport_initialization_failed";
			return result;
		}
		transport.PauseBeforeMarker(this);
		string payload = ValidRegistrationJson();
		bool wrote = !payload.IsEmpty() && transport.WriteAcceptanceRegistration(payload);
		result.dataCopiedBeforeMarker = m_RFO_DataCopiedBeforeMarker;
		result.hostCleanerObserved = m_RFO_HostCleanerObserved;
		result.hostCleanerPreserved = m_RFO_HostCleanerPreserved;
		result.markerPublishedAfterRelease = m_RFO_MarkerReleased && FileIO.FileExists(m_RFO_PausedMarkerPath);
		result.payloadIntact = PublishedPayloadEquals(payload);
		result.statusDataFiles = CountFiles(RFO_ObserverMailboxTransport.STATUS_DIRECTORY, ".json");
		result.statusMarkerFiles = CountFiles(RFO_ObserverMailboxTransport.STATUS_DIRECTORY, ".complete");
		result.exactlyOnce = result.statusDataFiles == 1 && result.statusMarkerFiles == 1;
		result.passed = wrote && result.dataCopiedBeforeMarker && result.hostCleanerObserved && result.hostCleanerPreserved && result.markerPublishedAfterRelease && result.payloadIntact && result.exactlyOnce;
		if (result.passed)
			result.message = "active_writer_payload_preserved_until_marker";
		else
			result.message = "writer_cleaner_coordination_failed";
		transport.Shutdown();
		return result;
	}

	protected RFO_MailboxAcceptanceCaseResult RunBoundedQuarantineCase()
	{
		ResetMailbox();
		RFO_MailboxAcceptanceCaseResult result = NewCase("bounded_quarantine");
		string largeEvidence;
		while (largeEvidence.Length() < 50000)
			largeEvidence += "0123456789";
		bool largeSetup = true;
		int retainedAt = System.GetUnixTime();
		for (int seed = 0; seed < 100; seed++)
		{
			string seedName = RFO_ObserverTime.Pad(retainedAt, 12) + "-" + RFO_ObserverTime.Pad(seed, 6) + "-seed.json";
			largeSetup = WriteText(RFO_ObserverMailboxTransport.QUARANTINE_DIRECTORY + "/" + seedName, largeEvidence) && largeSetup;
		}
		int bytesBeforeTrim = EvidenceBytes();
		RFO_MailboxAcceptanceTransport transport;
		if (!largeSetup || bytesBeforeTrim <= RFO_ObserverMailboxTransport.MAX_QUARANTINE_BYTES || !NewTransport(transport))
		{
			result.message = "transport_initialization_failed";
			return result;
		}
		int bytesAfterTrim = EvidenceBytes();
		result.byteBoundExercised = bytesAfterTrim >= 0 && bytesAfterTrim <= RFO_ObserverMailboxTransport.MAX_QUARANTINE_BYTES && bytesAfterTrim < bytesBeforeTrim;
		bool poisonSetup = true;
		for (int index = 0; index < 160; index++)
		{
			string poison = "100000" + RFO_ObserverTime.Pad(index, 6) + "-capture-bounded-" + RFO_ObserverTime.Pad(index, 6) + ".json";
			poisonSetup = WriteText(RFO_ObserverMailboxTransport.COMMAND_DIRECTORY + "/" + poison, "{}") && poisonSetup;
		}
		result.commandsCreated = 160;
		transport.ForcePoll();
		result.quarantineFiles = CountEvidenceFiles();
		result.quarantineBytes = EvidenceBytes();
		result.recordBoundExercised = result.quarantineFiles == RFO_ObserverMailboxTransport.MAX_QUARANTINE_FILES;
		result.evidenceValid = ValidateQuarantineEvidence(result.quarantineFiles);
		result.passed = poisonSetup && CountFiles(RFO_ObserverMailboxTransport.COMMAND_DIRECTORY, ".json") == 0 && result.recordBoundExercised && result.byteBoundExercised && result.evidenceValid && result.quarantineBytes > 0 && result.quarantineBytes <= RFO_ObserverMailboxTransport.MAX_QUARANTINE_BYTES;
		if (result.passed)
			result.message = "quarantine_record_and_byte_bounds_enforced";
		else
			result.message = "quarantine_bound_failed";
		transport.Shutdown();
		return result;
	}

	protected bool NewTransport(out RFO_MailboxAcceptanceTransport transport)
	{
		transport = new RFO_MailboxAcceptanceTransport();
		return transport.ConfigureForAcceptance();
	}

	protected string ValidCommandJson()
	{
		string json = "{\"protocolVersion\":\"1.0\",\"jobId\":\"job-valid\",\"idempotencyKey\":\"acceptance-valid\",\"instanceId\":\"acceptance-instance\",\"worldEpoch\":0";
		json += ",\"deadlineAt\":\"2099-01-01T00:00:00.000Z\",\"view\":{\"kind\":\"current\",\"position\":[],\"orientation\":[],\"target\":[],\"fov\":60}";
		json += ",\"settleFrames\":0,\"performancePolicy\":\"default\",\"commandKind\":\"cancel\",\"deliveryAttempt\":1,\"deliveryToken\":\"delivery_token_1234567890\"";
		json += ",\"deliveryLeaseExpiresAt\":\"2099-01-01T00:00:00.000Z\",\"cancellationRequestedAt\":\"2026-07-18T00:00:00.000Z\",\"wireView\":{\"position\":[],\"orientation\":[],\"target\":[],\"fov\":\"60\"}}";
		return json;
	}

	protected string ValidRegistrationJson()
	{
		RFO_ObserverSession session = new RFO_ObserverSession();
		if (!session.LoadAndValidate() || !session.agent)
			return "";
		string json = "{\"protocolVersion\":\"1.0\",\"addonVersion\":\"0.1.0\"";
		json += ",\"bundleDigest\":" + RFO_ObserverJson.Quote(session.bundleDigest);
		json += ",\"buildIdentity\":" + RFO_ObserverJson.Quote(session.buildIdentity);
		json += ",\"agentInstanceId\":" + RFO_ObserverJson.Quote(session.agent.instanceId);
		json += ",\"sessionId\":" + RFO_ObserverJson.Quote(session.sessionId);
		json += ",\"launchNonce\":" + RFO_ObserverJson.Quote(session.launchNonce);
		json += ",\"instanceId\":\"acceptance-instance\"";
		json += ",\"instanceNonce\":\"acceptance_instance_nonce_12345678901234567890\"";
		json += ",\"runtimeKind\":\"testRunner\",\"capabilities\":[\"transport.mailbox\"],\"selectedTransport\":\"mailbox\"";
		json += ",\"headless\":true,\"worldId\":null,\"worldEpoch\":0";
		json += ",\"registeredAt\":" + RFO_ObserverJson.Quote(RFO_ObserverTime.UtcNowIso());
		json += ",\"sessionToken\":" + RFO_ObserverJson.Quote(session.sessionToken) + "}";
		return json;
	}

	protected bool ValidateQuarantineEvidence(int expectedCount)
	{
		array<string> jsonFiles = {};
		array<string> longNameFiles = {};
		if (!FileIO.FindFiles(jsonFiles.Insert, RFO_ObserverMailboxTransport.QUARANTINE_DIRECTORY, ".json"))
			return false;
		if (!FileIO.FindFiles(longNameFiles.Insert, RFO_ObserverMailboxTransport.QUARANTINE_DIRECTORY, ".rfoq"))
			return false;
		if (jsonFiles.Count() != expectedCount || longNameFiles.Count() != 0)
			return false;
		ref map<string, bool> sources = new map<string, bool>();
		foreach (string path : jsonFiles)
		{
			RFO_ObserverMailboxQuarantineEvidence evidence = new RFO_ObserverMailboxQuarantineEvidence();
			if (!evidence.LoadFromFile(RFO_ObserverMailboxTransport.QUARANTINE_DIRECTORY + "/" + BaseName(path)))
				return false;
			if (evidence.schemaVersion != 1 || evidence.disposition != "permanent_rejection" || evidence.reason.IsEmpty() || evidence.reason.Length() > 128)
				return false;
			if (evidence.sourceName.IsEmpty() || evidence.sourceBytes < 0 || evidence.sourceBytes > 262145 || evidence.retainedAtUnix <= 0 || evidence.retainedAtUnix > System.GetUnixTime())
				return false;
			if (sources.Contains(evidence.sourceName))
				return false;
			sources.Insert(evidence.sourceName, true);
		}
		return sources.Count() == expectedCount;
	}

	protected void AddCase(RFO_MailboxAcceptanceResult suite, RFO_MailboxAcceptanceCaseResult result)
	{
		suite.cases.Insert(result);
		if (!result.passed)
			suite.passed = false;
	}

	protected RFO_MailboxAcceptanceCaseResult NewCase(string caseId)
	{
		RFO_MailboxAcceptanceCaseResult result = new RFO_MailboxAcceptanceCaseResult();
		result.caseId = caseId;
		result.message = "not_completed";
		return result;
	}

	protected bool Selected(string selectedCase, string caseId)
	{
		return selectedCase == "all" || selectedCase == caseId;
	}

	protected void ResetMailbox()
	{
		FileIO.MakeDirectory(RFO_ObserverMailboxTransport.COMMAND_DIRECTORY);
		FileIO.MakeDirectory(RFO_ObserverMailboxTransport.STATUS_DIRECTORY);
		FileIO.MakeDirectory(RFO_ObserverMailboxTransport.QUARANTINE_DIRECTORY);
		ClearDirectory(RFO_ObserverMailboxTransport.COMMAND_DIRECTORY, { ".json", ".tmp", ".complete", ".rfoq" });
		ClearDirectory(RFO_ObserverMailboxTransport.STATUS_DIRECTORY, { ".json", ".tmp", ".complete", ".rfoq" });
		ClearDirectory(RFO_ObserverMailboxTransport.QUARANTINE_DIRECTORY, { ".json", ".tmp", ".complete", ".rfoq" });
	}

	protected void ClearControl()
	{
		FileIO.MakeDirectory(CONTROL_DIRECTORY);
		FileIO.DeleteFile(LOCK_REQUEST);
		FileIO.DeleteFile(LOCK_HELD);
		FileIO.DeleteFile(LOCK_OBSERVED);
		FileIO.DeleteFile(LOCK_RELEASE);
		FileIO.DeleteFile(WRITER_PAUSE);
		FileIO.DeleteFile(WRITER_RELEASE);
		FileIO.DeleteFile(WRITER_CLEANER_RESULT);
	}

	protected void ClearDirectory(string directory, array<string> extensions)
	{
		foreach (string extension : extensions)
		{
			array<string> files = {};
			if (!FileIO.FindFiles(files.Insert, directory, extension))
				continue;
			foreach (string path : files)
				FileIO.DeleteFile(directory + "/" + BaseName(path));
		}
	}

	protected int CountFiles(string directory, string extension)
	{
		array<string> files = {};
		if (!FileIO.FindFiles(files.Insert, directory, extension))
			return -1;
		return files.Count();
	}

	protected int CountEvidenceFiles()
	{
		return CountFiles(RFO_ObserverMailboxTransport.QUARANTINE_DIRECTORY, ".json") + CountFiles(RFO_ObserverMailboxTransport.QUARANTINE_DIRECTORY, ".rfoq");
	}

	protected int EvidenceBytes()
	{
		int bytes;
		bytes += DirectoryBytes(RFO_ObserverMailboxTransport.QUARANTINE_DIRECTORY, ".json");
		bytes += DirectoryBytes(RFO_ObserverMailboxTransport.QUARANTINE_DIRECTORY, ".rfoq");
		return bytes;
	}

	protected int DirectoryBytes(string directory, string extension)
	{
		array<string> files = {};
		if (!FileIO.FindFiles(files.Insert, directory, extension))
			return -1;
		int bytes;
		foreach (string path : files)
		{
			FileHandle file = FileIO.OpenFile(directory + "/" + BaseName(path), FileMode.READ);
			if (!file)
				return -1;
			bytes += file.GetLength();
			file.Close();
		}
		return bytes;
	}

	protected int CountEvidenceForSource(string sourceName)
	{
		array<string> files = {};
		if (!FileIO.FindFiles(files.Insert, RFO_ObserverMailboxTransport.QUARANTINE_DIRECTORY, ".json"))
			return -1;
		int matches;
		foreach (string path : files)
		{
			string name = BaseName(path);
			if (name.Length() == sourceName.Length() + 13 && name.Substring(13, sourceName.Length()) == sourceName)
				matches++;
		}
		return matches;
	}

	protected bool PublishedPayloadEquals(string expected)
	{
		array<string> files = {};
		if (!FileIO.FindFiles(files.Insert, RFO_ObserverMailboxTransport.STATUS_DIRECTORY, ".json") || files.Count() != 1)
			return false;
		string path = RFO_ObserverMailboxTransport.STATUS_DIRECTORY + "/" + BaseName(files[0]);
		if (!FileIO.FileExists(path + ".complete"))
			return false;
		FileHandle file = FileIO.OpenFile(path, FileMode.READ);
		if (!file)
			return false;
		int length = file.GetLength();
		string actual;
		file.Read(actual, length);
		file.Close();
		return actual == expected;
	}

	protected bool WriteText(string path, string value)
	{
		FileHandle file = FileIO.OpenFile(path, FileMode.WRITE);
		if (!file)
			return false;
		file.Write(value, value.Length());
		file.Close();
		return true;
	}

	protected bool WaitForFile(string path, int timeoutMs)
	{
		int startedAt = System.GetTickCount();
		while (!FileIO.FileExists(path) && System.GetTickCount() - startedAt < timeoutMs)
			Sleep(25);
		return FileIO.FileExists(path);
	}

	protected string ProfileRelative(string path)
	{
		string prefix = "$profile:";
		if (path.StartsWith(prefix))
			return path.Substring(prefix.Length(), path.Length() - prefix.Length());
		return path;
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

#endif // WORKBENCH
