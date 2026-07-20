enum RFO_ObserverMailboxDisposition
{
	DISPOSED,
	RETAINED_FOR_RETRY,
	STORAGE_UNAVAILABLE
}

class RFO_ObserverMailboxQuarantineEvidence : JsonApiStruct
{
	int schemaVersion;
	string disposition;
	string reason;
	string sourceName;
	int sourceBytes;
	int retainedAtUnix;

	void RFO_ObserverMailboxQuarantineEvidence()
	{
		RegV("schemaVersion");
		RegV("disposition");
		RegV("reason");
		RegV("sourceName");
		RegV("sourceBytes");
		RegV("retainedAtUnix");
	}
}

class RFO_ObserverMailboxTransport : RFO_ObserverTransport
{
	static const string PROFILE_DIRECTORY = "$profile:" + RFO_ObserverProtocol.DIRECTORY_SESSION_ROOT;
	static const string COMMAND_DIRECTORY = PROFILE_DIRECTORY + "/mailbox/commands";
	static const string STATUS_DIRECTORY = PROFILE_DIRECTORY + "/mailbox/status";
	static const string QUARANTINE_DIRECTORY = PROFILE_DIRECTORY + "/mailbox/quarantine/commands";
	static const int MAX_COMMAND_FILES = 256;
	static const int MAX_STATUS_FILES = 512;
	static const int MAX_TRANSIENT_ATTEMPTS = 8;
	static const int MAX_TRANSIENT_AGE_SECONDS = 30;
	static const int MAX_RETRY_TRACKING = 512;
	static const int MAX_QUARANTINE_FILES = 128;
	static const int MAX_QUARANTINE_BYTES = 4194304;
	static const int MAX_QUARANTINE_AGE_SECONDS = 86400;
	static const int POLL_INTERVAL_MS = 250;
	protected ref RFO_ObserverSession m_RFO_Session;
	protected RFO_ObserverService m_RFO_Service;
	// Initialization, command ingress, and status egress are deliberately
	// independent. A busy poison command must not disable heartbeat/status
	// publication, and a failed status cleanup must not stop command polling.
	protected bool m_RFO_Initialized;
	protected bool m_RFO_IngressHealthy;
	protected bool m_RFO_EgressHealthy;
	protected int m_RFO_Sequence;
	protected int m_RFO_WriterNonce;
	protected int m_RFO_NextPollMs;
	protected string m_RFO_CommandCursor;
	protected ref map<string, int> m_RFO_RetryAttempts;
	protected ref map<string, int> m_RFO_RetryFirstSeen;
	protected ref map<string, bool> m_RFO_AcceptedPendingCleanup;

	override string GetName()
	{
		return "mailbox";
	}

	override bool Initialize(RFO_ObserverSession session, RFO_ObserverService service)
	{
		if (!session || !session.AllowsTransport("mailbox"))
			return false;
		m_RFO_Session = session;
		m_RFO_Service = service;
		m_RFO_Sequence = System.GetUnixTime();
		m_RFO_WriterNonce = Math.RandomInt(10000000, 99999999);
		m_RFO_RetryAttempts = new map<string, int>();
		m_RFO_RetryFirstSeen = new map<string, int>();
		m_RFO_AcceptedPendingCleanup = new map<string, bool>();
		bool commandReady = FileIO.MakeDirectory(COMMAND_DIRECTORY);
		bool statusReady = FileIO.MakeDirectory(STATUS_DIRECTORY);
		bool quarantineReady = FileIO.MakeDirectory(QUARANTINE_DIRECTORY);
		m_RFO_Initialized = commandReady && statusReady;
		m_RFO_IngressHealthy = commandReady && quarantineReady;
		m_RFO_EgressHealthy = statusReady;
		if (m_RFO_IngressHealthy && TrimQuarantine(0) != RFO_ObserverMailboxDisposition.DISPOSED)
			m_RFO_IngressHealthy = false;
		if (m_RFO_EgressHealthy && !ReclaimOrphanStatusFiles())
			m_RFO_EgressHealthy = false;
		return m_RFO_Initialized;
	}

	override void Update()
	{
	}

	override bool RegisterInstance(string registrationJson)
	{
		return WriteOwned("registration", registrationJson);
	}

	override bool Heartbeat(string heartbeatJson)
	{
		return WriteOwned("heartbeat", heartbeatJson);
	}

	override bool PollCommand()
	{
		if (!m_RFO_Initialized || System.GetTickCount() < m_RFO_NextPollMs)
			return m_RFO_Initialized;
		m_RFO_NextPollMs = System.GetTickCount() + POLL_INTERVAL_MS;
		if (!FileIO.MakeDirectory(COMMAND_DIRECTORY) || !FileIO.MakeDirectory(QUARANTINE_DIRECTORY))
		{
			m_RFO_IngressHealthy = false;
			return true;
		}
		array<string> files = {};
		if (!FileIO.FindFiles(files.Insert, COMMAND_DIRECTORY, ".json"))
		{
			m_RFO_IngressHealthy = false;
			return true;
		}
		m_RFO_IngressHealthy = true;
		files.Sort();
		if (files.Count() == 0)
			return true;
		int startIndex;
		if (!m_RFO_CommandCursor.IsEmpty())
		{
			int previousIndex = files.Find(m_RFO_CommandCursor);
			if (previousIndex >= 0)
				startIndex = (previousIndex + 1) % files.Count();
		}
		int inspected;
		for (int offset = 0; offset < files.Count() && inspected < MAX_COMMAND_FILES; offset++)
		{
			int index = (startIndex + offset) % files.Count();
			m_RFO_CommandCursor = files[index];
			string name = BaseName(files[index]);
			string path = COMMAND_DIRECTORY + "/" + name;
			inspected++;
			if (m_RFO_AcceptedPendingCleanup.Contains(name))
			{
				RFO_ObserverMailboxDisposition acceptedCleanup = DeleteOrAbsent(path, name, COMMAND_DIRECTORY, ".json");
				RecordIngressDisposition(name, "accepted_cleanup", acceptedCleanup);
				if (acceptedCleanup == RFO_ObserverMailboxDisposition.DISPOSED)
				{
					m_RFO_AcceptedPendingCleanup.Remove(name);
					ClearRetry(name);
				}
				continue;
			}
			if (!IsOwnedCommandName(name))
			{
				RecordIngressDisposition(name, "invalid_name", QuarantineCommand(name, path, "invalid_name", -1));
				continue;
			}
			FileHandle file = FileIO.OpenFile(path, FileMode.READ);
			if (!file)
			{
				RecordIngressDisposition(name, "open_failed", RetryCommand(name, path, "open_failed", -1));
				continue;
			}
			int length = file.GetLength();
			file.Close();
			if (length <= 2 || length > 262144)
			{
				RecordIngressDisposition(name, "invalid_size", QuarantineCommand(name, path, "invalid_size", length));
				continue;
			}
			RFO_ObserverRuntimeCommand command = new RFO_ObserverRuntimeCommand();
			if (!command.LoadFromFile(path) || !command.IsBoundedEnvelope())
			{
				RecordIngressDisposition(name, "invalid_envelope", QuarantineCommand(name, path, "invalid_envelope", length));
				continue;
			}
			if (command.instanceId != GetRuntimeInstanceId())
			{
				RecordIngressDisposition(name, "wrong_instance", QuarantineCommand(name, path, "wrong_instance", length));
				continue;
			}
			if (RFO_ObserverTime.IsExpired(command.deliveryLeaseExpiresAt))
			{
				RecordIngressDisposition(name, "delivery_expired", QuarantineCommand(name, path, "delivery_expired", length));
				continue;
			}
			if (m_RFO_AcceptedPendingCleanup.Count() >= MAX_RETRY_TRACKING)
			{
				RecordIngressDisposition(name, "accepted_cleanup_tracking_limit", RFO_ObserverMailboxDisposition.STORAGE_UNAVAILABLE);
				continue;
			}
			if (DispatchRuntimeCommand(command))
			{
				m_RFO_AcceptedPendingCleanup.Set(name, true);
				RFO_ObserverMailboxDisposition accepted = DeleteOrAbsent(path, name, COMMAND_DIRECTORY, ".json");
				RecordIngressDisposition(name, "accepted_cleanup", accepted);
				if (accepted == RFO_ObserverMailboxDisposition.DISPOSED)
				{
					m_RFO_AcceptedPendingCleanup.Remove(name);
					ClearRetry(name);
				}
				return true;
			}
			RecordIngressDisposition(name, "temporarily_rejected", RetryCommand(name, path, "temporarily_rejected", length));
		}
		return true;
	}

	override bool SubmitStatus(string statusJson)
	{
		return WriteOwned("status", statusJson);
	}

	override bool SubmitArtifact(string manifestJson)
	{
		return WriteOwned("artifact", manifestJson);
	}

	protected bool WriteOwned(string kind, string data)
	{
		if (!m_RFO_Initialized || data.Length() <= 1 || data.Length() > 262144)
			return false;
		// This method is synchronous on the runtime service thread. Reclamation
		// and publication therefore share one writer serialization boundary: no
		// cleaner can run between data copy and completion-marker publication.
		if (!FileIO.MakeDirectory(STATUS_DIRECTORY) || !ReclaimOrphanStatusFiles())
		{
			m_RFO_EgressHealthy = false;
			return false;
		}
		array<string> existingFiles = {};
		if (!FileIO.FindFiles(existingFiles.Insert, STATUS_DIRECTORY, ".json") || existingFiles.Count() >= MAX_STATUS_FILES)
		{
			m_RFO_EgressHealthy = false;
			return false;
		}
		m_RFO_Sequence++;
		// A writer nonce keeps files unique if the game script VM is recreated in
		// the same wall-clock second while the stable launch instance identity is
		// intentionally retained.
		string name = string.Format("%1-%2-%3-%4-%5.json", RFO_ObserverTime.Pad(m_RFO_Sequence, 12), kind, GetRuntimeInstanceId(), m_RFO_WriterNonce, m_RFO_Sequence);
		string temporary = STATUS_DIRECTORY + "/" + name + ".tmp";
		string complete = STATUS_DIRECTORY + "/" + name;
		FileHandle file = FileIO.OpenFile(temporary, FileMode.WRITE);
		if (!file)
		{
			m_RFO_EgressHealthy = false;
			return false;
		}
		file.Write(data, data.Length());
		file.Close();
		if (!FileIO.CopyFile(temporary, complete))
		{
			FileIO.DeleteFile(temporary);
			m_RFO_EgressHealthy = false;
			return false;
		}
		string completionMarker = complete + ".complete";
		// A protected no-op boundary lets the compiled acceptance addon pause the
		// real writer after its data copy while an external host cleaner runs. The
		// production transport remains synchronous and never yields here.
		if (!OnDataCopiedBeforeCompletionMarker(complete, completionMarker))
		{
			FileIO.DeleteFile(complete);
			FileIO.DeleteFile(temporary);
			m_RFO_EgressHealthy = false;
			return false;
		}
		FileHandle marker = FileIO.OpenFile(completionMarker, FileMode.WRITE);
		if (!marker)
		{
			FileIO.DeleteFile(complete);
			FileIO.DeleteFile(temporary);
			m_RFO_EgressHealthy = false;
			return false;
		}
		marker.WriteLine("ready");
		marker.Close();
		FileIO.DeleteFile(temporary);
		m_RFO_EgressHealthy = true;
		return true;
	}

	protected event string GetRuntimeInstanceId()
	{
		return m_RFO_Service.GetRuntimeInstanceId();
	}

	protected event bool DispatchRuntimeCommand(RFO_ObserverRuntimeCommand command)
	{
		return m_RFO_Service.OnRuntimeCommand(command);
	}

	protected event bool OnDataCopiedBeforeCompletionMarker(string dataPath, string markerPath)
	{
		return true;
	}

	// Enforce cannot atomically rename, so publication is data -> marker. A
	// subsequent synchronous write proves any markerless data/tmp from an older
	// call or VM lifetime is abandoned. The host never runs this reclamation for
	// an active session. Reclaim before applying the 512-file egress bound so
	// crash remnants cannot permanently disable status publication.
	protected bool ReclaimOrphanStatusFiles()
	{
		array<string> dataFiles = {};
		array<string> temporaryFiles = {};
		array<string> markerFiles = {};
		if (!FileIO.FindFiles(dataFiles.Insert, STATUS_DIRECTORY, ".json"))
			return false;
		if (!FileIO.FindFiles(temporaryFiles.Insert, STATUS_DIRECTORY, ".tmp"))
			return false;
		if (!FileIO.FindFiles(markerFiles.Insert, STATUS_DIRECTORY, ".complete"))
			return false;
		array<string> markerNames = {};
		foreach (string markerPath : markerFiles)
			markerNames.Insert(BaseName(markerPath));
		foreach (string dataPath : dataFiles)
		{
			string dataName = BaseName(dataPath);
			if (!dataName.EndsWith(".json") || markerNames.Contains(dataName + ".complete"))
				continue;
			if (DeleteOrAbsent(STATUS_DIRECTORY + "/" + dataName, dataName, STATUS_DIRECTORY, ".json") != RFO_ObserverMailboxDisposition.DISPOSED)
				return false;
		}
		foreach (string temporaryPath : temporaryFiles)
		{
			string temporaryName = BaseName(temporaryPath);
			if (!temporaryName.EndsWith(".json.tmp"))
				continue;
			if (DeleteOrAbsent(STATUS_DIRECTORY + "/" + temporaryName, temporaryName, STATUS_DIRECTORY, ".tmp") != RFO_ObserverMailboxDisposition.DISPOSED)
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

	protected bool IsOwnedCommandName(string name)
	{
		if (name.Length() < 32 || name.Length() > 220 || !name.EndsWith(".json"))
			return false;
		for (int index = 0; index < 12; index++)
		{
			if (!name.IsDigitAt(index))
				return false;
		}
		if (name.Substring(12, 9) != "-capture-" && name.Substring(12, 8) != "-cancel-")
			return false;
		return name.IndexOf("/") < 0 && name.IndexOf("\\") < 0;
	}

	protected RFO_ObserverMailboxDisposition RetryCommand(string name, string path, string reason, int length)
	{
		int now = System.GetUnixTime();
		if (!m_RFO_RetryAttempts.Contains(name) && m_RFO_RetryAttempts.Count() >= MAX_RETRY_TRACKING)
		{
			return QuarantineCommand(name, path, "retry_tracking_limit", length);
		}
		int attempts = 1;
		int firstSeen = now;
		if (m_RFO_RetryAttempts.Contains(name))
		{
			attempts = m_RFO_RetryAttempts.Get(name) + 1;
			firstSeen = m_RFO_RetryFirstSeen.Get(name);
		}
		m_RFO_RetryAttempts.Set(name, attempts);
		m_RFO_RetryFirstSeen.Set(name, firstSeen);
		if (attempts >= MAX_TRANSIENT_ATTEMPTS || now - firstSeen >= MAX_TRANSIENT_AGE_SECONDS)
			return QuarantineCommand(name, path, reason, length);
		return RFO_ObserverMailboxDisposition.RETAINED_FOR_RETRY;
	}

	protected void ClearRetry(string name)
	{
		m_RFO_RetryAttempts.Remove(name);
		m_RFO_RetryFirstSeen.Remove(name);
	}

	protected RFO_ObserverMailboxDisposition QuarantineCommand(string name, string path, string reason, int length)
	{
		// The exact source filename is the durable idempotency key. Evidence is a
		// typed, self-validating envelope so a locked, zero-byte, partial, or
		// colliding prior file can never authorize deletion of the source command.
		string evidenceName = NewQuarantineEvidenceName(name);
		if (evidenceName.IsEmpty())
			return RFO_ObserverMailboxDisposition.STORAGE_UNAVAILABLE;
		string target = QUARANTINE_DIRECTORY + "/" + evidenceName;
		int evidenceSourceBytes = BoundedEvidenceSourceBytes(length);
		string disposition = "{\"schemaVersion\":1,\"disposition\":\"permanent_rejection\",\"reason\":" + RFO_ObserverJson.Quote(reason);
		disposition += ",\"sourceName\":" + RFO_ObserverJson.Quote(name) + ",\"sourceBytes\":" + evidenceSourceBytes.ToString();
		disposition += ",\"retainedAtUnix\":" + System.GetUnixTime().ToString() + "}";
		int retainedEvidenceBytes = QuarantineEvidenceBytes(name);
		if (retainedEvidenceBytes <= -2)
		{
			Print(string.Format("ReforgerForge Observer: mailbox command disposition=storage_unavailable file=%1 reason=%2", name, reason), LogLevel.ERROR);
			return RFO_ObserverMailboxDisposition.STORAGE_UNAVAILABLE;
		}
		bool retained = retainedEvidenceBytes > 0;
		int incomingBytes;
		if (!retained)
			incomingBytes = disposition.Length();
		if (TrimQuarantine(incomingBytes) != RFO_ObserverMailboxDisposition.DISPOSED)
			return RFO_ObserverMailboxDisposition.STORAGE_UNAVAILABLE;
		if (!retained)
		{
			FileHandle evidence = FileIO.OpenFile(target, FileMode.WRITE);
			if (evidence)
			{
				evidence.Write(disposition, disposition.Length());
				evidence.Close();
				retained = true;
			}
		}
		if (!retained || QuarantineEvidenceBytes(name) <= 0)
		{
			Print(string.Format("ReforgerForge Observer: mailbox command disposition=storage_unavailable file=%1 reason=%2", name, reason), LogLevel.ERROR);
			return RFO_ObserverMailboxDisposition.STORAGE_UNAVAILABLE;
		}
		RFO_ObserverMailboxDisposition disposed = DeleteOrAbsent(path, name, COMMAND_DIRECTORY, ".json");
		if (disposed == RFO_ObserverMailboxDisposition.DISPOSED)
			ClearRetry(name);
		Print(string.Format("ReforgerForge Observer: mailbox command disposition=%1 file=%2 reason=%3 retained=true", DispositionName(disposed), name, reason), LogLevel.WARNING);
		return disposed;
	}

	protected RFO_ObserverMailboxDisposition TrimQuarantine(int incomingBytes)
	{
		array<string> files = {};
		if (!FileIO.FindFiles(files.Insert, QUARANTINE_DIRECTORY, ".json"))
			return RFO_ObserverMailboxDisposition.STORAGE_UNAVAILABLE;
		array<string> longNameFiles = {};
		if (!FileIO.FindFiles(longNameFiles.Insert, QUARANTINE_DIRECTORY, ".rfoq"))
			return RFO_ObserverMailboxDisposition.STORAGE_UNAVAILABLE;
		foreach (string longNamePath : longNameFiles)
			files.Insert(longNamePath);
		files.Sort();
		int now = System.GetUnixTime();
		int totalBytes;
		for (int index = files.Count() - 1; index >= 0; index--)
		{
			string name = BaseName(files[index]);
			int createdAt;
			if (name.EndsWith(".json") && IsTimestampedEvidenceName(name))
				createdAt = name.Substring(0, 12).ToInt();
			if (name.EndsWith(".rfoq"))
			{
				RFO_ObserverMailboxQuarantineEvidence longNameEnvelope = new RFO_ObserverMailboxQuarantineEvidence();
				if (!longNameEnvelope.LoadFromFile(QUARANTINE_DIRECTORY + "/" + name) || longNameEnvelope.retainedAtUnix <= 0)
					return RFO_ObserverMailboxDisposition.STORAGE_UNAVAILABLE;
				createdAt = longNameEnvelope.retainedAtUnix;
			}
			if (createdAt > 0 && now - createdAt > MAX_QUARANTINE_AGE_SECONDS)
			{
				RFO_ObserverMailboxDisposition expired = DeleteOrAbsent(QUARANTINE_DIRECTORY + "/" + name, name, QUARANTINE_DIRECTORY, EvidenceExtension(name));
				if (expired != RFO_ObserverMailboxDisposition.DISPOSED)
					return expired;
				files.RemoveOrdered(index);
				continue;
			}
			FileHandle file = FileIO.OpenFile(QUARANTINE_DIRECTORY + "/" + name, FileMode.READ);
			if (file)
			{
				totalBytes += file.GetLength();
				file.Close();
			}
			else
			{
				return RFO_ObserverMailboxDisposition.STORAGE_UNAVAILABLE;
			}
		}
		int incomingRecords;
		if (incomingBytes > 0)
			incomingRecords = 1;
		while (files.Count() + incomingRecords > MAX_QUARANTINE_FILES || totalBytes + incomingBytes > MAX_QUARANTINE_BYTES)
		{
			if (files.Count() == 0)
				return RFO_ObserverMailboxDisposition.STORAGE_UNAVAILABLE;
			string oldest = BaseName(files[0]);
			string oldestPath = QUARANTINE_DIRECTORY + "/" + oldest;
			FileHandle oldestFile = FileIO.OpenFile(oldestPath, FileMode.READ);
			if (oldestFile)
			{
				totalBytes -= oldestFile.GetLength();
				oldestFile.Close();
			}
			else
			{
				return RFO_ObserverMailboxDisposition.STORAGE_UNAVAILABLE;
			}
			RFO_ObserverMailboxDisposition pruned = DeleteOrAbsent(oldestPath, oldest, QUARANTINE_DIRECTORY, EvidenceExtension(oldest));
			if (pruned != RFO_ObserverMailboxDisposition.DISPOSED)
				return pruned;
			files.RemoveOrdered(0);
		}
		if (files.Count() + incomingRecords > MAX_QUARANTINE_FILES || totalBytes + incomingBytes > MAX_QUARANTINE_BYTES)
			return RFO_ObserverMailboxDisposition.STORAGE_UNAVAILABLE;
		return RFO_ObserverMailboxDisposition.DISPOSED;
	}

	// DeleteFile returns false both for a raced ENOENT and for a busy/error
	// result. Re-enumerate the exact bounded directory: absence is disposed;
	// continued presence is an unproven bound and must fail closed.
	protected RFO_ObserverMailboxDisposition DeleteOrAbsent(string path, string name, string directory, string extension)
	{
		if (FileIO.DeleteFile(path))
			return RFO_ObserverMailboxDisposition.DISPOSED;
		array<string> files = {};
		if (!FileIO.FindFiles(files.Insert, directory, extension))
			return RFO_ObserverMailboxDisposition.STORAGE_UNAVAILABLE;
		foreach (string candidatePath : files)
		{
			if (BaseName(candidatePath) == name)
				return RFO_ObserverMailboxDisposition.RETAINED_FOR_RETRY;
		}
		return RFO_ObserverMailboxDisposition.DISPOSED;
	}

	protected string NewQuarantineEvidenceName(string name)
	{
		if (name.Length() <= 220)
			return RFO_ObserverTime.Pad(System.GetUnixTime(), 12) + "-" + name;
		// Windows permits a 255-character source component, leaving no room for a
		// timestamp prefix. Replacing the known extension is a same-length,
		// reversible, collision-free mapping in the separate quarantine directory.
		if (!name.EndsWith(".json") || name.Length() <= 5)
			return "";
		return name.Substring(0, name.Length() - 5) + ".rfoq";
	}

	// Returns -1 when absent, -2 when the quarantine inventory cannot be proven,
	// and -3 after an invalid incomplete candidate was provably removed. The -3
	// result deliberately retains the source for this poll; the next poll may
	// publish a fresh envelope. Only a positive, readable, schema-valid envelope
	// exactly bound to this source command is durable evidence.
	protected int QuarantineEvidenceBytes(string name)
	{
		bool longName = name.Length() > 220;
		string exactLongName;
		string extension = ".json";
		if (longName)
		{
			exactLongName = NewQuarantineEvidenceName(name);
			if (exactLongName.IsEmpty())
				return -2;
			extension = ".rfoq";
		}
		array<string> files = {};
		if (!FileIO.FindFiles(files.Insert, QUARANTINE_DIRECTORY, extension))
			return -2;
		foreach (string candidatePath : files)
		{
			string candidateName = BaseName(candidatePath);
			bool exactMatch = candidateName == exactLongName;
			if (!longName)
				exactMatch = candidateName.Length() == name.Length() + 13 && IsTimestampedEvidenceName(candidateName) && candidateName.Substring(13, name.Length()) == name;
			if (!exactMatch)
				continue;
			string evidencePath = QUARANTINE_DIRECTORY + "/" + candidateName;
			FileHandle evidence = FileIO.OpenFile(evidencePath, FileMode.READ);
			if (!evidence)
				return -2;
			int length = evidence.GetLength();
			evidence.Close();
			if (length <= 0 || length > 65536)
			{
				RFO_ObserverMailboxDisposition removedInvalidSize = DeleteOrAbsent(evidencePath, candidateName, QUARANTINE_DIRECTORY, extension);
				if (removedInvalidSize == RFO_ObserverMailboxDisposition.DISPOSED)
					return -3;
				return -2;
			}
			RFO_ObserverMailboxQuarantineEvidence envelope = new RFO_ObserverMailboxQuarantineEvidence();
			if (!envelope.LoadFromFile(evidencePath))
			{
				RFO_ObserverMailboxDisposition removedIncomplete = DeleteOrAbsent(evidencePath, candidateName, QUARANTINE_DIRECTORY, extension);
				if (removedIncomplete == RFO_ObserverMailboxDisposition.DISPOSED)
					return -3;
				return -2;
			}
			if (envelope.schemaVersion != 1 || envelope.disposition != "permanent_rejection" || envelope.sourceName != name)
				return -2;
			if (envelope.reason.IsEmpty() || envelope.reason.Length() > 128 || envelope.sourceBytes < 0 || envelope.sourceBytes > 262145 || envelope.retainedAtUnix <= 0 || envelope.retainedAtUnix > System.GetUnixTime())
				return -2;
			return length;
		}
		return -1;
	}

	protected bool IsTimestampedEvidenceName(string name)
	{
		if (name.Length() < 13 || name.Substring(12, 1) != "-")
			return false;
		for (int index = 0; index < 12; index++)
		{
			int character = name.ToAscii(index);
			if (character < 48 || character > 57)
				return false;
		}
		return true;
	}

	protected string EvidenceExtension(string name)
	{
		if (name.EndsWith(".rfoq"))
			return ".rfoq";
		return ".json";
	}

	protected int BoundedEvidenceSourceBytes(int sourceBytes)
	{
		if (sourceBytes < 0)
			return 0;
		if (sourceBytes > 262144)
			return 262145;
		return sourceBytes;
	}

	protected void RecordIngressDisposition(string name, string reason, RFO_ObserverMailboxDisposition disposition)
	{
		if (disposition == RFO_ObserverMailboxDisposition.STORAGE_UNAVAILABLE)
			m_RFO_IngressHealthy = false;
		if (disposition != RFO_ObserverMailboxDisposition.DISPOSED)
			Print(string.Format("ReforgerForge Observer: mailbox command disposition=%1 file=%2 reason=%3", DispositionName(disposition), name, reason), LogLevel.WARNING);
	}

	protected string DispositionName(RFO_ObserverMailboxDisposition disposition)
	{
		if (disposition == RFO_ObserverMailboxDisposition.DISPOSED)
			return "disposed";
		if (disposition == RFO_ObserverMailboxDisposition.RETAINED_FOR_RETRY)
			return "retained_for_retry";
		return "storage_unavailable";
	}

	override void Shutdown()
	{
		m_RFO_Initialized = false;
		m_RFO_IngressHealthy = false;
		m_RFO_EgressHealthy = false;
		m_RFO_RetryAttempts.Clear();
		m_RFO_RetryFirstSeen.Clear();
		m_RFO_AcceptedPendingCleanup.Clear();
	}
}
