class RFO_ObserverService
{
	protected static ref RFO_ObserverService s_RFO_Instance;
	protected ref RFO_ObserverSession m_RFO_Session;
	protected ref RFO_ObserverTransport m_RFO_Transport;
	protected ref RFO_ObserverWorld m_RFO_World;
	protected ref RFO_ObserverCameraLease m_RFO_CameraLease;
	protected ref RFO_ObserverCapture m_RFO_Capture;
	protected ref RFO_ObserverJob m_RFO_ActiveJob;
	protected ref array<int> m_RFO_CaptureTimes;
	protected string m_RFO_InstanceId;
	protected string m_RFO_InstanceNonce;
	protected string m_RFO_RuntimeKind;
	protected string m_RFO_PendingStatusJson;
	protected string m_RFO_PendingArtifactJson;
	protected string m_RFO_LastErrorCode;
	protected string m_RFO_PostFrameCaptureDiagnostic;
	protected int m_RFO_LastHeartbeatUnix;
	protected int m_RFO_HeartbeatSequence;
	protected int m_RFO_TransportFailures;
	protected int m_RFO_LastTransportSuccessUnix;
	protected int m_RFO_RuntimeDetectionReadyMs;
	protected int m_RFO_FrameCounter;
	protected bool m_RFO_RegistrationQueued;
	protected bool m_RFO_Registered;
	protected bool m_RFO_CameraSubsystemSafe = true;
	protected bool m_RFO_Active;
	protected bool m_RFO_ActivationLogged;
	protected bool m_RFO_RuntimeMismatchLogged;
	protected bool m_RFO_RegistrationLogged;
	protected bool m_RFO_FallbackLogged;
	protected bool m_RFO_ContractFailureLogged;
	protected bool m_RFO_PostFrameCaptureArmed;
	protected bool m_RFO_PostFrameCaptureFailed;

	static RFO_ObserverService GetInstance()
	{
		if (!s_RFO_Instance)
			s_RFO_Instance = new RFO_ObserverService();
		return s_RFO_Instance;
	}

	void Start(BaseWorld world)
	{
		if (m_RFO_Active)
			return;
		m_RFO_Session = new RFO_ObserverSession();
		if (!m_RFO_Session.LoadAndValidate())
		{
			if (!m_RFO_ContractFailureLogged && FileIO.FileExists(RFO_ObserverSession.CONTRACT_PATH))
			{
				Print(string.Format("ReforgerForge Observer: activation contract present but rejected reason=%1", m_RFO_Session.GetValidationFailure()), LogLevel.ERROR);
				m_RFO_ContractFailureLogged = true;
			}
			return;
		}

		m_RFO_World = new RFO_ObserverWorld();
		m_RFO_World.Refresh(world);
		m_RFO_CameraLease = new RFO_ObserverCameraLease();
		m_RFO_Capture = new RFO_ObserverCapture();
		m_RFO_Capture.Initialize();
		m_RFO_CaptureTimes = new array<int>();
		// Game scripts can be recompiled and their VM recreated while the same
		// prepared engine launch moves from bootstrap/menu worlds into the target
		// world. The profile contract is exclusive to one launched process, so its
		// launch identity is the only value that remains stable across that VM
		// rollover. Reusing it prevents a normal same-launch world transition from
		// masquerading as an unsupported second process.
		m_RFO_InstanceId = "runtime-" + m_RFO_Session.sessionId;
		m_RFO_InstanceNonce = m_RFO_Session.launchNonce;
		m_RFO_RuntimeDetectionReadyMs = System.GetTickCount() + 1000;
		m_RFO_LastTransportSuccessUnix = System.GetUnixTime();
		m_RFO_PostFrameCaptureArmed = false;
		m_RFO_PostFrameCaptureFailed = false;
		m_RFO_PostFrameCaptureDiagnostic = string.Empty;

		RFO_ObserverRestTransport rest = new RFO_ObserverRestTransport();
		if (rest.Initialize(m_RFO_Session, this))
			m_RFO_Transport = rest;
		else
		{
			RFO_ObserverMailboxTransport mailbox = new RFO_ObserverMailboxTransport();
			if (mailbox.Initialize(m_RFO_Session, this))
				m_RFO_Transport = mailbox;
		}
		m_RFO_Active = m_RFO_Transport != null;
	}

	void Update(BaseWorld world, float timeSlice)
	{
		if (!m_RFO_Active)
			return;
		m_RFO_FrameCounter++;
		if (m_RFO_Session.expiresAtUnix <= System.GetUnixTime())
		{
			Shutdown(world);
			return;
		}

		bool worldChanged = m_RFO_World.Refresh(world);
		if (worldChanged && m_RFO_ActiveJob && !m_RFO_ActiveJob.IsTerminal())
			RecordFailure("WORLD_CHANGED", "The active world generation changed during capture", false);

		if (!m_RFO_Registered)
		{
			TryRegister();
			if (m_RFO_TransportFailures >= 3)
				SwitchToMailboxFallback();
			m_RFO_Transport.Update();
			return;
		}

		if (System.GetUnixTime() - m_RFO_LastHeartbeatUnix >= 5)
		{
			if (m_RFO_Transport.Heartbeat(BuildHeartbeatJson()))
				m_RFO_LastHeartbeatUnix = System.GetUnixTime();
			else
				m_RFO_TransportFailures++;
		}

		ProcessActiveJob(world);
		m_RFO_Transport.PollCommand();
		if (m_RFO_TransportFailures >= 3)
			SwitchToMailboxFallback();
		m_RFO_Transport.Update();

		if (m_RFO_TransportFailures >= 3 && System.GetUnixTime() - m_RFO_LastTransportSuccessUnix >= 5 && m_RFO_ActiveJob && m_RFO_CameraLease.HasOutstandingLease())
			RecordFailure("TRANSPORT_UNAVAILABLE", "Observer transport was unavailable while a camera lease was held", false);
	}

	// RFO_ObserverCamera invokes this after all normal frame updates. Explicit
	// views are committed and captured here so gameplay camera code cannot replace
	// the requested matrix between observer verification and screenshot issuance.
	void OnObserverCameraPostFrame(RFO_ObserverCamera camera, BaseWorld world, float timeSlice)
	{
		if (!m_RFO_Active || !m_RFO_ActiveJob || !m_RFO_CameraLease || !m_RFO_World)
			return;
		if (!m_RFO_CameraLease.CommitPostFrame(camera, world, m_RFO_World.GetEpoch(), timeSlice))
			return;
		if (!m_RFO_PostFrameCaptureArmed || !m_RFO_ActiveJob.IsCameraView() || m_RFO_ActiveJob.state != RFO_ObserverJobState.CAPTURING || m_RFO_ActiveJob.screenshotIssued)
			return;
		if (!m_RFO_Capture.IssueCommitted(m_RFO_ActiveJob, world, m_RFO_FrameCounter, m_RFO_CameraLease.GetObserverCameraId()))
		{
			m_RFO_PostFrameCaptureDiagnostic = m_RFO_Capture.GetLastIssueDiagnostic();
			m_RFO_PostFrameCaptureFailed = true;
		}
		m_RFO_PostFrameCaptureArmed = false;
	}

	void Shutdown(BaseWorld world)
	{
		if (m_RFO_CameraLease && m_RFO_CameraLease.HasOutstandingLease())
		{
			RestoreBeforeTerminal(world);
			if (m_RFO_CameraLease.HasOutstandingLease())
				return;
		}
		if (m_RFO_Transport)
			m_RFO_Transport.Shutdown();
		m_RFO_Registered = false;
		m_RFO_Active = false;
	}

	protected bool RestoreBeforeTerminal(BaseWorld world)
	{
		if (!m_RFO_CameraLease)
			return true;
		if (!m_RFO_ActiveJob)
			return !m_RFO_CameraLease.HasOutstandingLease();
		return m_RFO_CameraLease.Restore(m_RFO_ActiveJob.jobId, world, m_RFO_World.GetEpoch());
	}

	bool OnRuntimeCommand(RFO_ObserverRuntimeCommand command)
	{
		if (!command || !command.IsBoundedEnvelope() || command.instanceId != m_RFO_InstanceId || RFO_ObserverTime.IsExpired(command.deliveryLeaseExpiresAt))
			return false;
		if (command.commandKind == "cancel")
		{
			if (m_RFO_ActiveJob && m_RFO_ActiveJob.jobId == command.jobId)
			{
				if (!m_RFO_ActiveJob.MatchesRequest(command))
					return false;
				m_RFO_ActiveJob.RequestCancellation(command.deliveryToken);
				return true;
			}
			return RejectCommand(command, "CANCELLED", "Capture cancellation was acknowledged after local work ended", true);
		}
		if (m_RFO_ActiveJob)
			return m_RFO_ActiveJob.MatchesRequest(command) && m_RFO_ActiveJob.deliveryToken == command.deliveryToken;

		RFO_ObserverJob job = new RFO_ObserverJob();
		if (!job.Initialize(command, m_RFO_Session, m_RFO_World))
			return RejectCommand(command, "CAPTURE_REJECTED", "Runtime capture validation rejected the command", false);
		m_RFO_ActiveJob = job;
		m_RFO_PostFrameCaptureArmed = false;
		m_RFO_PostFrameCaptureFailed = false;
		m_RFO_PostFrameCaptureDiagnostic = string.Empty;
		Print(string.Format("ReforgerForge Observer: job accepted jobId=%1 view=%2", job.jobId, job.viewKind));
		if (!CaptureRateAvailable())
		{
			RecordFailure("CAPTURE_REJECTED", "Runtime session capture rate limit was reached", false);
			return true;
		}
		m_RFO_CaptureTimes.Insert(System.GetUnixTime());
		if (!m_RFO_Capture.IsReady())
		{
			RecordFailure("CAPABILITY_UNAVAILABLE", "This runtime has no proven screenshot capability", false);
			return true;
		}
		if (job.IsCameraView() && !RFO_ObserverCapabilities.CAMERA_RESTORE_PROVEN)
		{
			RecordFailure("CAPABILITY_UNAVAILABLE", "This runtime has no proven camera restoration capability", false);
			return true;
		}
		PublishStatus();
		return true;
	}

	bool OnTransportSuccess(string operation, string data, int dataSize)
	{
		if (dataSize < 0 || dataSize > 262144)
			return false;
		if (operation == "commands")
		{
			RFO_ObserverCommandResponse response = new RFO_ObserverCommandResponse();
			response.ExpandFromRAW(data);
			bool commandReceived = response.command && !response.command.jobId.IsEmpty();
			if (commandReceived && (!response.command.IsBoundedEnvelope() || !OnRuntimeCommand(response.command)))
				return false;
			RFO_ObserverRestTransport rest = RFO_ObserverRestTransport.Cast(m_RFO_Transport);
			if (rest)
				rest.CommandPollCompleted(commandReceived);
		}
		else
		{
			RFO_ObserverAcknowledgement acknowledgement = new RFO_ObserverAcknowledgement();
			acknowledgement.ExpandFromRAW(data);
			if (!acknowledgement.accepted)
				return false;
			if (operation == "register")
			{
				if (acknowledgement.instanceId != m_RFO_InstanceId)
					return false;
				m_RFO_Registered = true;
				m_RFO_RegistrationQueued = false;
				LogRegistrationAccepted();
			}
			else if (operation == "status")
			{
				if (!m_RFO_ActiveJob || acknowledgement.jobId != m_RFO_ActiveJob.jobId || acknowledgement.sequence != m_RFO_ActiveJob.sequence)
					return false;
				m_RFO_ActiveJob.statusPending = false;
				m_RFO_PendingStatusJson = string.Empty;
				if (m_RFO_ActiveJob.IsTerminal())
					m_RFO_ActiveJob.terminalStatusDelivered = true;
			}
			else if (operation == "artifact")
			{
				if (!m_RFO_ActiveJob || !m_RFO_ActiveJob.artifactPending)
					return false;
				m_RFO_ActiveJob.artifactPending = false;
				m_RFO_PendingArtifactJson = string.Empty;
				m_RFO_ActiveJob.state = RFO_ObserverJobState.COMPLETED;
			}
		}
		m_RFO_TransportFailures = 0;
		m_RFO_LastTransportSuccessUnix = System.GetUnixTime();
		return true;
	}

	void OnTransportFailure(string operation, int errorCode)
	{
		m_RFO_TransportFailures++;
		m_RFO_LastErrorCode = "TRANSPORT_UNAVAILABLE";
	}

	string BuildRegistrationJson()
	{
		string selectedTransport = m_RFO_Transport.GetName();
		array<string> capabilities = CurrentCapabilities();
		string result = "{\"protocolVersion\":\"1.0\",\"addonVersion\":\"0.1.0\"";
		result += ",\"bundleDigest\":" + RFO_ObserverJson.Quote(m_RFO_Session.bundleDigest);
		result += ",\"buildIdentity\":" + RFO_ObserverJson.Quote(RFO_ObserverBuild.IDENTITY);
		result += ",\"agentInstanceId\":" + RFO_ObserverJson.Quote(m_RFO_Session.agent.instanceId);
		result += ",\"sessionId\":" + RFO_ObserverJson.Quote(m_RFO_Session.sessionId);
		result += ",\"launchNonce\":" + RFO_ObserverJson.Quote(m_RFO_Session.launchNonce);
		result += ",\"instanceId\":" + RFO_ObserverJson.Quote(m_RFO_InstanceId);
		result += ",\"instanceNonce\":" + RFO_ObserverJson.Quote(m_RFO_InstanceNonce);
		result += ",\"runtimeKind\":" + RFO_ObserverJson.Quote(m_RFO_RuntimeKind);
		result += ",\"capabilities\":" + BuildStringArray(capabilities);
		result += ",\"selectedTransport\":" + RFO_ObserverJson.Quote(selectedTransport);
		result += ",\"headless\":" + RFO_ObserverJson.Boolean(System.IsConsoleApp());
		result += ",\"worldId\":" + RFO_ObserverJson.NullableString(m_RFO_World.GetId());
		result += ",\"worldEpoch\":" + m_RFO_World.GetEpoch().ToString();
		result += ",\"registeredAt\":" + RFO_ObserverJson.Quote(RFO_ObserverTime.UtcNowIso());
		result += ",\"sessionToken\":" + RFO_ObserverJson.Quote(m_RFO_Session.sessionToken);
		return result + "}";
	}

	string BuildHeartbeatJson()
	{
		m_RFO_HeartbeatSequence++;
		string activeJob = "null";
		if (m_RFO_ActiveJob)
			activeJob = RFO_ObserverJson.Quote(m_RFO_ActiveJob.jobId);
		string cameraJob = "null";
		if (m_RFO_ActiveJob && m_RFO_CameraLease.IsHeld())
			cameraJob = RFO_ObserverJson.Quote(m_RFO_ActiveJob.jobId);
		string lastError = "null";
		if (!m_RFO_LastErrorCode.IsEmpty())
			lastError = RFO_ObserverJson.Quote(m_RFO_LastErrorCode);
		string result = "{\"protocolVersion\":\"1.0\"";
		result += ",\"sessionId\":" + RFO_ObserverJson.Quote(m_RFO_Session.sessionId);
		result += ",\"instanceId\":" + RFO_ObserverJson.Quote(m_RFO_InstanceId);
		result += ",\"instanceNonce\":" + RFO_ObserverJson.Quote(m_RFO_InstanceNonce);
		result += ",\"sequence\":" + m_RFO_HeartbeatSequence.ToString();
		result += ",\"sentAt\":" + RFO_ObserverJson.Quote(RFO_ObserverTime.UtcNowIso());
		result += ",\"worldId\":" + RFO_ObserverJson.NullableString(m_RFO_World.GetId());
		result += ",\"worldEpoch\":" + m_RFO_World.GetEpoch().ToString();
		result += ",\"capabilities\":" + BuildStringArray(CurrentCapabilities());
		result += ",\"activeJobId\":" + activeJob;
		result += ",\"cameraLeaseJobId\":" + cameraJob;
		result += ",\"transportHealthy\":" + RFO_ObserverJson.Boolean(m_RFO_TransportFailures < 3);
		result += ",\"lastErrorCode\":" + lastError;
		result += ",\"sessionToken\":" + RFO_ObserverJson.Quote(m_RFO_Session.sessionToken);
		return result + "}";
	}

	string BuildCommandPollJson()
	{
		string result = "{\"sessionId\":" + RFO_ObserverJson.Quote(m_RFO_Session.sessionId);
		result += ",\"instanceId\":" + RFO_ObserverJson.Quote(m_RFO_InstanceId);
		result += ",\"instanceNonce\":" + RFO_ObserverJson.Quote(m_RFO_InstanceNonce);
		result += ",\"sessionToken\":" + RFO_ObserverJson.Quote(m_RFO_Session.sessionToken);
		return result + "}";
	}

	string GetStatusQueueKey()
	{
		if (!m_RFO_ActiveJob)
			return "none";
		return m_RFO_ActiveJob.jobId + "-" + m_RFO_ActiveJob.sequence.ToString();
	}

	bool IsRestorationOrTerminalStatus()
	{
		if (!m_RFO_ActiveJob)
			return false;
		return m_RFO_ActiveJob.state == RFO_ObserverJobState.RESTORING || m_RFO_ActiveJob.state == RFO_ObserverJobState.FAILED || m_RFO_ActiveJob.state == RFO_ObserverJobState.CANCELLED;
	}

	string GetActiveJobId()
	{
		if (!m_RFO_ActiveJob)
			return "none";
		return m_RFO_ActiveJob.jobId;
	}

	string GetRuntimeInstanceId()
	{
		return m_RFO_InstanceId;
	}

	protected void TryRegister()
	{
		if (m_RFO_RegistrationQueued || System.GetTickCount() < m_RFO_RuntimeDetectionReadyMs)
			return;
		m_RFO_RuntimeKind = DetectRuntimeKind();
		if (!m_RFO_ActivationLogged)
		{
			string buildPrefix = m_RFO_Session.buildIdentity.Substring(0, 8);
			Print(string.Format("ReforgerForge Observer: activated runtimeKind=%1 transport=%2 build=%3", m_RFO_RuntimeKind, m_RFO_Transport.GetName(), buildPrefix));
			m_RFO_ActivationLogged = true;
		}
		if (m_RFO_RuntimeKind != m_RFO_Session.expectedRuntimeKind)
		{
			if (!m_RFO_RuntimeMismatchLogged)
			{
				Print(string.Format("ReforgerForge Observer: runtime-kind mismatch expected=%1 actual=%2", m_RFO_Session.expectedRuntimeKind, m_RFO_RuntimeKind), LogLevel.ERROR);
				m_RFO_RuntimeMismatchLogged = true;
			}
			return;
		}
		if (!m_RFO_Transport.RegisterInstance(BuildRegistrationJson()))
		{
			m_RFO_TransportFailures++;
			return;
		}
		m_RFO_RegistrationQueued = true;
		if (m_RFO_Transport.GetName() == "mailbox")
		{
			m_RFO_Registered = true;
			m_RFO_RegistrationQueued = false;
			LogRegistrationAccepted();
		}
	}

	protected string DetectRuntimeKind()
	{
		if (System.IsConsoleApp())
			return "dedicated";
		if (System.IsCLIParam("autotest"))
			return "testRunner";
		if (Replication.IsRunning() && Replication.IsServer())
			return "listenServer";
		return "client";
	}

	protected void ProcessActiveJob(BaseWorld world)
	{
		RFO_ObserverJob job = m_RFO_ActiveJob;
		if (!job)
			return;
		if (job.state == RFO_ObserverJobState.COMPLETED || (job.IsTerminal() && job.terminalStatusDelivered))
		{
			if (m_RFO_CameraLease.HasOutstandingLease())
			{
				if (!m_RFO_CameraLease.Restore(job.jobId, world, m_RFO_World.GetEpoch()))
				{
					if (m_RFO_CameraLease.HasOutstandingLease())
						return;
				}
				m_RFO_CameraSubsystemSafe = m_RFO_CameraLease.RestorationConfirmed();
			}
			m_RFO_ActiveJob = null;
			m_RFO_PendingStatusJson = string.Empty;
			m_RFO_PendingArtifactJson = string.Empty;
			m_RFO_PostFrameCaptureArmed = false;
			m_RFO_PostFrameCaptureFailed = false;
			m_RFO_PostFrameCaptureDiagnostic = string.Empty;
			return;
		}
		if (m_RFO_PostFrameCaptureFailed && job.terminalErrorCode.IsEmpty())
		{
			string diagnostic = m_RFO_PostFrameCaptureDiagnostic;
			if (diagnostic.IsEmpty())
				diagnostic = "Committed observer screenshot request was rejected";
			RecordFailure("CAPTURE_REJECTED", diagnostic, false);
			m_RFO_PostFrameCaptureFailed = false;
			m_RFO_PostFrameCaptureDiagnostic = string.Empty;
		}
		if (!job.statusPending && !m_RFO_PendingStatusJson.IsEmpty())
		{
			PublishStatus();
			return;
		}
		if (job.statusPending || job.artifactPending)
			return;

		if (job.cancellationRequested && job.terminalErrorCode.IsEmpty())
			RecordFailure("CANCELLED", "Capture was cancelled", true);
		else if (job.DeadlineExpired() && job.terminalErrorCode.IsEmpty())
			RecordFailure("CAPTURE_TIMEOUT", "Capture deadline expired", false);
		if (!job.terminalErrorCode.IsEmpty() && job.state != RFO_ObserverJobState.RESTORING && !job.IsTerminal())
		{
			BeginTerminalTransition();
			return;
		}
		if (job.IsTerminal())
		{
			PublishStatus();
			return;
		}

		switch (job.state)
		{
			case RFO_ObserverJobState.ACCEPTED:
				if (job.IsCameraView())
					AcquireCamera(world);
				else
				{
					if (!m_RFO_Capture.BeginPreload(world))
					{
						string diagnostic = m_RFO_Capture.GetLastPreloadDiagnostic();
						if (diagnostic.IsEmpty())
							diagnostic = "Current gameplay camera could not begin screenshot preload";
						RecordFailure("CAPTURE_REJECTED", diagnostic, false);
						BeginTerminalTransition();
						break;
					}
					job.state = RFO_ObserverJobState.PRELOADING;
					PublishStatus();
				}
				break;
			case RFO_ObserverJobState.ACQUIRING_CAMERA:
				job.state = RFO_ObserverJobState.POSITIONING;
				PublishStatus();
				break;
			case RFO_ObserverJobState.POSITIONING:
				if (job.IsCameraView() && !m_RFO_CameraLease.MaintainRequestedView(job.jobId))
				{
					if (m_RFO_CameraLease.AwaitingFirstPostFrameCommit(job.jobId))
						break;
					RecordFailure("CAMERA_OWNERSHIP_LOST", "Observer camera view could not be confirmed before preloading", false);
					BeginTerminalTransition();
					break;
				}
				if (!m_RFO_Capture.BeginPreload(world))
				{
					string diagnostic = m_RFO_Capture.GetLastPreloadDiagnostic();
					if (diagnostic.IsEmpty())
						diagnostic = "Positioned gameplay camera could not begin screenshot preload";
					RecordFailure("CAPTURE_REJECTED", diagnostic, false);
					BeginTerminalTransition();
					break;
				}
				job.state = RFO_ObserverJobState.PRELOADING;
				PublishStatus();
				break;
			case RFO_ObserverJobState.PRELOADING:
				AdvancePreload(world);
				break;
			case RFO_ObserverJobState.SETTLING:
				if (AdvanceSettleFrame(world))
				{
					job.state = RFO_ObserverJobState.CAPTURING;
					PublishStatus();
				}
				break;
			case RFO_ObserverJobState.CAPTURING:
				AdvanceCapture(world);
				break;
			case RFO_ObserverJobState.AWAITING_ARTIFACT:
				if (job.IsCameraView())
				{
					job.state = RFO_ObserverJobState.RESTORING;
					PublishStatus();
				}
				else
					SubmitArtifact();
				break;
			case RFO_ObserverJobState.RESTORING:
				AdvanceRestoration(world);
				break;
		}
	}

	protected void AcquireCamera(BaseWorld world)
	{
		vector matrix[4];
		bool built;
		if (m_RFO_ActiveJob.viewKind == "pose")
			built = m_RFO_Capture.BuildPoseMatrix(m_RFO_ActiveJob, matrix);
		else
			built = m_RFO_Capture.BuildLookAtMatrix(m_RFO_ActiveJob, matrix);
		bool acquired;
		if (built)
			acquired = m_RFO_CameraLease.Acquire(m_RFO_ActiveJob.jobId, world, m_RFO_ActiveJob.worldEpoch, matrix, m_RFO_ActiveJob.fov);
		if (!built || !acquired)
		{
			m_RFO_ActiveJob.cameraWasAcquired = m_RFO_CameraLease.HasOutstandingLease();
			RecordFailure("CAMERA_BUSY", "Observer camera lease could not be acquired", false);
			if (m_RFO_ActiveJob.cameraWasAcquired)
			{
				// Initial ownership evidence is valid only in acquiringCamera. Once
				// acknowledged, the pending failure advances through restoring.
				m_RFO_ActiveJob.state = RFO_ObserverJobState.ACQUIRING_CAMERA;
				PublishStatus();
				return;
			}
			BeginTerminalTransition();
			return;
		}
		m_RFO_ActiveJob.cameraWasAcquired = true;
		m_RFO_ActiveJob.state = RFO_ObserverJobState.ACQUIRING_CAMERA;
		PublishStatus();
	}

	protected bool AdvanceSettleFrame(BaseWorld world)
	{
		if (m_RFO_ActiveJob.IsCameraView() && !m_RFO_CameraLease.MaintainRequestedView(m_RFO_ActiveJob.jobId))
		{
			RecordFailure("CAMERA_OWNERSHIP_LOST", "Observer camera view could not be maintained while settling", false);
			BeginTerminalTransition();
			return false;
		}
		int frame = m_RFO_FrameCounter;
		if (world)
			frame = world.GetFrameNumber();
		if (frame == m_RFO_ActiveJob.lastSettleFrame)
			return false;
		m_RFO_ActiveJob.lastSettleFrame = frame;
		m_RFO_ActiveJob.settledFrames++;
		return m_RFO_ActiveJob.settledFrames >= m_RFO_ActiveJob.settleFrames;
	}

	protected void AdvancePreload(BaseWorld world)
	{
		RFO_ObserverJob job = m_RFO_ActiveJob;
		if (job.IsCameraView() && !m_RFO_CameraLease.MaintainRequestedView(job.jobId))
		{
			RecordFailure("CAMERA_OWNERSHIP_LOST", "Observer camera view could not be maintained while preloading", false);
			BeginTerminalTransition();
			return;
		}
		if (!m_RFO_Capture.RuntimeReady())
			return;
		if (job.settleFrames > 0)
			job.state = RFO_ObserverJobState.SETTLING;
		else
			job.state = RFO_ObserverJobState.CAPTURING;
		PublishStatus();
	}

	protected void AdvanceCapture(BaseWorld world)
	{
		RFO_ObserverJob job = m_RFO_ActiveJob;
		if (job.IsCameraView() && !m_RFO_CameraLease.MaintainRequestedView(job.jobId))
		{
			RecordFailure("CAMERA_OWNERSHIP_LOST", "Observer camera ownership changed before screenshot issuance", false);
			BeginTerminalTransition();
			return;
		}
		if (!job.screenshotIssued && job.settledFrames < job.settleFrames && !AdvanceSettleFrame(world))
			return;
		if (!job.screenshotIssued && !m_RFO_Capture.RuntimeReady())
			return;
		if (!job.screenshotIssued && job.IsCameraView())
		{
			// The observer camera consumes this arm in EOnPostFrame immediately
			// after publishing its matrix to the BaseWorld render slot.
			m_RFO_PostFrameCaptureArmed = true;
			return;
		}
		if (!job.screenshotIssued && !m_RFO_Capture.Issue(job, world, m_RFO_FrameCounter))
		{
			string diagnostic = m_RFO_Capture.GetLastIssueDiagnostic();
			if (diagnostic.IsEmpty())
				diagnostic = "Engine screenshot request was rejected";
			RecordFailure("CAPTURE_REJECTED", diagnostic, false);
			BeginTerminalTransition();
			return;
		}
		int stable = m_RFO_Capture.CheckStable(job, world, m_RFO_FrameCounter, m_RFO_Session.limits.maxArtifactBytes);
		if (stable < 0)
		{
			RecordFailure("ARTIFACT_INCOMPLETE", "Screenshot file did not become stable within bounds", false);
			BeginTerminalTransition();
			return;
		}
		if (stable > 0)
		{
			job.state = RFO_ObserverJobState.AWAITING_ARTIFACT;
			PublishStatus();
		}
	}

	protected void AdvanceRestoration(BaseWorld world)
	{
		RFO_ObserverJob job = m_RFO_ActiveJob;
		if (!job.restorationConfirmed && m_RFO_CameraLease.HasOutstandingLease())
		{
			job.restorationAttempted = true;
			job.restorationConfirmed = m_RFO_CameraLease.Restore(job.jobId, world, m_RFO_World.GetEpoch());
			if (!job.restorationConfirmed && m_RFO_CameraLease.HasOutstandingLease())
			{
				m_RFO_CameraSubsystemSafe = false;
				return;
			}
			if (job.restorationConfirmed)
				m_RFO_CameraSubsystemSafe = true;
			else
				m_RFO_CameraSubsystemSafe = false;
			if (!job.restorationConfirmed)
			{
				job.terminalErrorCode = "RESTORATION_UNCONFIRMED";
				job.terminalMessage = "Observer camera ownership or exact restoration could not be confirmed";
				m_RFO_LastErrorCode = job.terminalErrorCode;
			}
			if (!job.restorationLogged)
			{
				Print(string.Format("ReforgerForge Observer: restoration result jobId=%1 confirmed=%2", job.jobId, job.restorationConfirmed));
				job.restorationLogged = true;
			}
			PublishStatus();
			return;
		}
		if (!job.restorationConfirmed)
		{
			if (!job.restorationAttempted)
				return;
			job.state = RFO_ObserverJobState.FAILED;
			PublishStatus();
			return;
		}
		if (!job.terminalErrorCode.IsEmpty())
		{
			if (job.terminalErrorCode == "CANCELLED")
				job.state = RFO_ObserverJobState.CANCELLED;
			else
				job.state = RFO_ObserverJobState.FAILED;
			PublishStatus();
			return;
		}
		SubmitArtifact();
	}

	protected void RecordFailure(string code, string message, bool cancelled)
	{
		if (!m_RFO_ActiveJob || !m_RFO_ActiveJob.terminalErrorCode.IsEmpty())
			return;
		m_RFO_ActiveJob.terminalErrorCode = code;
		m_RFO_ActiveJob.terminalMessage = message;
		if (cancelled)
			m_RFO_ActiveJob.cancellationRequested = true;
		m_RFO_LastErrorCode = code;
	}

	protected void BeginTerminalTransition()
	{
		if (!m_RFO_ActiveJob)
			return;
		if (m_RFO_ActiveJob.cameraWasAcquired)
			m_RFO_ActiveJob.state = RFO_ObserverJobState.RESTORING;
		else if (m_RFO_ActiveJob.terminalErrorCode == "CANCELLED")
			m_RFO_ActiveJob.state = RFO_ObserverJobState.CANCELLED;
		else
			m_RFO_ActiveJob.state = RFO_ObserverJobState.FAILED;
		PublishStatus();
	}

	protected bool PublishStatus()
	{
		RFO_ObserverJob job = m_RFO_ActiveJob;
		if (!job || job.statusPending)
			return false;
		if (job.IsTerminal() && !job.terminalLogged)
		{
			Print(string.Format("ReforgerForge Observer: job terminal jobId=%1 state=%2 error=%3", job.jobId, job.StateName(), job.terminalErrorCode));
			job.terminalLogged = true;
		}
		if (m_RFO_PendingStatusJson.IsEmpty())
		{
			job.sequence++;
			m_RFO_PendingStatusJson = BuildStatusJson(job);
		}
		if (!m_RFO_Transport.SubmitStatus(m_RFO_PendingStatusJson))
			return false;
		job.statusPending = true;
		if (m_RFO_Transport.GetName() == "mailbox")
		{
			job.statusPending = false;
			m_RFO_PendingStatusJson = string.Empty;
			if (job.IsTerminal())
				job.terminalStatusDelivered = true;
		}
		return true;
	}

	protected string BuildStatusJson(RFO_ObserverJob job)
	{
		string cameraLease = "{\"held\":false,\"restorationConfirmed\":" + RFO_ObserverJson.Boolean(job.cameraWasAcquired && job.restorationConfirmed) + "}";
		if (m_RFO_CameraLease.IsHeld())
		{
			cameraLease = "{\"held\":true";
			cameraLease += ",\"leaseId\":" + RFO_ObserverJson.Quote(m_RFO_CameraLease.GetLeaseId());
			cameraLease += ",\"observerCameraId\":" + m_RFO_CameraLease.GetObserverCameraId().ToString();
			cameraLease += "}";
		}
		string result = "{\"protocolVersion\":\"1.0\"";
		result += ",\"sessionId\":" + RFO_ObserverJson.Quote(m_RFO_Session.sessionId);
		result += ",\"instanceId\":" + RFO_ObserverJson.Quote(m_RFO_InstanceId);
		result += ",\"instanceNonce\":" + RFO_ObserverJson.Quote(m_RFO_InstanceNonce);
		result += ",\"jobId\":" + RFO_ObserverJson.Quote(job.jobId);
		result += ",\"sequence\":" + job.sequence.ToString();
		result += ",\"state\":" + RFO_ObserverJson.Quote(job.StateName());
		result += ",\"worldId\":" + RFO_ObserverJson.NullableString(job.worldId);
		result += ",\"worldEpoch\":" + job.worldEpoch.ToString();
		result += ",\"timestamp\":" + RFO_ObserverJson.Quote(RFO_ObserverTime.UtcNowIso());
		result += ",\"deliveryToken\":" + RFO_ObserverJson.Quote(job.deliveryToken);
		result += ",\"cameraLease\":" + cameraLease;
		if (job.state == RFO_ObserverJobState.FAILED)
			result += ",\"errorCode\":" + RFO_ObserverJson.Quote(job.terminalErrorCode);
		if (!job.terminalMessage.IsEmpty())
			result += ",\"message\":" + RFO_ObserverJson.Quote(job.terminalMessage);
		result += ",\"sessionToken\":" + RFO_ObserverJson.Quote(m_RFO_Session.sessionToken);
		return result + "}";
	}

	protected void SubmitArtifact()
	{
		RFO_ObserverJob job = m_RFO_ActiveJob;
		if (!job || job.artifactPending)
			return;
		string localManifest = BuildArtifactManifest(job, false);
		if (!m_RFO_Capture.WriteCompletionManifest(job, localManifest))
		{
			RecordFailure("ARTIFACT_INCOMPLETE", "Runtime completion manifest could not be written", false);
			BeginTerminalTransition();
			return;
		}
		if (m_RFO_PendingArtifactJson.IsEmpty())
			m_RFO_PendingArtifactJson = BuildArtifactManifest(job, true);
		if (!m_RFO_Transport.SubmitArtifact(m_RFO_PendingArtifactJson))
			return;
		job.artifactPending = true;
		if (m_RFO_Transport.GetName() == "mailbox")
		{
			job.artifactPending = false;
			m_RFO_PendingArtifactJson = string.Empty;
			job.state = RFO_ObserverJobState.COMPLETED;
		}
	}

	protected string BuildArtifactManifest(RFO_ObserverJob job, bool includeToken)
	{
		vector actualMatrix[4];
		float actualFov = job.actualFov;
		bool hasCamera = job.hasActualCameraSnapshot;
		if (hasCamera)
		{
			for (int axis = 0; axis < 4; axis++)
				actualMatrix[axis] = job.actualCameraMatrix[axis];
		}
		string actualCamera = "{}";
		if (hasCamera)
			actualCamera = "{\"matrix\":" + RFO_ObserverJson.Matrix4(actualMatrix) + "}";
		string result = "{\"protocolVersion\":\"1.0\"";
		result += ",\"sessionId\":" + RFO_ObserverJson.Quote(m_RFO_Session.sessionId);
		result += ",\"instanceId\":" + RFO_ObserverJson.Quote(m_RFO_InstanceId);
		result += ",\"instanceNonce\":" + RFO_ObserverJson.Quote(m_RFO_InstanceNonce);
		result += ",\"jobId\":" + RFO_ObserverJson.Quote(job.jobId);
		result += ",\"artifactId\":" + RFO_ObserverJson.Quote("artifact-" + job.jobId);
		result += ",\"relativeScreenshotFilename\":" + RFO_ObserverJson.Quote(job.jobId + ".bmp");
		result += ",\"screenshotIssuedAt\":" + RFO_ObserverJson.Quote(job.screenshotIssuedAt);
		result += ",\"completedAt\":" + RFO_ObserverJson.Quote(job.screenshotCompletedAt);
		result += ",\"expectedByteCount\":" + job.screenshotByteCount.ToString();
		result += ",\"worldId\":" + RFO_ObserverJson.NullableString(job.worldId);
		result += ",\"worldEpoch\":" + job.worldEpoch.ToString();
		result += ",\"actualCamera\":" + actualCamera;
		if (hasCamera && actualFov >= 1.0 && actualFov <= 179.0)
			result += ",\"actualFov\":" + actualFov.ToString();
		result += ",\"requestedSettleFrames\":" + job.settleFrames.ToString();
		result += ",\"actualSettleFrames\":" + job.settledFrames.ToString();
		result += ",\"contaminated\":" + RFO_ObserverJson.Boolean(job.performancePolicy == "instrumented");
		result += ",\"warnings\":[]";
		if (includeToken)
			result += ",\"sessionToken\":" + RFO_ObserverJson.Quote(m_RFO_Session.sessionToken);
		return result + "}";
	}

	protected bool RejectCommand(RFO_ObserverRuntimeCommand command, string code, string message, bool cancelled)
	{
		RFO_ObserverJob job = new RFO_ObserverJob();
		job.jobId = command.jobId;
		job.idempotencyKey = command.idempotencyKey;
		job.deliveryToken = command.deliveryToken;
		job.deadlineAt = command.deadlineAt;
		job.worldEpoch = command.worldEpoch;
		job.worldId = m_RFO_World.GetId();
		job.terminalErrorCode = code;
		job.terminalMessage = message;
		if (cancelled)
			job.state = RFO_ObserverJobState.CANCELLED;
		else
			job.state = RFO_ObserverJobState.FAILED;
		m_RFO_ActiveJob = job;
		m_RFO_LastErrorCode = code;
		PublishStatus();
		return true;
	}

	protected bool CaptureRateAvailable()
	{
		int cutoff = System.GetUnixTime() - 60;
		for (int index = m_RFO_CaptureTimes.Count() - 1; index >= 0; index--)
		{
			if (m_RFO_CaptureTimes[index] <= cutoff)
				m_RFO_CaptureTimes.RemoveOrdered(index);
		}
		return m_RFO_CaptureTimes.Count() < m_RFO_Session.limits.maxCaptureRatePerMinute;
	}

	protected array<string> CurrentCapabilities()
	{
		bool restReady = m_RFO_Transport.GetName() == "rest";
		bool mailboxReady = m_RFO_Transport.GetName() == "mailbox";
		// Advertise the graphical endpoint as soon as its managed capture path is
		// available. Per-job BeginPreload/RuntimeReady owns camera readiness; using
		// that state here would prevent the first job from initiating its preload.
		bool captureReady = m_RFO_Capture && m_RFO_Capture.IsReady();
		return RFO_ObserverCapabilities.Collect(m_RFO_World.Available(), restReady, mailboxReady, captureReady, captureReady && RFO_ObserverCapabilities.CAMERA_RESTORE_PROVEN && m_RFO_CameraSubsystemSafe && !m_RFO_CameraLease.HasOutstandingLease());
	}

	protected void SwitchToMailboxFallback()
	{
		if (!m_RFO_Transport || m_RFO_Transport.GetName() == "mailbox" || !m_RFO_Session.AllowsTransport("mailbox"))
			return;
		RFO_ObserverMailboxTransport mailbox = new RFO_ObserverMailboxTransport();
		if (!mailbox.Initialize(m_RFO_Session, this))
			return;
		m_RFO_Transport.Shutdown();
		m_RFO_Transport = mailbox;
		if (!m_RFO_FallbackLogged)
		{
			Print("ReforgerForge Observer: transport fallback selected=mailbox", LogLevel.WARNING);
			m_RFO_FallbackLogged = true;
		}
		m_RFO_Registered = mailbox.RegisterInstance(BuildRegistrationJson());
		m_RFO_RegistrationQueued = false;
		if (m_RFO_Registered)
			LogRegistrationAccepted();
		m_RFO_TransportFailures = 0;
		if (m_RFO_Registered && m_RFO_ActiveJob && m_RFO_ActiveJob.statusPending && !m_RFO_PendingStatusJson.IsEmpty() && mailbox.SubmitStatus(m_RFO_PendingStatusJson))
		{
			m_RFO_ActiveJob.statusPending = false;
			m_RFO_PendingStatusJson = string.Empty;
			if (m_RFO_ActiveJob.IsTerminal())
				m_RFO_ActiveJob.terminalStatusDelivered = true;
		}
		if (m_RFO_Registered && m_RFO_ActiveJob && m_RFO_ActiveJob.artifactPending && !m_RFO_PendingArtifactJson.IsEmpty() && mailbox.SubmitArtifact(m_RFO_PendingArtifactJson))
		{
			m_RFO_ActiveJob.artifactPending = false;
			m_RFO_PendingArtifactJson = string.Empty;
			m_RFO_ActiveJob.state = RFO_ObserverJobState.COMPLETED;
		}
	}

	protected void LogRegistrationAccepted()
	{
		if (m_RFO_RegistrationLogged)
			return;
		Print(string.Format("ReforgerForge Observer: registration accepted runtimeKind=%1 transport=%2", m_RFO_RuntimeKind, m_RFO_Transport.GetName()));
		m_RFO_RegistrationLogged = true;
	}

	protected string BuildStringArray(array<string> values)
	{
		string result = "[";
		for (int index = 0; index < values.Count(); index++)
		{
			if (index > 0)
				result += ",";
			result += RFO_ObserverJson.Quote(values[index]);
		}
		return result + "]";
	}
}
