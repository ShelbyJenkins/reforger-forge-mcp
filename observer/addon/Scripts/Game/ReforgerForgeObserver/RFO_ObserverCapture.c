class RFO_ObserverCapture
{
	static const string CAPTURE_DIRECTORY = "$profile:ReforgerForgeObserver/captures";
	static const int MAX_SCREENSHOT_WAIT_FRAMES = 300;
	protected bool m_RFO_Ready;

	bool Initialize()
	{
		m_RFO_Ready = !System.IsConsoleApp() && RFO_ObserverCapabilities.RENDER_CAPTURE_PROVEN && FileIO.MakeDirectory(CAPTURE_DIRECTORY);
		return m_RFO_Ready;
	}

	bool IsReady()
	{
		return m_RFO_Ready;
	}

	bool Issue(RFO_ObserverJob job, BaseWorld world, int serviceFrame)
	{
		if (!m_RFO_Ready || !job || !RFO_ObserverValidation.Identifier(job.jobId) || job.screenshotIssued)
			return false;
		string path = ScreenshotPath(job.jobId);
		if (FileIO.FileExists(path) && !FileIO.DeleteFile(path))
			return false;
		vector actualMatrix[4];
		float actualFov;
		if (!SnapshotCurrentCamera(actualMatrix, actualFov))
			return false;
		for (int axis = 0; axis < 4; axis++)
			job.actualCameraMatrix[axis] = actualMatrix[axis];
		job.actualFov = actualFov;
		job.hasActualCameraSnapshot = true;
		// The live engine appends its BMP format suffix to the requested name.
		// Pass an extensionless named-filesystem path, while all completion and
		// artifact checks use the exact resulting `.bmp` path below.
		if (!System.MakeScreenshot(ScreenshotRequestPath(job.jobId)))
			return false;
		job.screenshotIssued = true;
		job.screenshotIssuedAt = RFO_ObserverTime.UtcNowIso();
		job.screenshotIssuedFrame = serviceFrame;
		if (world)
			job.screenshotIssuedFrame = world.GetFrameNumber();
		return true;
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
		if (!game || !game.GetCameraManager())
			return false;
		CameraBase camera = game.GetCameraManager().CurrentCamera();
		if (!camera || camera.IsDeleted())
			return false;
		camera.GetWorldCameraTransform(matrix);
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
		fovDegrees = camera.GetVerticalFOV();
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
