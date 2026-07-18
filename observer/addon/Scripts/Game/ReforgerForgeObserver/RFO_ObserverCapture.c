class RFO_ObserverCapture
{
	static const string CAPTURE_DIRECTORY = "$profile:ReforgerForgeObserver/captures";
	static const int MAX_SCREENSHOT_WAIT_FRAMES = 300;
	static const int MINIMUM_RENDER_READY_MS = 3000;
	static const float MAX_PRELOAD_RADIUS = 10000.0;
	protected bool m_RFO_Ready;
	protected int m_RFO_RenderReadySinceTick;
	protected string m_RFO_LastPreloadDiagnostic;
	protected string m_RFO_LastIssueDiagnostic;

	bool Initialize()
	{
		m_RFO_RenderReadySinceTick = 0;
		m_RFO_Ready = !System.IsConsoleApp() && RFO_ObserverCapabilities.RENDER_CAPTURE_PROVEN && FileIO.MakeDirectory(CAPTURE_DIRECTORY);
		return m_RFO_Ready;
	}

	bool IsReady()
	{
		return m_RFO_Ready;
	}

	bool BeginPreload(BaseWorld world)
	{
		m_RFO_RenderReadySinceTick = 0;
		m_RFO_LastPreloadDiagnostic = string.Empty;
		ArmaReforgerScripted game = GetGame();
		if (!m_RFO_Ready || !world || !game || game.GetWorld() != world)
		{
			m_RFO_LastPreloadDiagnostic = "Runtime world is unavailable for screenshot preload";
			return false;
		}
		vector matrix[4];
		float fovDegrees;
		if (!SnapshotCurrentCamera(matrix, fovDegrees))
		{
			m_RFO_LastPreloadDiagnostic = "Current gameplay camera is unavailable for screenshot preload";
			return false;
		}
		int cameraId = world.GetCurrentCameraId();
		float radius = world.GetCameraFarPlane(cameraId);
		if (radius != radius || radius <= 0.0 || radius > 1000000000.0)
		{
			m_RFO_LastPreloadDiagnostic = "Current world camera has no valid screenshot preload radius";
			return false;
		}
		radius = Math.Min(radius, MAX_PRELOAD_RADIUS);
		// The runtime can return false both when no new preload is needed and while
		// an existing preload owns the request. Poll IsPreloadFinished under the
		// job deadline instead of treating this advisory return as rejection.
		game.BeginPreload(world, matrix[3], radius);
		return true;
	}

	string GetLastPreloadDiagnostic()
	{
		return m_RFO_LastPreloadDiagnostic;
	}

	bool RuntimeReady()
	{
		ArmaReforgerScripted game = GetGame();
		vector matrix[4];
		float fovDegrees;
		if (!m_RFO_Ready || !game || !game.IsPreloadFinished() || !SnapshotCurrentCamera(matrix, fovDegrees))
		{
			m_RFO_RenderReadySinceTick = 0;
			return false;
		}
		int now = System.GetTickCount();
		if (m_RFO_RenderReadySinceTick == 0)
		{
			m_RFO_RenderReadySinceTick = now;
			return false;
		}
		return System.GetTickCount(m_RFO_RenderReadySinceTick) >= MINIMUM_RENDER_READY_MS;
	}

	bool Issue(RFO_ObserverJob job, BaseWorld world, int serviceFrame)
	{
		m_RFO_LastIssueDiagnostic = string.Empty;
		if (!m_RFO_Ready)
		{
			m_RFO_LastIssueDiagnostic = "Runtime screenshot capture is not initialized";
			return false;
		}
		if (!RuntimeReady())
		{
			m_RFO_LastIssueDiagnostic = "Runtime preload or gameplay camera is not ready for screenshot capture";
			return false;
		}
		vector actualMatrix[4];
		float actualFov;
		if (!SnapshotCurrentCamera(actualMatrix, actualFov))
		{
			m_RFO_LastIssueDiagnostic = "Current gameplay camera is unavailable for screenshot evidence";
			return false;
		}
		return IssueSnapshot(job, world, serviceFrame, actualMatrix, actualFov);
	}

	// Explicit views are issued by the observer camera's POSTFRAME callback.
	// Snapshot BaseWorld rather than PlayerController so evidence metadata binds
	// to the render slot that was committed immediately before this call.
	bool IssueCommitted(RFO_ObserverJob job, BaseWorld world, int serviceFrame, int expectedCameraId)
	{
		m_RFO_LastIssueDiagnostic = string.Empty;
		if (!m_RFO_Ready || !world || world.GetCurrentCameraId() != expectedCameraId)
		{
			m_RFO_LastIssueDiagnostic = "Committed observer render camera is unavailable for screenshot evidence";
			return false;
		}
		int cameraId;
		vector actualMatrix[4];
		float actualFov;
		if (!RFO_ObserverCameraProjection.SnapshotCurrent(world, cameraId, actualMatrix, actualFov) || cameraId != expectedCameraId)
		{
			m_RFO_LastIssueDiagnostic = "Committed observer render camera could not be measured for screenshot evidence";
			return false;
		}
		return IssueSnapshot(job, world, serviceFrame, actualMatrix, actualFov);
	}

	protected bool IssueSnapshot(RFO_ObserverJob job, BaseWorld world, int serviceFrame, vector actualMatrix[4], float actualFov)
	{
		if (!job || !RFO_ObserverValidation.Identifier(job.jobId) || job.screenshotIssued)
		{
			m_RFO_LastIssueDiagnostic = "Runtime screenshot job state is invalid";
			return false;
		}
		string path = ScreenshotPath(job.jobId);
		if (FileIO.FileExists(path) && !FileIO.DeleteFile(path))
		{
			m_RFO_LastIssueDiagnostic = "Existing managed screenshot could not be removed";
			return false;
		}
		for (int axis = 0; axis < 4; axis++)
			job.actualCameraMatrix[axis] = actualMatrix[axis];
		job.actualFov = actualFov;
		job.hasActualCameraSnapshot = true;
		// Reforger 1.7 appends its BMP suffix to a named-filesystem screenshot
		// request. Keep the extensionless engine request separate from the exact
		// `.bmp` artifact path used for stability and intake checks.
		if (!System.MakeScreenshot(ScreenshotRequestPath(job.jobId)))
		{
			m_RFO_LastIssueDiagnostic = "System.MakeScreenshot rejected the managed BMP path";
			return false;
		}
		job.screenshotIssued = true;
		job.screenshotIssuedAt = RFO_ObserverTime.UtcNowIso();
		job.screenshotIssuedFrame = serviceFrame;
		if (world)
			job.screenshotIssuedFrame = world.GetFrameNumber();
		return true;
	}

	string GetLastIssueDiagnostic()
	{
		return m_RFO_LastIssueDiagnostic;
	}

	// Returns 1 after two rendered frames report the same positive size, zero
	// while the asynchronously-written BMP is still changing, and -1 on a
	// bounded failure.
	int CheckStable(RFO_ObserverJob job, BaseWorld world, int serviceFrame, int maxArtifactBytes)
	{
		if (!job || !job.screenshotIssued)
			return -1;
		int currentFrame = serviceFrame;
		if (world)
			currentFrame = world.GetFrameNumber();
		if (currentFrame - job.screenshotIssuedFrame > MAX_SCREENSHOT_WAIT_FRAMES)
			return -1;
		if (currentFrame <= job.screenshotIssuedFrame || !FileIO.FileExists(ScreenshotPath(job.jobId)))
			return 0;

		FileHandle file = FileIO.OpenFile(ScreenshotPath(job.jobId), FileMode.READ);
		if (!file)
			return 0;
		int length = file.GetLength();
		file.Close();
		if (length <= 54)
			return 0;
		if (length > maxArtifactBytes)
			return -1;
		if (length == job.screenshotLastLength)
			job.screenshotStableFrames++;
		else
		{
			job.screenshotLastLength = length;
			job.screenshotStableFrames = 0;
		}
		if (job.screenshotStableFrames < 2)
			return 0;
		job.screenshotStable = true;
		job.screenshotByteCount = length;
		job.screenshotCompletedAt = RFO_ObserverTime.UtcNowIso();
		return 1;
	}

	bool WriteCompletionManifest(RFO_ObserverJob job, string manifestJson)
	{
		if (!job || !job.screenshotStable || manifestJson.Length() <= 2 || manifestJson.Length() > 262144)
			return false;
		string path = CompletionPath(job.jobId);
		string temporary = path + ".tmp";
		FileHandle file = FileIO.OpenFile(temporary, FileMode.WRITE);
		if (!file)
			return false;
		file.Write(manifestJson, manifestJson.Length());
		file.Close();
		if (!FileIO.CopyFile(temporary, path))
			return false;
		FileIO.DeleteFile(temporary);
		return true;
	}

	bool BuildPoseMatrix(RFO_ObserverJob job, out vector matrix[4])
	{
		if (!job || job.viewKind != "pose")
			return false;
		float quaternion[4];
		for (int index = 0; index < 4; index++)
			quaternion[index] = job.orientation[index];
		vector rotation[3];
		Math3D.QuatToMatrix(quaternion, rotation);
		matrix[0] = rotation[0];
		matrix[1] = rotation[1];
		matrix[2] = rotation[2];
		matrix[3] = job.position;
		return true;
	}

	bool BuildLookAtMatrix(RFO_ObserverJob job, out vector matrix[4])
	{
		if (!job || job.viewKind != "lookAt" || vector.Distance(job.position, job.target) <= 0.0001)
			return false;
		vector direction = job.target - job.position;
		direction = direction / vector.Distance(vector.Zero, direction);
		vector up = vector.Up;
		if (Math.AbsFloat(direction[1]) > 0.98)
			up = Vector(0, 0, 1);
		SCR_Math3D.LookAt(job.position, job.target, up, matrix);
		matrix[3] = job.position;
		return true;
	}

	bool SnapshotCurrentCamera(out vector matrix[4], out float fovDegrees)
	{
		ArmaReforgerScripted game = GetGame();
		if (!game)
			return false;
		CameraManager manager = game.GetCameraManager();
		CameraBase camera;
		if (manager)
			camera = manager.CurrentCamera();
		if (!camera || camera.IsDeleted())
		{
			PlayerController playerController = game.GetPlayerController();
			if (playerController)
				camera = playerController.GetPlayerCamera();
		}
		if (camera && !camera.IsDeleted())
		{
			camera.GetWorldCameraTransform(matrix);
			fovDegrees = camera.GetVerticalFOV();
		}
		else
		{
			int cameraId;
			return RFO_ObserverCameraProjection.SnapshotCurrent(game.GetWorld(), cameraId, matrix, fovDegrees);
		}
		for (int row = 0; row < 4; row++)
		{
			for (int column = 0; column < 3; column++)
			{
				float component = matrix[row][column];
				if (component != component || Math.AbsFloat(component) > 1000000000.0)
					return false;
			}
		}
		// CameraBase.GetVerticalFOV is defined by the public engine API in
		// degrees. Keep the engine value exact; do not infer units by magnitude.
		return fovDegrees == fovDegrees && Math.AbsFloat(fovDegrees) <= 10000.0;
	}

	string ScreenshotPath(string jobId)
	{
		return CAPTURE_DIRECTORY + "/" + jobId + ".bmp";
	}

	string ScreenshotRequestPath(string jobId)
	{
		return CAPTURE_DIRECTORY + "/" + jobId;
	}

	string CompletionPath(string jobId)
	{
		return CAPTURE_DIRECTORY + "/" + jobId + ".complete.json";
	}
}
