class RFO_ObserverMailboxTransport : RFO_ObserverTransport
{
	static const string COMMAND_DIRECTORY = "$profile:ReforgerForgeObserver/mailbox/commands";
	static const string STATUS_DIRECTORY = "$profile:ReforgerForgeObserver/mailbox/status";
	static const string QUARANTINE_DIRECTORY = "$profile:ReforgerForgeObserver/mailbox/quarantine/commands";
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
	protected bool m_RFO_Ready;
	protected int m_RFO_Sequence;
	protected int m_RFO_WriterNonce;
	protected int m_RFO_NextPollMs;
	protected int m_RFO_DispositionSequence;
	protected string m_RFO_CommandCursor;
	protected ref map<string, int> m_RFO_RetryAttempts;
	protected ref map<string, int> m_RFO_RetryFirstSeen;

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
		m_RFO_Ready = FileIO.MakeDirectory(COMMAND_DIRECTORY) && FileIO.MakeDirectory(STATUS_DIRECTORY) && FileIO.MakeDirectory(QUARANTINE_DIRECTORY);
		TrimQuarantine(0);
		return m_RFO_Ready;
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
		if (!m_RFO_Ready || System.GetTickCount() < m_RFO_NextPollMs)
			return m_RFO_Ready;
		m_RFO_NextPollMs = System.GetTickCount() + POLL_INTERVAL_MS;
		array<string> files = {};
		if (!FileIO.FindFiles(files.Insert, COMMAND_DIRECTORY, ".json"))
			return false;
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
			if (!IsOwnedCommandName(name))
			{
				QuarantineCommand(name, path, "invalid_name", -1);
				continue;
			}
			FileHandle file = FileIO.OpenFile(path, FileMode.READ);
			if (!file)
			{
				RetryCommand(name, path, "open_failed", -1);
				continue;
			}
			int length = file.GetLength();
			file.Close();
			if (length <= 2 || length > 262144)
			{
				QuarantineCommand(name, path, "invalid_size", length);
				continue;
			}
			RFO_ObserverRuntimeCommand command = new RFO_ObserverRuntimeCommand();
			if (!command.LoadFromFile(path) || !command.IsBoundedEnvelope())
			{
				QuarantineCommand(name, path, "invalid_envelope", length);
				continue;
			}
			if (command.instanceId != m_RFO_Service.GetRuntimeInstanceId())
			{
				QuarantineCommand(name, path, "wrong_instance", length);
				continue;
			}
			if (RFO_ObserverTime.IsExpired(command.deliveryLeaseExpiresAt))
			{
				QuarantineCommand(name, path, "delivery_expired", length);
				continue;
			}
			if (m_RFO_Service.OnRuntimeCommand(command))
			{
				ClearRetry(name);
				if (!FileIO.DeleteFile(path))
					QuarantineCommand(name, path, "accepted_cleanup", length);
				return true;
			}
			RetryCommand(name, path, "temporarily_rejected", length);
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
		if (!m_RFO_Ready || data.Length() <= 1 || data.Length() > 262144)
			return false;
		array<string> existingFiles = {};
		if (!FileIO.FindFiles(existingFiles.Insert, STATUS_DIRECTORY, ".json") || existingFiles.Count() >= MAX_STATUS_FILES)
			return false;
		m_RFO_Sequence++;
		// A writer nonce keeps files unique if the game script VM is recreated in
		// the same wall-clock second while the stable launch instance identity is
		// intentionally retained.
		string name = string.Format("%1-%2-%3-%4-%5.json", RFO_ObserverTime.Pad(m_RFO_Sequence, 12), kind, m_RFO_Service.GetRuntimeInstanceId(), m_RFO_WriterNonce, m_RFO_Sequence);
		string temporary = STATUS_DIRECTORY + "/" + name + ".tmp";
		string complete = STATUS_DIRECTORY + "/" + name;
		FileHandle file = FileIO.OpenFile(temporary, FileMode.WRITE);
		if (!file)
			return false;
		file.Write(data, data.Length());
		file.Close();
		if (!FileIO.CopyFile(temporary, complete))
		{
			FileIO.DeleteFile(temporary);
			return false;
		}
		FileHandle marker = FileIO.OpenFile(complete + ".complete", FileMode.WRITE);
		if (!marker)
		{
			FileIO.DeleteFile(complete);
			FileIO.DeleteFile(temporary);
			return false;
		}
		marker.WriteLine("ready");
		marker.Close();
		FileIO.DeleteFile(temporary);
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

	protected void RetryCommand(string name, string path, string reason, int length)
	{
		int now = System.GetUnixTime();
		if (!m_RFO_RetryAttempts.Contains(name) && m_RFO_RetryAttempts.Count() >= MAX_RETRY_TRACKING)
		{
			QuarantineCommand(name, path, "retry_tracking_limit", length);
			return;
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
			QuarantineCommand(name, path, reason, length);
	}

	protected void ClearRetry(string name)
	{
		m_RFO_RetryAttempts.Remove(name);
		m_RFO_RetryFirstSeen.Remove(name);
	}

	protected void QuarantineCommand(string name, string path, string reason, int length)
	{
		ClearRetry(name);
		int retainedBytes = length;
		if (retainedBytes <= 0 || retainedBytes > 262144)
			retainedBytes = 512;
		TrimQuarantine(retainedBytes);
		m_RFO_DispositionSequence++;
		string targetName = string.Format("%1-%2-%3-%4.json", RFO_ObserverTime.Pad(System.GetUnixTime(), 12), m_RFO_WriterNonce, m_RFO_DispositionSequence, reason);
		string target = QUARANTINE_DIRECTORY + "/" + targetName;
		bool retained;
		if (length > 0 && length <= 262144)
			retained = FileIO.CopyFile(path, target);
		if (!retained)
		{
			string disposition = "{\"disposition\":\"permanent_rejection\",\"reason\":" + RFO_ObserverJson.Quote(reason);
			disposition += ",\"sourceName\":" + RFO_ObserverJson.Quote(name) + ",\"sourceBytes\":" + length.ToString() + "}";
			FileHandle evidence = FileIO.OpenFile(target, FileMode.WRITE);
			if (evidence)
			{
				evidence.Write(disposition, disposition.Length());
				evidence.Close();
				retained = true;
			}
		}
		// Permanent rejection always makes forward progress. If forensic storage
		// cannot be retained, the exact poison command is still removed.
		FileIO.DeleteFile(path);
		TrimQuarantine(0);
		Print(string.Format("ReforgerForge Observer: mailbox command disposition=quarantined file=%1 reason=%2 retained=%3", name, reason, retained), LogLevel.WARNING);
	}

	protected void TrimQuarantine(int incomingBytes)
	{
		array<string> files = {};
		if (!FileIO.FindFiles(files.Insert, QUARANTINE_DIRECTORY, ".json"))
			return;
		files.Sort();
		int now = System.GetUnixTime();
		int totalBytes;
		for (int index = files.Count() - 1; index >= 0; index--)
		{
			string name = BaseName(files[index]);
			int createdAt;
			if (name.Length() >= 12)
				createdAt = name.Substring(0, 12).ToInt();
			if (createdAt > 0 && now - createdAt > MAX_QUARANTINE_AGE_SECONDS)
			{
				FileIO.DeleteFile(QUARANTINE_DIRECTORY + "/" + name);
				files.RemoveOrdered(index);
				continue;
			}
			FileHandle file = FileIO.OpenFile(QUARANTINE_DIRECTORY + "/" + name, FileMode.READ);
			if (file)
			{
				totalBytes += file.GetLength();
				file.Close();
			}
		}
		while (files.Count() >= MAX_QUARANTINE_FILES || totalBytes + incomingBytes > MAX_QUARANTINE_BYTES)
		{
			if (files.Count() == 0)
				break;
			string oldest = BaseName(files[0]);
			string oldestPath = QUARANTINE_DIRECTORY + "/" + oldest;
			FileHandle oldestFile = FileIO.OpenFile(oldestPath, FileMode.READ);
			if (oldestFile)
			{
				totalBytes -= oldestFile.GetLength();
				oldestFile.Close();
			}
			FileIO.DeleteFile(oldestPath);
			files.RemoveOrdered(0);
		}
	}

	override void Shutdown()
	{
		m_RFO_Ready = false;
		m_RFO_RetryAttempts.Clear();
		m_RFO_RetryFirstSeen.Clear();
	}
}
