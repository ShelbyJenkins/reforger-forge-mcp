/**
 * Shared, reviewed Workbench observer transaction.
 *
 * This file deliberately exposes no NET API handler of its own. The five
 * observer handlers below are the only entry points. One process-local job may
 * hold the editor camera at a time; every request is cross-bound to the MCP
 * lifecycle generation and canonical .gproj target supplied at submit.
 */

class EMCP_WB_ObserverJob
{
	string jobId;
	string leaseId;
	string lifecycleGeneration;
	string canonicalTarget;
	string projectFile;
	string worldIdentity;
	string viewKind;
	string state;
	string message;
	string terminalErrorCode;
	string outputLogicalPath;
	string outputAbsolutePath;
	int sequence;
	int settlePolls;
	int settledPolls;
	int lastSettleTick;
	int lastArtifactLength;
	int stableArtifactPolls;
	int artifactBytes;
	int originalWorldCameraId;
	int ownerCameraId;
	int viewportWidth;
	int viewportHeight;
	float originalFov;
	float originalNearPlane;
	float originalFarPlane;
	float actualFov;
	float renderedFov;
	bool screenshotIssued;
	bool renderedEvidenceCaptured;
	bool cameraLeaseHeld;
	bool restorationConfirmed;
	BaseWorld world;
	vector originalWorldMatrix[4];
	vector requestedMatrix[4];
	string requestedMatrix0;
	string requestedMatrix1;
	string requestedMatrix2;
	string requestedMatrix3;
	float requestedFov;
	vector installedWorldMatrix[4];
	vector renderedWorldMatrix[4];
	float installedFov;

	bool IsTerminal()
	{
		return state == EMCP_WB_ObserverProtocol.STATE_COMPLETED || state == EMCP_WB_ObserverProtocol.STATE_FAILED || state == EMCP_WB_ObserverProtocol.STATE_CANCELLED;
	}
}

class EMCP_WB_ObserverReleaseReceipt
{
	string jobId;
	string leaseId;
	string lifecycleGeneration;
	string canonicalTarget;
	bool restorationConfirmed;
	bool artifactRemoved;
}

class EMCP_WB_ObserverJobResponse : JsonApiStruct
{
	string status;
	string message;
	string adapterProtocol;
	string jobId;
	string leaseId;
	string lifecycleGeneration;
	string canonicalTarget;
	string projectFile;
	string worldIdentity;
	string viewKind;
	string state;
	string terminalErrorCode;
	string artifactLogicalPath;
	string artifactPath;
	string cameraMatrix0;
	string cameraMatrix1;
	string cameraMatrix2;
	string cameraMatrix3;
	int sequence;
	int settlePolls;
	int settledPolls;
	int artifactBytes;
	int ownerCameraId;
	float actualFov;
	float nearPlane;
	float farPlane;
	bool cameraLeaseHeld;
	bool restorationConfirmed;

	void EMCP_WB_ObserverJobResponse()
	{
		RegV("status");
		RegV("message");
		RegV("adapterProtocol");
		RegV("jobId");
		RegV("leaseId");
		RegV("lifecycleGeneration");
		RegV("canonicalTarget");
		RegV("projectFile");
		RegV("worldIdentity");
		RegV("viewKind");
		RegV("state");
		RegV("terminalErrorCode");
		RegV("artifactLogicalPath");
		RegV("artifactPath");
		RegV("cameraMatrix0");
		RegV("cameraMatrix1");
		RegV("cameraMatrix2");
		RegV("cameraMatrix3");
		RegV("sequence");
		RegV("settlePolls");
		RegV("settledPolls");
		RegV("artifactBytes");
		RegV("ownerCameraId");
		RegV("actualFov");
		RegV("nearPlane");
		RegV("farPlane");
		RegV("cameraLeaseHeld");
		RegV("restorationConfirmed");
	}

	void Fill(EMCP_WB_ObserverService service, EMCP_WB_ObserverJob job, string responseStatus, string responseMessage)
	{
		status = responseStatus;
		message = responseMessage;
		adapterProtocol = service.GetProtocol();
		if (!job)
			return;
		jobId = job.jobId;
		leaseId = job.leaseId;
		lifecycleGeneration = job.lifecycleGeneration;
		canonicalTarget = job.canonicalTarget;
		projectFile = job.projectFile;
		worldIdentity = job.worldIdentity;
		viewKind = job.viewKind;
		state = job.state;
		terminalErrorCode = job.terminalErrorCode;
		artifactLogicalPath = job.outputLogicalPath;
		artifactPath = job.outputAbsolutePath;
		sequence = job.sequence;
		settlePolls = job.settlePolls;
		settledPolls = job.settledPolls;
		artifactBytes = job.artifactBytes;
		ownerCameraId = job.ownerCameraId;
		actualFov = job.actualFov;
		nearPlane = job.originalNearPlane;
		farPlane = job.originalFarPlane;
		vector evidence0 = job.installedWorldMatrix[0];
		vector evidence1 = job.installedWorldMatrix[1];
		vector evidence2 = job.installedWorldMatrix[2];
		vector evidence3 = job.installedWorldMatrix[3];
		if (job.renderedEvidenceCaptured)
		{
			evidence0 = job.renderedWorldMatrix[0];
			evidence1 = job.renderedWorldMatrix[1];
			evidence2 = job.renderedWorldMatrix[2];
			evidence3 = job.renderedWorldMatrix[3];
			actualFov = job.renderedFov;
		}
		cameraMatrix0 = evidence0[0].ToString() + " " + evidence0[1].ToString() + " " + evidence0[2].ToString();
		cameraMatrix1 = evidence1[0].ToString() + " " + evidence1[1].ToString() + " " + evidence1[2].ToString();
		cameraMatrix2 = evidence2[0].ToString() + " " + evidence2[1].ToString() + " " + evidence2[2].ToString();
		cameraMatrix3 = evidence3[0].ToString() + " " + evidence3[1].ToString() + " " + evidence3[2].ToString();
		cameraLeaseHeld = job.cameraLeaseHeld;
		restorationConfirmed = job.restorationConfirmed;
	}
}

class EMCP_WB_ObserverService
{
	static const string PROFILE_DIRECTORY = "$profile:" + EMCP_WB_ObserverProtocol.DIRECTORY_SESSION_ROOT;
	static const string CAPTURE_DIRECTORY = PROFILE_DIRECTORY + "/workbench";
	// Workbench restoration uses a deliberately local 0.0001 tolerance; see
	// observer/protocol/generated/enforce-contract.json's backendTuning ledger.
	static const float MATRIX_EPSILON = 0.0001;
	static const float FOV_EPSILON = 0.01;
	static const float FOV_SYMMETRY_EPSILON = 0.05;
	static const int MAX_SETTLE_POLLS = 120;
	static const int MAX_ARTIFACT_BYTES = 67108864;

	protected static ref EMCP_WB_ObserverService s_Instance;
	protected ref EMCP_WB_ObserverJob m_Job;
	protected ref EMCP_WB_ObserverReleaseReceipt m_LastRelease;
	protected bool m_RestorationProven;
	protected string m_LastProjectionDiagnostic;
	protected string m_LastRestorationDiagnostic;

	static EMCP_WB_ObserverService Get()
	{
		if (!s_Instance)
			s_Instance = new EMCP_WB_ObserverService();
		return s_Instance;
	}

	string GetProtocol()
	{
		return EMCP_WB_ObserverProtocol.ADAPTER_PROTOCOL;
	}

	bool HasJob()
	{
		return m_Job != null;
	}

	EMCP_WB_ObserverJob GetJob()
	{
		return m_Job;
	}

	bool IsCameraEditorProven()
	{
		string ignored;
		return m_RestorationProven && InspectEnvironment(ignored);
	}

	bool InspectEnvironment(out string message)
	{
		if (System.IsConsoleApp())
		{
			message = "Workbench is running without a renderer";
			return false;
		}
		WorldEditor worldEditor = Workbench.GetModule(WorldEditor);
		if (!worldEditor)
		{
			message = "WorldEditor module is unavailable";
			return false;
		}
		WorldEditorAPI api = worldEditor.GetApi();
		if (!api)
		{
			message = "WorldEditorAPI is unavailable (Workbench may be in Play mode)";
			return false;
		}
		BaseWorld world = api.GetWorld();
		if (!world)
		{
			message = "No editor world is loaded";
			return false;
		}
		int cameraId = world.GetCurrentCameraId();
		if (cameraId < 0)
		{
			message = "The editor world does not expose a restorable current camera slot";
			return false;
		}
		float measuredFov;
		if (!MeasureVerticalFov(api, world, cameraId, measuredFov))
		{
			message = m_LastProjectionDiagnostic;
			return false;
		}
		float farPlane = world.GetCameraFarPlane(cameraId);
		vector cameraMatrix[4];
		world.GetCurrentCamera(cameraMatrix);
		if (farPlane != farPlane || farPlane <= 0 || farPlane > 10000000 || !CameraMatrixValid(cameraMatrix) || world.GetCurrentCameraId() != cameraId)
		{
			message = "The native editor camera snapshot is unstable or invalid";
			return false;
		}
		if (Workbench.GetCurrentGameProjectFile().IsEmpty())
		{
			message = "The current Workbench project identity is unavailable";
			return false;
		}
		message = "Full native editor camera snapshot APIs are available";
		return true;
	}

	string CurrentProjectFile()
	{
		return Workbench.GetCurrentGameProjectFile();
	}

	// Fault-matrix acceptance hook boundary. Advance() is the only point this
	// handler is re-entered while a job is settling (Submit and Cancel are
	// single synchronous NET API calls and cannot be held open), so this is
	// the sole phase currently wired: it pauses the local job state machine
	// at lease_acquired while the host's ordinary Status poll keeps calling
	// Advance normally. The default implementation always returns true, so
	// production behavior is unchanged when no fixture add-on overrides it.
	// A disposable acceptance fixture may override this through a modded
	// class to prove fault-injection behavior against a real Workbench
	// process. It is not part of the public observer protocol or the
	// production helper's five NET API handlers.
	protected event bool OnLeaseAcquiredBarrier(EMCP_WB_ObserverJob job)
	{
		return true;
	}

	string CurrentWorldIdentity()
	{
		WorldEditor worldEditor = Workbench.GetModule(WorldEditor);
		if (!worldEditor)
			return string.Empty;
		WorldEditorAPI api = worldEditor.GetApi();
		if (!api || !api.GetWorld())
			return string.Empty;
		return NormalizedPath(Workbench.GetCurrentGameProjectFile()) + "|" + api.GetWorld().ToString() + "|" + api.GetCurrentSubScene().ToString() + "|" + worldEditor.IsPrefabEditMode().ToString();
	}

	bool Submit(
		string jobId,
		string requestedLeaseId,
		string lifecycleGeneration,
		string canonicalTarget,
		string viewKind,
		string matrix0,
		string matrix1,
		string matrix2,
		string matrix3,
		string fovText,
		int settlePolls,
		out string acceptedLeaseId,
		out string message)
	{
		acceptedLeaseId = string.Empty;
		float fov;
		if (!ParseDecimal(fovText, fov))
		{
			message = "Invalid canonical Workbench FOV value";
			return false;
		}
		if (!Identifier(jobId, 1, 96) || !Identifier(requestedLeaseId, 1, 128) || !Identifier(lifecycleGeneration, 1, 128))
		{
			message = "Invalid job, handler lease, or lifecycle identifier";
			return false;
		}
		// GetCurrentGameProjectFile reports the base game settings project (for
		// example ArmaReforger.gproj), not the mod .gproj supplied to -gproj. The
		// exact process/target binding is proven by the host lifecycle guard; the
		// handler validates and immutably cross-binds that canonical target.
		if (canonicalTarget.IsEmpty() || canonicalTarget.Length() > 2048 || !canonicalTarget.EndsWith(".gproj"))
		{
			message = "The request canonical Workbench target is invalid";
			return false;
		}
		if (viewKind != "current" && viewKind != "pose" && viewKind != "lookAt")
		{
			message = "Unsupported observer view kind";
			return false;
		}
		if (settlePolls < 0 || settlePolls > MAX_SETTLE_POLLS)
		{
			message = "settlePolls is outside the reviewed bound";
			return false;
		}
		if (m_Job)
		{
			// Submit is an acknowledged, idempotent delivery boundary. The host
			// chooses the lease before delivery, so an identical retry recovers a
			// lost response without applying camera state twice.
			bool replay = m_Job.jobId == jobId && m_Job.leaseId == requestedLeaseId && m_Job.lifecycleGeneration == lifecycleGeneration && NormalizedPath(m_Job.canonicalTarget) == NormalizedPath(canonicalTarget) && m_Job.viewKind == viewKind && m_Job.requestedMatrix0 == matrix0 && m_Job.requestedMatrix1 == matrix1 && m_Job.requestedMatrix2 == matrix2 && m_Job.requestedMatrix3 == matrix3 && Math.AbsFloat(m_Job.requestedFov - fov) <= MATRIX_EPSILON && m_Job.settlePolls == settlePolls;
			if (replay)
			{
				acceptedLeaseId = m_Job.leaseId;
				message = "Workbench observer submit already acknowledged for this exact command";
				return true;
			}
			message = "Another Workbench observer job already owns the handler lease";
			return false;
		}
		if (viewKind != "current" && !m_RestorationProven)
		{
			message = "camera.editor is fail-closed until this Workbench process completes an exact current-view restoration proof";
			return false;
		}

		string inspection;
		if (!InspectEnvironment(inspection))
		{
			message = inspection;
			return false;
		}

		WorldEditor worldEditor = Workbench.GetModule(WorldEditor);
		WorldEditorAPI api = worldEditor.GetApi();
		BaseWorld world = api.GetWorld();

		ref EMCP_WB_ObserverJob job = new EMCP_WB_ObserverJob();
		job.jobId = jobId;
		job.leaseId = requestedLeaseId;
		job.lifecycleGeneration = lifecycleGeneration;
		job.canonicalTarget = canonicalTarget;
		job.projectFile = CurrentProjectFile();
		job.worldIdentity = CurrentWorldIdentity();
		job.viewKind = viewKind;
		job.requestedMatrix0 = matrix0;
		job.requestedMatrix1 = matrix1;
		job.requestedMatrix2 = matrix2;
		job.requestedMatrix3 = matrix3;
		job.requestedFov = fov;
		job.state = EMCP_WB_ObserverProtocol.STATE_ACCEPTED;
		job.message = "Workbench observer camera lease acquired";
		job.sequence = 1;
		job.settlePolls = settlePolls;
		job.world = world;
		job.originalWorldCameraId = world.GetCurrentCameraId();
		job.ownerCameraId = job.originalWorldCameraId;
		job.viewportWidth = api.GetScreenWidth();
		job.viewportHeight = api.GetScreenHeight();
		if (!MeasureVerticalFov(api, world, job.originalWorldCameraId, job.originalFov))
		{
			message = "Could not measure the native editor camera projection";
			return false;
		}
		// BaseWorld exposes no near-plane getter. The observer never mutates that
		// value; it snapshots and verifies every state value it does mutate plus
		// the read-only far plane as an additional projection ownership guard.
		job.originalNearPlane = 0;
		job.originalFarPlane = world.GetCameraFarPlane(job.originalWorldCameraId);
		if (job.originalFarPlane != job.originalFarPlane || job.originalFarPlane <= 0 || job.originalFarPlane > 10000000)
		{
			message = "The native editor far-plane snapshot is invalid";
			return false;
		}
		job.actualFov = job.originalFov;
		world.GetCurrentCamera(job.originalWorldMatrix);
		float confirmedFov;
		if (!CameraMatrixValid(job.originalWorldMatrix) || world.GetCurrentCameraId() != job.originalWorldCameraId || api.GetScreenWidth() != job.viewportWidth || api.GetScreenHeight() != job.viewportHeight || !MeasureVerticalFov(api, world, job.originalWorldCameraId, confirmedFov) || Math.AbsFloat(confirmedFov - job.originalFov) > FOV_EPSILON || Math.AbsFloat(world.GetCameraFarPlane(job.originalWorldCameraId) - job.originalFarPlane) > MATRIX_EPSILON)
		{
			message = "The native editor camera changed while its lease snapshot was being acquired";
			return false;
		}
		for (int currentAxis = 0; currentAxis < 4; currentAxis++)
			job.requestedMatrix[currentAxis] = job.originalWorldMatrix[currentAxis];
		if (viewKind != "current")
		{
			if (fov < 1 || fov > 179 || !ParseMatrix(matrix0, matrix1, matrix2, matrix3, job.requestedMatrix))
			{
				message = "Requested camera matrix or FOV is invalid";
				return false;
			}
			for (int requestedAxis = 0; requestedAxis < 4; requestedAxis++)
				job.installedWorldMatrix[requestedAxis] = job.requestedMatrix[requestedAxis];
			job.installedFov = 0;
		}
		else
		{
			for (int originalAxis = 0; originalAxis < 4; originalAxis++)
				job.installedWorldMatrix[originalAxis] = job.originalWorldMatrix[originalAxis];
			job.installedFov = job.originalFov;
		}

		// Retain the complete restoration transaction before the first camera
		// write. Every outcome after this point remains cancellable/releasable.
		job.cameraLeaseHeld = true;
		m_Job = job;

		if (viewKind != "current")
		{
			// Update the editor's persistent perspective controller first so it
			// does not overwrite the native render slot on the next frame. SetCameraEx
			// then retains/verifies the exact requested basis for this transaction.
			api.SetCamera(job.requestedMatrix[3], job.requestedMatrix[2]);
			world.SetCameraEx(job.originalWorldCameraId, job.requestedMatrix);
			world.SetCameraVerticalFOV(job.originalWorldCameraId, fov);
			bool projectionMeasured = MeasureVerticalFov(api, world, job.originalWorldCameraId, job.installedFov);
			bool requestedInstalled = projectionMeasured && Math.AbsFloat(job.installedFov - fov) <= FOV_EPSILON && InstalledStateStillOwned(job);
			if (!requestedInstalled)
			{
				job.state = EMCP_WB_ObserverProtocol.STATE_RESTORING;
				job.sequence++;
				bool restoredAfterRejectedInstall = RestoreJob(job);
				job.state = EMCP_WB_ObserverProtocol.STATE_FAILED;
				if (restoredAfterRejectedInstall)
				{
					job.terminalErrorCode = "CAMERA_POSITION_REJECTED";
					job.message = "Workbench rejected the requested camera state; the exact original state was retained";
				}
				else
				{
					job.terminalErrorCode = EMCP_WB_ObserverProtocol.ERROR_RESTORATION_UNCONFIRMED;
					job.message = "Workbench camera installation changed unexpectedly and exact restoration was not safe: " + m_LastRestorationDiagnostic;
				}
				job.sequence++;
				message = job.message;
				return true;
			}
			job.actualFov = job.installedFov;
			job.state = EMCP_WB_ObserverProtocol.STATE_SETTLING;
			job.message = "Requested editor camera state installed";
			job.sequence++;
		}
		else
		{
			job.state = EMCP_WB_ObserverProtocol.STATE_SETTLING;
			job.message = "Current editor view snapshotted";
			job.sequence++;
		}

		acceptedLeaseId = job.leaseId;
		message = job.message;
		return true;
	}

	bool Advance(string jobId, string leaseId, string lifecycleGeneration, string canonicalTarget, out string message)
	{
		if (!Matches(jobId, leaseId, lifecycleGeneration, canonicalTarget, message))
			return false;
		if (m_Job.IsTerminal())
		{
			message = m_Job.message;
			return true;
		}
		if (!BindingStillCurrent(m_Job))
		{
			FailAndRestore("CAPTURE_INVALIDATED", "Workbench lifecycle, target, world, or camera ownership changed during capture");
			message = m_Job.message;
			return true;
		}
		if (!OnLeaseAcquiredBarrier(m_Job))
		{
			message = m_Job.message;
			return true;
		}

		if (!m_Job.screenshotIssued)
		{
			int now = System.GetTickCount();
			if (m_Job.lastSettleTick == 0 || now != m_Job.lastSettleTick)
			{
				m_Job.lastSettleTick = now;
				m_Job.settledPolls++;
				m_Job.sequence++;
			}
			if (m_Job.settledPolls <= m_Job.settlePolls)
			{
				m_Job.state = EMCP_WB_ObserverProtocol.STATE_SETTLING;
				m_Job.message = "Waiting for bounded rendered-frame settle polling";
				message = m_Job.message;
				return true;
			}

			if ((!FileIO.FileExists(PROFILE_DIRECTORY) && !FileIO.MakeDirectory(PROFILE_DIRECTORY)) || (!FileIO.FileExists(CAPTURE_DIRECTORY) && !FileIO.MakeDirectory(CAPTURE_DIRECTORY)))
			{
				FailAndRestore("SCREENSHOT_PATH_UNAVAILABLE", "Could not create the managed Workbench capture directory");
				message = m_Job.message;
				return true;
			}
			string screenshotRequestPath = CAPTURE_DIRECTORY + "/" + m_Job.jobId;
			m_Job.outputLogicalPath = screenshotRequestPath + ".png";
			if (!Workbench.GetAbsolutePath(m_Job.outputLogicalPath, m_Job.outputAbsolutePath, false) || m_Job.outputAbsolutePath.IsEmpty())
			{
				FailAndRestore("SCREENSHOT_PATH_UNAVAILABLE", "Workbench could not resolve the generated profile capture path");
				message = m_Job.message;
				return true;
			}
			if (FileIO.FileExists(m_Job.outputLogicalPath))
				FileIO.DeleteFile(m_Job.outputLogicalPath);
			// Retain the exact world-camera evidence at screenshot issuance. The
			// native editor viewport is represented by the BaseWorld camera slot;
			// it is deliberately independent of the gameplay camera subsystem.
			m_Job.world.GetCurrentCamera(m_Job.renderedWorldMatrix);
			WorldEditor renderedEditor = Workbench.GetModule(WorldEditor);
			WorldEditorAPI renderedApi = null;
			if (renderedEditor)
				renderedApi = renderedEditor.GetApi();
			if (!MeasureVerticalFov(renderedApi, m_Job.world, m_Job.originalWorldCameraId, m_Job.renderedFov))
			{
				FailAndRestore("PROJECTION_UNAVAILABLE", "Could not retain native editor projection evidence at screenshot issuance");
				message = m_Job.message;
				return true;
			}
			m_Job.renderedEvidenceCaptured = true;
			// Workbench MakeScreenshot appends its engine-selected .png suffix. Keep the
			// extensionless request separate from the exact artifact contract.
			if (!System.MakeScreenshot(screenshotRequestPath))
			{
				FailAndRestore("SCREENSHOT_REJECTED", "System.MakeScreenshot rejected the generated PNG request");
				message = m_Job.message;
				return true;
			}
			m_Job.screenshotIssued = true;
			m_Job.state = EMCP_WB_ObserverProtocol.STATE_CAPTURING;
			m_Job.message = "Screenshot issued; waiting for a stable artifact";
			m_Job.sequence++;
			message = m_Job.message;
			return true;
		}

		if (!FileIO.FileExists(m_Job.outputLogicalPath))
		{
			m_Job.state = EMCP_WB_ObserverProtocol.STATE_AWAITING_ARTIFACT;
			m_Job.message = "Waiting for the generated PNG to appear";
			m_Job.sequence++;
			message = m_Job.message;
			return true;
		}
		FileHandle artifact = FileIO.OpenFile(m_Job.outputLogicalPath, FileMode.READ);
		if (!artifact || !artifact.IsOpen())
		{
			m_Job.state = EMCP_WB_ObserverProtocol.STATE_AWAITING_ARTIFACT;
			m_Job.message = "Waiting for the generated PNG to become readable";
			m_Job.sequence++;
			message = m_Job.message;
			return true;
		}
		int length = artifact.GetLength();
		artifact.Close();
		if (length <= 33 || length > MAX_ARTIFACT_BYTES)
		{
			if (length > MAX_ARTIFACT_BYTES)
				FailAndRestore(EMCP_WB_ObserverProtocol.ERROR_ARTIFACT_TOO_LARGE, "Generated Workbench PNG exceeds the reviewed size bound");
			else
			{
				m_Job.state = EMCP_WB_ObserverProtocol.STATE_AWAITING_ARTIFACT;
				m_Job.message = "Waiting for the generated PNG header and chunks";
				m_Job.sequence++;
			}
			message = m_Job.message;
			return true;
		}
		if (length == m_Job.lastArtifactLength)
			m_Job.stableArtifactPolls++;
		else
		{
			m_Job.lastArtifactLength = length;
			m_Job.stableArtifactPolls = 0;
		}
		if (m_Job.stableArtifactPolls < 2)
		{
			m_Job.state = EMCP_WB_ObserverProtocol.STATE_AWAITING_ARTIFACT;
			m_Job.message = "Waiting for two stable generated-PNG polls";
			m_Job.sequence++;
			message = m_Job.message;
			return true;
		}

		m_Job.artifactBytes = length;
		m_Job.state = EMCP_WB_ObserverProtocol.STATE_RESTORING;
		m_Job.sequence++;
		if (!RestoreJob(m_Job))
		{
			m_RestorationProven = false;
			m_Job.state = EMCP_WB_ObserverProtocol.STATE_FAILED;
			m_Job.terminalErrorCode = EMCP_WB_ObserverProtocol.ERROR_RESTORATION_UNCONFIRMED;
			m_Job.message = "Screenshot completed, but exact editor camera restoration could not be proven: " + m_LastRestorationDiagnostic;
			m_Job.sequence++;
			message = m_Job.message;
			return true;
		}
		m_RestorationProven = true;
		m_Job.state = EMCP_WB_ObserverProtocol.STATE_COMPLETED;
		m_Job.message = "Workbench PNG completed and exact editor camera state was restored";
		m_Job.sequence++;
		message = m_Job.message;
		return true;
	}

	bool Cancel(string jobId, string leaseId, string lifecycleGeneration, string canonicalTarget, out string message)
	{
		if (!Matches(jobId, leaseId, lifecycleGeneration, canonicalTarget, message))
			return false;
		if (m_Job.IsTerminal() && !m_Job.cameraLeaseHeld)
		{
			message = m_Job.message;
			return true;
		}
		m_Job.state = EMCP_WB_ObserverProtocol.STATE_RESTORING;
		m_Job.sequence++;
		bool restored = RestoreJob(m_Job);
		m_RestorationProven = restored;
		if (restored)
		{
			m_Job.state = EMCP_WB_ObserverProtocol.STATE_CANCELLED;
			m_Job.terminalErrorCode = EMCP_WB_ObserverProtocol.ERROR_CANCELLED;
			m_Job.message = "Workbench observer capture cancelled after exact camera restoration";
		}
		else
		{
			m_Job.state = EMCP_WB_ObserverProtocol.STATE_FAILED;
			m_Job.terminalErrorCode = EMCP_WB_ObserverProtocol.ERROR_RESTORATION_UNCONFIRMED;
			m_Job.message = "Capture cancellation could not prove exact camera restoration: " + m_LastRestorationDiagnostic;
		}
		m_Job.sequence++;
		message = m_Job.message;
		return true;
	}

	bool Release(string jobId, string leaseId, string lifecycleGeneration, string canonicalTarget, out bool restored, out bool artifactRemoved, out string message)
	{
		restored = false;
		artifactRemoved = false;
		if (ReleaseReceiptMatches(jobId, leaseId, lifecycleGeneration, canonicalTarget))
		{
			restored = m_LastRelease.restorationConfirmed;
			artifactRemoved = m_LastRelease.artifactRemoved;
			message = "Workbench observer release already acknowledged for this exact job";
			return true;
		}
		if (!Matches(jobId, leaseId, lifecycleGeneration, canonicalTarget, message))
			return false;
		// Public release is artifact/reference disposal only. It must never take
		// control of an active or restoration-unconfirmed camera transaction;
		// callers must cancel first and observe exact restoration.
		if (!m_Job.IsTerminal() || m_Job.cameraLeaseHeld || !m_Job.restorationConfirmed)
		{
			message = "Release refused until cancellation/completion proves exact camera restoration";
			return false;
		}
		restored = true;
		if (!m_Job.outputLogicalPath.IsEmpty() && FileIO.FileExists(m_Job.outputLogicalPath))
		{
			artifactRemoved = FileIO.DeleteFile(m_Job.outputLogicalPath);
			if (!artifactRemoved)
			{
				message = "Release could not remove the retained managed Workbench artifact";
				return false;
			}
		}
		m_LastRelease = new EMCP_WB_ObserverReleaseReceipt();
		m_LastRelease.jobId = m_Job.jobId;
		m_LastRelease.leaseId = m_Job.leaseId;
		m_LastRelease.lifecycleGeneration = m_Job.lifecycleGeneration;
		m_LastRelease.canonicalTarget = m_Job.canonicalTarget;
		m_LastRelease.restorationConfirmed = true;
		m_LastRelease.artifactRemoved = artifactRemoved;
		message = "Workbench observer job and managed artifact reference released";
		m_Job = null;
		return true;
	}

	protected bool ReleaseReceiptMatches(string jobId, string leaseId, string lifecycleGeneration, string canonicalTarget)
	{
		if (!m_LastRelease)
			return false;
		return m_LastRelease.jobId == jobId && m_LastRelease.leaseId == leaseId && m_LastRelease.lifecycleGeneration == lifecycleGeneration && NormalizedPath(m_LastRelease.canonicalTarget) == NormalizedPath(canonicalTarget);
	}

	protected bool Matches(string jobId, string leaseId, string lifecycleGeneration, string canonicalTarget, out string message)
	{
		if (!m_Job)
		{
			message = "No Workbench observer job is retained";
			return false;
		}
		if (m_Job.jobId != jobId || m_Job.leaseId != leaseId)
		{
			message = "The Workbench observer job or handler lease does not match";
			return false;
		}
		if (m_Job.lifecycleGeneration != lifecycleGeneration || NormalizedPath(m_Job.canonicalTarget) != NormalizedPath(canonicalTarget))
		{
			message = "Stale Workbench lifecycle generation or canonical target";
			return false;
		}
		return true;
	}

	protected bool BindingStillCurrent(EMCP_WB_ObserverJob job)
	{
		if (!job || !job.cameraLeaseHeld || !job.world)
			return false;
		WorldEditor worldEditor = Workbench.GetModule(WorldEditor);
		if (!worldEditor || !worldEditor.GetApi() || worldEditor.GetApi().GetWorld() != job.world)
			return false;
		if (worldEditor.GetApi().GetScreenWidth() != job.viewportWidth || worldEditor.GetApi().GetScreenHeight() != job.viewportHeight)
			return false;
		if (NormalizedPath(CurrentProjectFile()) != NormalizedPath(job.projectFile) || CurrentWorldIdentity() != job.worldIdentity)
			return false;
		return InstalledStateStillOwned(job);
	}

	protected void FailAndRestore(string code, string failureMessage)
	{
		m_Job.state = EMCP_WB_ObserverProtocol.STATE_RESTORING;
		m_Job.sequence++;
		bool restored = RestoreJob(m_Job);
		if (!restored)
			m_RestorationProven = false;
		m_Job.state = EMCP_WB_ObserverProtocol.STATE_FAILED;
		if (restored)
		{
			m_Job.terminalErrorCode = code;
			m_Job.message = failureMessage;
		}
		else
		{
			m_Job.terminalErrorCode = EMCP_WB_ObserverProtocol.ERROR_RESTORATION_UNCONFIRMED;
			m_Job.message = failureMessage + "; exact restoration also failed: " + m_LastRestorationDiagnostic;
		}
		m_Job.sequence++;
	}

	protected bool RestoreJob(EMCP_WB_ObserverJob job)
	{
		if (!job || !job.cameraLeaseHeld)
		{
			m_LastRestorationDiagnostic = "No active native editor camera lease was available";
			return job && job.restorationConfirmed;
		}
		if (!job.world)
		{
			m_LastRestorationDiagnostic = "The leased editor world is unavailable";
			return false;
		}
		WorldEditor worldEditor = Workbench.GetModule(WorldEditor);
		WorldEditorAPI api = null;
		if (worldEditor)
			api = worldEditor.GetApi();
		if (!api || api.GetWorld() != job.world)
		{
			m_LastRestorationDiagnostic = "The active editor world changed during the camera lease";
			return false;
		}
		if (api.GetScreenWidth() != job.viewportWidth || api.GetScreenHeight() != job.viewportHeight)
		{
			m_LastRestorationDiagnostic = "The active editor viewport dimensions changed during the camera lease";
			return false;
		}
		if (NormalizedPath(CurrentProjectFile()) != NormalizedPath(job.projectFile))
		{
			m_LastRestorationDiagnostic = "The base game project identity changed during the camera lease";
			return false;
		}
		if (CurrentWorldIdentity() != job.worldIdentity)
		{
			m_LastRestorationDiagnostic = "The editor world/subscene identity changed during the camera lease";
			return false;
		}
		if (OriginalStateAlreadyPresent(job))
		{
			job.cameraLeaseHeld = false;
			job.restorationConfirmed = true;
			m_LastRestorationDiagnostic = "The exact original native editor camera state was already present";
			return true;
		}
		// Never overwrite a user, tool, or newer observer camera change. This
		// lease may restore only while every camera/projection value still equals
		// the exact state it installed (the original state for current view).
		if (!InstalledStateStillOwned(job))
			return false;

		api.SetCamera(job.originalWorldMatrix[3], job.originalWorldMatrix[2]);
		job.world.SetCameraEx(job.originalWorldCameraId, job.originalWorldMatrix);
		job.world.SetCameraVerticalFOV(job.originalWorldCameraId, job.originalFov);

		vector restoredWorld[4];
		job.world.GetCurrentCamera(restoredWorld);
		float restoredFov;
		bool measured = MeasureVerticalFov(api, job.world, job.originalWorldCameraId, restoredFov);
		bool exact = true;
		if (!measured)
		{
			exact = false;
			m_LastRestorationDiagnostic = "The restored native editor projection could not be measured";
		}
		else if (job.world.GetCurrentCameraId() != job.originalWorldCameraId)
		{
			exact = false;
			m_LastRestorationDiagnostic = "The restored native editor camera slot did not match the original slot";
		}
		else if (!MatrixEquals(restoredWorld, job.originalWorldMatrix))
		{
			exact = false;
			m_LastRestorationDiagnostic = "The restored native editor camera matrix did not match the original matrix";
		}
		else if (Math.AbsFloat(restoredFov - job.originalFov) > FOV_EPSILON)
		{
			exact = false;
			m_LastRestorationDiagnostic = "The restored native editor FOV did not match the original FOV (expected " + job.originalFov.ToString() + ", actual " + restoredFov.ToString() + ")";
		}
		else if (Math.AbsFloat(job.world.GetCameraFarPlane(job.originalWorldCameraId) - job.originalFarPlane) > MATRIX_EPSILON)
		{
			exact = false;
			m_LastRestorationDiagnostic = "The restored native editor far plane did not match the original far plane";
		}
		job.restorationConfirmed = exact;
		if (exact)
		{
			job.cameraLeaseHeld = false;
			m_LastRestorationDiagnostic = "The exact native editor camera slot, matrix, FOV, and far plane were restored";
		}
		return exact;
	}

	protected bool InstalledStateStillOwned(EMCP_WB_ObserverJob job)
	{
		if (!job || !job.world)
		{
			m_LastRestorationDiagnostic = "The installed camera state lost its editor world";
			return false;
		}
		if (job.world.GetCurrentCameraId() != job.originalWorldCameraId)
		{
			m_LastRestorationDiagnostic = "The active native editor camera slot changed after installation";
			return false;
		}
		vector actualWorld[4];
		job.world.GetCurrentCamera(actualWorld);
		WorldEditor worldEditor = Workbench.GetModule(WorldEditor);
		WorldEditorAPI api = null;
		if (worldEditor)
			api = worldEditor.GetApi();
		if (!api || api.GetScreenWidth() != job.viewportWidth || api.GetScreenHeight() != job.viewportHeight)
		{
			m_LastRestorationDiagnostic = "The native editor viewport binding changed after camera installation";
			return false;
		}
		float actualFov;
		if (!MeasureVerticalFov(api, job.world, job.originalWorldCameraId, actualFov))
		{
			m_LastRestorationDiagnostic = "The installed native editor projection could no longer be measured";
			return false;
		}
		if (!MatrixEquals(actualWorld, job.installedWorldMatrix))
		{
			m_LastRestorationDiagnostic = "The native editor camera matrix changed after observer installation";
			return false;
		}
		if (Math.AbsFloat(actualFov - job.installedFov) > FOV_EPSILON)
		{
			m_LastRestorationDiagnostic = "The native editor FOV changed after observer installation";
			return false;
		}
		if (Math.AbsFloat(job.world.GetCameraFarPlane(job.originalWorldCameraId) - job.originalFarPlane) > MATRIX_EPSILON)
		{
			m_LastRestorationDiagnostic = "The native editor far plane changed during observer installation";
			return false;
		}
		m_LastRestorationDiagnostic = "The observer still owns the exact installed native editor camera state";
		return true;
	}

	protected bool OriginalStateAlreadyPresent(EMCP_WB_ObserverJob job)
	{
		if (!job || !job.world)
		{
			m_LastRestorationDiagnostic = "The original camera snapshot lost its editor world";
			return false;
		}
		if (job.world.GetCurrentCameraId() != job.originalWorldCameraId)
		{
			m_LastRestorationDiagnostic = "The original native editor camera slot is no longer active";
			return false;
		}
		vector actualWorld[4];
		job.world.GetCurrentCamera(actualWorld);
		WorldEditor worldEditor = Workbench.GetModule(WorldEditor);
		WorldEditorAPI api = null;
		if (worldEditor)
			api = worldEditor.GetApi();
		if (!api || api.GetScreenWidth() != job.viewportWidth || api.GetScreenHeight() != job.viewportHeight)
		{
			m_LastRestorationDiagnostic = "The original native editor viewport binding is no longer active";
			return false;
		}
		float actualFov;
		if (!MeasureVerticalFov(api, job.world, job.originalWorldCameraId, actualFov))
		{
			m_LastRestorationDiagnostic = "The original native editor projection could not be remeasured";
			return false;
		}
		if (!MatrixEquals(actualWorld, job.originalWorldMatrix))
		{
			m_LastRestorationDiagnostic = "The current native editor matrix does not match the original snapshot";
			return false;
		}
		if (Math.AbsFloat(actualFov - job.originalFov) > FOV_EPSILON)
		{
			m_LastRestorationDiagnostic = "The current native editor FOV does not match the original snapshot";
			return false;
		}
		if (Math.AbsFloat(job.world.GetCameraFarPlane(job.originalWorldCameraId) - job.originalFarPlane) > MATRIX_EPSILON)
		{
			m_LastRestorationDiagnostic = "The current native editor far plane does not match the original snapshot";
			return false;
		}
		m_LastRestorationDiagnostic = "The exact original native editor camera state is present";
		return true;
	}

	protected bool MeasureVerticalFov(WorldEditorAPI api, BaseWorld world, int cameraId, out float fovDegrees)
	{
		fovDegrees = 0;
		if (!api || !world || cameraId < 0)
		{
			m_LastProjectionDiagnostic = "The editor projection binding is unavailable";
			return false;
		}
		int width = api.GetScreenWidth();
		int height = api.GetScreenHeight();
		if (width < 2 || height < 2)
		{
			m_LastProjectionDiagnostic = "The editor viewport dimensions are unavailable";
			return false;
		}
		vector centerDirection;
		vector topDirection;
		vector bottomDirection;
		// ProjectViewportToWorld samples integer screen pixels. Fractional samples
		// truncate, so the old quarter-height float offset produced unequal top and
		// bottom distances in even-sized viewports. Keep every sample on the integer
		// pixel lattice and derive the exact normalized span for odd dimensions.
		int centerPixelX = width / 2;
		int centerPixelY = height / 2;
		int samplePixelOffset = height / 4;
		if (samplePixelOffset < 1)
		{
			m_LastProjectionDiagnostic = "The editor viewport is too short to sample its perspective projection";
			return false;
		}
		float centerX = centerPixelX;
		float centerY = centerPixelY;
		float sampleOffset = samplePixelOffset;
		float sampleScale = (2.0 * samplePixelOffset) / height;
		world.ProjectViewportToWorld(centerX, centerY, cameraId, width, height, centerDirection);
		world.ProjectViewportToWorld(centerX, centerY - sampleOffset, cameraId, width, height, topDirection);
		world.ProjectViewportToWorld(centerX, centerY + sampleOffset, cameraId, width, height, bottomDirection);
		float centerLength = centerDirection.Length();
		float topLength = topDirection.Length();
		float bottomLength = bottomDirection.Length();
		if (centerLength <= 0.000001 || topLength <= 0.000001 || bottomLength <= 0.000001)
		{
			m_LastProjectionDiagnostic = "The editor viewport projection rays are unavailable";
			return false;
		}
		float topCosine = vector.Dot(centerDirection / centerLength, topDirection / topLength);
		float bottomCosine = vector.Dot(centerDirection / centerLength, bottomDirection / bottomLength);
		topCosine = Math.Clamp(topCosine, -1, 1);
		bottomCosine = Math.Clamp(bottomCosine, -1, 1);
		float topSampleRadians = Math.Acos(topCosine);
		float bottomSampleRadians = Math.Acos(bottomCosine);
		if (Math.AbsFloat(topSampleRadians - bottomSampleRadians) * Math.RAD2DEG > FOV_SYMMETRY_EPSILON)
		{
			m_LastProjectionDiagnostic = "The active editor projection is asymmetric or unsupported (viewport=" + width.ToString() + "x" + height.ToString() + ", topSampleDegrees=" + (topSampleRadians * Math.RAD2DEG).ToString() + ", bottomSampleDegrees=" + (bottomSampleRadians * Math.RAD2DEG).ToString() + ", center=" + centerDirection.ToString() + ", top=" + topDirection.ToString() + ", bottom=" + bottomDirection.ToString() + ")";
			return false;
		}
		float sampleRadians = (topSampleRadians + bottomSampleRadians) * 0.5;
		fovDegrees = 2 * Math.Atan2(Math.Tan(sampleRadians), sampleScale) * Math.RAD2DEG;
		if (fovDegrees != fovDegrees || fovDegrees < 1 || fovDegrees > 179)
		{
			m_LastProjectionDiagnostic = "The active editor projection is not a supported perspective view";
			return false;
		}
		m_LastProjectionDiagnostic = "Native editor perspective projection measured";
		return true;
	}

	protected bool ParseMatrix(string row0, string row1, string row2, string row3, out vector matrix[4])
	{
		// Enforce out/inout parameters require addressable locals; a computed
		// array element cannot be passed directly as an out argument.
		vector parsed0;
		vector parsed1;
		vector parsed2;
		vector parsed3;
		if (!ParseVector(row0, parsed0) || !ParseVector(row1, parsed1) || !ParseVector(row2, parsed2) || !ParseVector(row3, parsed3))
			return false;
		matrix[0] = parsed0;
		matrix[1] = parsed1;
		matrix[2] = parsed2;
		matrix[3] = parsed3;
		return CameraMatrixValid(matrix);
	}

	protected bool CameraMatrixValid(vector matrix[4])
	{
		// Keep the 0.001 submitted-matrix validation local; it is distinct from
		// MATRIX_EPSILON restoration equality in the contract tuning ledger.
		float len0 = matrix[0].Length();
		float len1 = matrix[1].Length();
		float len2 = matrix[2].Length();
		if (len0 != len0 || len1 != len1 || len2 != len2 || Math.AbsFloat(len0 - 1) > 0.001 || Math.AbsFloat(len1 - 1) > 0.001 || Math.AbsFloat(len2 - 1) > 0.001)
			return false;
		if (Math.AbsFloat(vector.Dot(matrix[0], matrix[1])) > 0.001 || Math.AbsFloat(vector.Dot(matrix[0], matrix[2])) > 0.001 || Math.AbsFloat(vector.Dot(matrix[1], matrix[2])) > 0.001)
			return false;
		float positionLength = matrix[3].Length();
		return positionLength == positionLength && positionLength <= 1000000;
	}

	protected bool ParseVector(string value, out vector result)
	{
		array<string> parts = {};
		value.Split(" ", parts, false);
		if (parts.Count() != 3)
			return false;
		float x = parts[0].ToFloat();
		float y = parts[1].ToFloat();
		float z = parts[2].ToFloat();
		if (x != x || y != y || z != z || Math.AbsFloat(x) > 1000000 || Math.AbsFloat(y) > 1000000 || Math.AbsFloat(z) > 1000000)
			return false;
		result = Vector(x, y, z);
		return true;
	}

	protected bool ParseDecimal(string value, out float result)
	{
		result = 0;
		if (value.IsEmpty() || value.Length() > 32)
			return false;
		int start;
		if (value.Substring(0, 1) == "-")
		{
			if (value.Length() == 1)
				return false;
			start = 1;
		}
		bool decimalSeen;
		int digits;
		for (int index = start; index < value.Length(); index++)
		{
			int character = value.ToAscii(index);
			if (character >= 48 && character <= 57)
			{
				digits++;
				continue;
			}
			if (character == 46 && !decimalSeen)
			{
				decimalSeen = true;
				continue;
			}
			return false;
		}
		if (digits <= 0 || value.EndsWith("."))
			return false;
		result = value.ToFloat();
		return result == result && Math.AbsFloat(result) <= 1000000000;
	}

	protected bool MatrixEquals(vector left[4], vector right[4])
	{
		for (int row = 0; row < 4; row++)
		{
			for (int column = 0; column < 3; column++)
			{
				if (Math.AbsFloat(left[row][column] - right[row][column]) > MATRIX_EPSILON)
					return false;
			}
		}
		return true;
	}

	protected bool Identifier(string value, int minimum, int maximum)
	{
		if (value.Length() < minimum || value.Length() > maximum)
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

	protected string NormalizedPath(string value)
	{
		string normalized = value;
		normalized.Replace("\\", "/");
		normalized.ToLower();
		return normalized;
	}
}
