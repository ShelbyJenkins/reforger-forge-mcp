class RFO_ObserverMailboxTransport : RFO_ObserverTransport
{
	static const string COMMAND_DIRECTORY = "$profile:ReforgerForgeObserver/mailbox/commands";
	static const string STATUS_DIRECTORY = "$profile:ReforgerForgeObserver/mailbox/status";
	static const int MAX_COMMAND_FILES = 256;
	static const int MAX_STATUS_FILES = 512;
	static const int POLL_INTERVAL_MS = 250;
	protected ref RFO_ObserverSession m_RFO_Session;
	protected RFO_ObserverService m_RFO_Service;
	protected bool m_RFO_Ready;
	protected int m_RFO_Sequence;
	protected int m_RFO_WriterNonce;
	protected int m_RFO_NextPollMs;

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
		m_RFO_Ready = FileIO.MakeDirectory(COMMAND_DIRECTORY) && FileIO.MakeDirectory(STATUS_DIRECTORY);
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
		int inspected;
		for (int index = 0; index < files.Count() && inspected < MAX_COMMAND_FILES; index++)
		{
			string name = BaseName(files[index]);
			if (!IsOwnedCommandName(name))
				continue;
			inspected++;
			string path = COMMAND_DIRECTORY + "/" + name;
			FileHandle file = FileIO.OpenFile(path, FileMode.READ);
			if (!file)
				continue;
			int length = file.GetLength();
			file.Close();
			if (length <= 2 || length > 262144)
				continue;
			RFO_ObserverRuntimeCommand command = new RFO_ObserverRuntimeCommand();
			if (!command.LoadFromFile(path) || !command.IsBoundedEnvelope())
				continue;
			if (m_RFO_Service.OnRuntimeCommand(command))
			{
				FileIO.DeleteFile(path);
				return true;
			}
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

	override void Shutdown()
	{
		m_RFO_Ready = false;
	}
}
