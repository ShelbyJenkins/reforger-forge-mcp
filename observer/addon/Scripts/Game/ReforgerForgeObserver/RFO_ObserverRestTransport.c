enum RFO_ObserverTransportPriority
{
	RESTORATION_OR_TERMINAL,
	ARTIFACT,
	PROGRESS,
	REGISTRATION,
	HEARTBEAT,
	COMMAND_POLL
}

class RFO_ObserverRestWorkItem
{
	string key;
	string endpoint;
	string operation;
	string payload;
	RFO_ObserverTransportPriority priority;
	int attempts;
	int nextAttemptMs;
	int order;
	bool durable;
}

class RFO_ObserverRestTransport : RFO_ObserverTransport
{
	static const int MAX_QUEUE_ITEMS = 64;
	static const int MIN_POLL_INTERVAL_MS = 250;
	static const int MAX_POLL_INTERVAL_MS = 2000;
	static const int MAX_RETRY_DELAY_MS = 5000;

	protected ref RFO_ObserverSession m_RFO_Session;
	protected RFO_ObserverService m_RFO_Service;
	protected RestContext m_RFO_Context;
	protected ref RestCallback m_RFO_Callback;
	protected ref array<ref RFO_ObserverRestWorkItem> m_RFO_Queue;
	protected RFO_ObserverRestWorkItem m_RFO_Active;
	protected int m_RFO_Order;
	protected int m_RFO_NextPollMs;
	protected int m_RFO_PollIntervalMs = MIN_POLL_INTERVAL_MS;
	protected bool m_RFO_Shutdown;

	override string GetName()
	{
		return "rest";
	}

	override bool Initialize(RFO_ObserverSession session, RFO_ObserverService service)
	{
		if (!session || !session.AllowsTransport("rest"))
			return false;
		m_RFO_Session = session;
		m_RFO_Service = service;
		m_RFO_Queue = new array<ref RFO_ObserverRestWorkItem>();
		string restHost = session.agent.host;
		if (restHost == "::1")
			restHost = "[::1]";
		string baseUrl = string.Format("http://%1:%2/", restHost, session.agent.port);
		m_RFO_Context = GetGame().GetRestApi().GetContext(baseUrl);
		if (!m_RFO_Context)
			return false;
		if (!m_RFO_Context.SetHeaders("Content-Type: application/json"))
		{
			m_RFO_Context = null;
			return false;
		}
		m_RFO_Callback = new RestCallback();
		m_RFO_Callback.SetOnSuccess(OnRestSuccess);
		m_RFO_Callback.SetOnError(OnRestError);
		return true;
	}

	protected void OnRestSuccess(RestCallback callback)
	{
		if (!callback)
		{
			OnRequestFailure(-2);
			return;
		}
		string data = callback.GetData();
		OnRequestSuccess(data, data.Length());
	}

	protected void OnRestError(RestCallback callback)
	{
		int errorCode = -1;
		if (callback)
			errorCode = callback.GetRestResult();
		OnRequestFailure(errorCode);
	}

	override void Update()
	{
		if (m_RFO_Shutdown || !m_RFO_Context || m_RFO_Active)
			return;
		int now = System.GetTickCount();
		RFO_ObserverRestWorkItem selected;
		for (int index = 0; index < m_RFO_Queue.Count(); index++)
		{
			RFO_ObserverRestWorkItem candidate = m_RFO_Queue[index];
			if (candidate.nextAttemptMs > now)
				continue;
			if (!selected || candidate.priority < selected.priority || (candidate.priority == selected.priority && candidate.order < selected.order))
				selected = candidate;
		}
		if (!selected)
			return;

		m_RFO_Active = selected;
		int requestId = m_RFO_Context.POST(m_RFO_Callback, selected.endpoint, selected.payload);
		if (requestId <= 0)
		{
			m_RFO_Active = null;
			Retry(selected);
			if (m_RFO_Service)
				m_RFO_Service.OnTransportFailure(selected.operation, requestId);
		}
	}

	override bool RegisterInstance(string registrationJson)
	{
		return QueueUnique("registration", "v1/runtime/register", "register", registrationJson, RFO_ObserverTransportPriority.REGISTRATION, true);
	}

	override bool Heartbeat(string heartbeatJson)
	{
		return QueueUnique("heartbeat", "v1/runtime/heartbeat", "heartbeat", heartbeatJson, RFO_ObserverTransportPriority.HEARTBEAT, false, true);
	}

	override bool PollCommand()
	{
		if (System.GetTickCount() < m_RFO_NextPollMs)
			return true;
		return QueueUnique("commands", "v1/runtime/commands", "commands", m_RFO_Service.BuildCommandPollJson(), RFO_ObserverTransportPriority.COMMAND_POLL, false);
	}

	override bool SubmitStatus(string statusJson)
	{
		string key = "status-" + m_RFO_Service.GetStatusQueueKey();
		RFO_ObserverTransportPriority priority = RFO_ObserverTransportPriority.PROGRESS;
		if (m_RFO_Service.IsRestorationOrTerminalStatus())
			priority = RFO_ObserverTransportPriority.RESTORATION_OR_TERMINAL;
		return QueueUnique(key, "v1/runtime/status", "status", statusJson, priority, true);
	}

	override bool SubmitArtifact(string manifestJson)
	{
		return QueueUnique("artifact-" + m_RFO_Service.GetActiveJobId(), "v1/runtime/artifact", "artifact", manifestJson, RFO_ObserverTransportPriority.ARTIFACT, true);
	}

	void OnRequestSuccess(string data, int dataSize)
	{
		RFO_ObserverRestWorkItem item = m_RFO_Active;
		m_RFO_Active = null;
		if (!item)
			return;
		bool accepted = dataSize >= 0 && dataSize <= 262144 && m_RFO_Service && m_RFO_Service.OnTransportSuccess(item.operation, data, dataSize);
		if (accepted)
			m_RFO_Queue.RemoveItem(item);
		else
		{
			Retry(item);
			if (m_RFO_Service)
				m_RFO_Service.OnTransportFailure(item.operation, -2);
		}
	}

	void OnRequestFailure(int errorCode)
	{
		RFO_ObserverRestWorkItem item = m_RFO_Active;
		m_RFO_Active = null;
		if (!item)
			return;
		Retry(item);
		if (m_RFO_Service)
			m_RFO_Service.OnTransportFailure(item.operation, errorCode);
	}

	void CommandPollCompleted(bool commandReceived)
	{
		if (commandReceived)
			m_RFO_PollIntervalMs = MIN_POLL_INTERVAL_MS;
		else
			m_RFO_PollIntervalMs = Math.Min(m_RFO_PollIntervalMs * 2, MAX_POLL_INTERVAL_MS);
		m_RFO_NextPollMs = System.GetTickCount() + m_RFO_PollIntervalMs;
	}

	protected bool QueueUnique(string key, string endpoint, string operation, string payload, RFO_ObserverTransportPriority priority, bool durable, bool replacePayload = false)
	{
		if (m_RFO_Shutdown || !m_RFO_Context || payload.Length() <= 1 || payload.Length() > 262144)
			return false;
		for (int index = 0; index < m_RFO_Queue.Count(); index++)
		{
			RFO_ObserverRestWorkItem existing = m_RFO_Queue[index];
			if (existing.key != key)
				continue;
			if (replacePayload && existing != m_RFO_Active)
				existing.payload = payload;
			return true;
		}
		if (!MakeRoom(priority))
			return false;
		RFO_ObserverRestWorkItem item = new RFO_ObserverRestWorkItem();
		item.key = key;
		item.endpoint = endpoint;
		item.operation = operation;
		item.payload = payload;
		item.priority = priority;
		item.durable = durable;
		item.order = ++m_RFO_Order;
		m_RFO_Queue.Insert(item);
		return true;
	}

	protected bool MakeRoom(RFO_ObserverTransportPriority incomingPriority)
	{
		if (m_RFO_Queue.Count() < MAX_QUEUE_ITEMS)
			return true;
		RFO_ObserverRestWorkItem candidate;
		for (int index = 0; index < m_RFO_Queue.Count(); index++)
		{
			RFO_ObserverRestWorkItem item = m_RFO_Queue[index];
			if (item == m_RFO_Active || item.durable || item.priority < incomingPriority)
				continue;
			if (!candidate || item.priority > candidate.priority)
				candidate = item;
		}
		if (!candidate)
			return false;
		m_RFO_Queue.RemoveItem(candidate);
		return true;
	}

	protected void Retry(RFO_ObserverRestWorkItem item)
	{
		if (!item || m_RFO_Shutdown)
			return;
		item.attempts++;
		int delay = 250;
		for (int attempt = 1; attempt < item.attempts && delay < MAX_RETRY_DELAY_MS; attempt++)
			delay = Math.Min(delay * 2, MAX_RETRY_DELAY_MS);
		item.nextAttemptMs = System.GetTickCount() + delay;
		if (item.operation == "commands")
			m_RFO_NextPollMs = item.nextAttemptMs;
	}

	override void Shutdown()
	{
		m_RFO_Shutdown = true;
		// Dropping the retained callback cancels an in-flight request without
		// using the obsolete RestContext.reset API.
		m_RFO_Callback = null;
		m_RFO_Context = null;
		m_RFO_Active = null;
		if (m_RFO_Queue)
			m_RFO_Queue.Clear();
	}
}
