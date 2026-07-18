class RFO_ObserverCameraLease
{
	protected string m_RFO_JobId;
	protected string m_RFO_LeaseId;
	protected BaseWorld m_RFO_World;
	protected int m_RFO_WorldEpoch;
	protected CameraManager m_RFO_CameraManager;
	protected CameraBase m_RFO_OriginalCamera;
	protected RFO_ObserverCamera m_RFO_ObserverCamera;
	protected vector m_RFO_OriginalMatrix[4];
	protected float m_RFO_OriginalFov;
	protected float m_RFO_OriginalNearPlane;
	protected float m_RFO_OriginalFarPlane;
	protected vector m_RFO_ActualMatrix[4];
	protected float m_RFO_ActualFovDegrees;
	protected bool m_RFO_UsesDetachedPlayerCamera;
	protected int m_RFO_WorldCameraId;
	protected int m_RFO_LastPostFrameCommit;
	protected bool m_RFO_Acquired;
	protected bool m_RFO_Restoring;
	protected bool m_RFO_RestorationConfirmed;
	protected bool m_RFO_RestoreTargetSelected;

	bool Acquire(string jobId, BaseWorld world, int worldEpoch, vector requestedMatrix[4], float fovDegrees)
	{
		if (m_RFO_Acquired || !world || !RFO_ObserverCapabilities.CAMERA_RESTORE_PROVEN)
			return false;
		ArmaReforgerScripted game = GetGame();
		if (!game || game.GetWorld() != world)
			return false;

		CameraManager manager = game.GetCameraManager();
		CameraBase original;
		bool detachedPlayerCamera;
		if (manager)
			original = manager.CurrentCamera();
		if (!original || original.IsDeleted())
		{
			original = FindPlayerCamera();
			detachedPlayerCamera = original && !original.IsDeleted();
		}
		// Exact restoration requires a CameraBase snapshot, including the near
		// plane. Reforger 1.7 exposes no BaseWorld near-plane getter, so a raw
		// world-slot-only camera cannot be leased without inventing state.
		if (!original || original.IsDeleted())
			return false;

		int cameraId = original.GetCameraIndex();
		if (cameraId < 0 || world.GetCurrentCameraId() != cameraId)
			return false;
		original.GetWorldCameraTransform(m_RFO_OriginalMatrix);
		m_RFO_OriginalFov = original.GetVerticalFOV();
		m_RFO_OriginalNearPlane = original.GetNearPlane();
		m_RFO_OriginalFarPlane = original.GetFarPlane();
		RFO_ObserverCamera observer = SpawnObserverCamera(game, world, cameraId, requestedMatrix, fovDegrees, m_RFO_OriginalNearPlane, m_RFO_OriginalFarPlane);
		if (!observer)
			return false;

		// A manager-owned original can be replaced deterministically only when both
		// cameras are registered. MpTest instead exposes a detached player camera;
		// that path deliberately leaves CameraManager untouched and commits the
		// observer entity to the already-active BaseWorld slot in POSTFRAME.
		if (!detachedPlayerCamera)
		{
			if (manager && CameraRegistered(manager, original) && CameraRegistered(manager, observer) && manager.CurrentCamera() == original)
				manager.SetCamera(observer);
			if (!manager || manager.CurrentCamera() != observer)
			{
				DestroyObserverCamera(observer);
				return false;
			}
		}
		else if (manager && manager.CurrentCamera() && manager.CurrentCamera() != observer)
		{
			DestroyObserverCamera(observer);
			return false;
		}
		else if (manager && manager.CurrentCamera() == observer)
		{
			// Some runtimes auto-select the first newly registered camera. Continue
			// only if the detached original is also registered and can be restored.
			if (!CameraRegistered(manager, original))
			{
				original.SetWorldTransform(m_RFO_OriginalMatrix);
				original.SetVerticalFOV(m_RFO_OriginalFov);
				original.SetNearPlane(m_RFO_OriginalNearPlane);
				original.SetFarPlane(m_RFO_OriginalFarPlane);
				original.ApplyTransform(0.0);
				DestroyObserverCamera(observer);
				return false;
			}
			detachedPlayerCamera = false;
		}

		Initialize(jobId, world, worldEpoch, manager, original, observer, cameraId, requestedMatrix, fovDegrees);
		m_RFO_UsesDetachedPlayerCamera = detachedPlayerCamera;
		observer.Arm();
		return true;
	}

	bool CommitPostFrame(RFO_ObserverCamera camera, BaseWorld world, int currentWorldEpoch, float timeSlice)
	{
		if (!m_RFO_Acquired || m_RFO_Restoring || camera != m_RFO_ObserverCamera || !camera || !camera.IsArmed() || camera.IsDeleted())
			return false;
		if (world != m_RFO_World || currentWorldEpoch != m_RFO_WorldEpoch || world.GetCurrentCameraId() != m_RFO_WorldCameraId)
			return false;
		if (!m_RFO_UsesDetachedPlayerCamera && (!m_RFO_CameraManager || m_RFO_CameraManager.CurrentCamera() != camera))
			return false;

		ApplyRequestedState(camera);
		camera.ApplyTransform(timeSlice);
		vector committedMatrix[4];
		camera.GetWorldCameraTransform(committedMatrix);
		if (!MatrixEquals(committedMatrix, m_RFO_ActualMatrix)
			|| Math.AbsFloat(camera.GetVerticalFOV() - m_RFO_ActualFovDegrees) > 0.0001
			|| !PublishedCameraMatches(camera, m_RFO_ActualMatrix, m_RFO_ActualFovDegrees))
			return false;
		m_RFO_LastPostFrameCommit = world.GetFrameNumber();
		return true;
	}

	bool Restore(string jobId, BaseWorld world, int currentWorldEpoch)
	{
		if (!m_RFO_Acquired)
			return m_RFO_RestorationConfirmed;
		if (jobId != m_RFO_JobId)
			return false;
		m_RFO_Restoring = true;
		if (m_RFO_ObserverCamera)
			m_RFO_ObserverCamera.Disarm();
		if (m_RFO_UsesDetachedPlayerCamera)
			return RestoreDetachedPlayerCamera(world, currentWorldEpoch);

		if (world != m_RFO_World || currentWorldEpoch != m_RFO_WorldEpoch)
			return RetireOldWorldObserver();
		if (!m_RFO_CameraManager)
			return false;
		CameraBase current = m_RFO_CameraManager.CurrentCamera();
		if (!m_RFO_ObserverCamera || m_RFO_ObserverCamera.IsDeleted())
		{
			if (current && !current.IsDeleted() && current != m_RFO_ObserverCamera)
				Clear(false);
			return false;
		}
		if (m_RFO_RestoreTargetSelected && current == m_RFO_OriginalCamera)
			return FinishOriginalRestoration();
		if (current != m_RFO_ObserverCamera)
		{
			// Another camera owner won. Never switch away from it during cleanup.
			DestroyObserverCamera(m_RFO_ObserverCamera);
			Clear(false);
			return false;
		}
		if (!m_RFO_OriginalCamera || m_RFO_OriginalCamera.IsDeleted() || !CameraRegistered(m_RFO_CameraManager, m_RFO_OriginalCamera))
			return false;

		ApplyOriginalState(m_RFO_OriginalCamera);
		m_RFO_CameraManager.SetCamera(m_RFO_OriginalCamera);
		if (m_RFO_CameraManager.CurrentCamera() != m_RFO_OriginalCamera)
			return false;
		m_RFO_RestoreTargetSelected = true;
		return FinishOriginalRestoration();
	}

	bool IsHeld()
	{
		if (!m_RFO_Acquired || !m_RFO_ObserverCamera || m_RFO_ObserverCamera.IsDeleted() || !m_RFO_ObserverCamera.IsArmed())
			return false;
		if (!m_RFO_World || m_RFO_World.GetCurrentCameraId() != m_RFO_WorldCameraId)
			return false;
		if (m_RFO_UsesDetachedPlayerCamera)
			return true;
		return m_RFO_CameraManager && m_RFO_CameraManager.CurrentCamera() == m_RFO_ObserverCamera;
	}

	bool HasOutstandingLease()
	{
		return m_RFO_Acquired;
	}

	bool IsRestoring()
	{
		return m_RFO_Restoring;
	}

	bool RestorationConfirmed()
	{
		return m_RFO_RestorationConfirmed;
	}

	bool IsOwnedBy(string jobId)
	{
		return m_RFO_JobId == jobId && IsHeld();
	}

	bool MaintainRequestedView(string jobId)
	{
		if (m_RFO_JobId != jobId || !IsHeld() || m_RFO_LastPostFrameCommit <= 0)
			return false;
		int frame = m_RFO_World.GetFrameNumber();
		return frame - m_RFO_LastPostFrameCommit <= 2;
	}

	bool AwaitingFirstPostFrameCommit(string jobId)
	{
		return m_RFO_JobId == jobId && IsHeld() && m_RFO_LastPostFrameCommit <= 0;
	}

	string GetLeaseId()
	{
		return m_RFO_LeaseId;
	}

	int GetObserverCameraId()
	{
		return m_RFO_WorldCameraId;
	}

	void GetActualMatrix(out vector matrix[4])
	{
		for (int axis = 0; axis < 4; axis++)
			matrix[axis] = m_RFO_ActualMatrix[axis];
	}

	float GetActualFovDegrees()
	{
		return m_RFO_ActualFovDegrees;
	}

	protected void Initialize(string jobId, BaseWorld world, int worldEpoch, CameraManager manager, CameraBase original, RFO_ObserverCamera observer, int cameraId, vector requestedMatrix[4], float fovDegrees)
	{
		m_RFO_JobId = jobId;
		m_RFO_LeaseId = "lease-" + jobId;
		m_RFO_World = world;
		m_RFO_WorldEpoch = worldEpoch;
		m_RFO_CameraManager = manager;
		m_RFO_OriginalCamera = original;
		m_RFO_ObserverCamera = observer;
		m_RFO_WorldCameraId = cameraId;
		m_RFO_ActualFovDegrees = fovDegrees;
		for (int axis = 0; axis < 4; axis++)
			m_RFO_ActualMatrix[axis] = requestedMatrix[axis];
		m_RFO_LastPostFrameCommit = 0;
		m_RFO_Acquired = true;
		m_RFO_Restoring = false;
		m_RFO_RestorationConfirmed = false;
		m_RFO_RestoreTargetSelected = false;
		m_RFO_UsesDetachedPlayerCamera = false;
	}

	protected RFO_ObserverCamera SpawnObserverCamera(ArmaReforgerScripted game, BaseWorld world, int cameraId, vector requestedMatrix[4], float fovDegrees, float nearPlane, float farPlane)
	{
		if (!game || !world || cameraId < 0)
			return null;
		EntitySpawnParams spawnParams = new EntitySpawnParams();
		spawnParams.TransformMode = ETransformMode.WORLD;
		spawnParams.Transform = requestedMatrix;
		RFO_ObserverCamera camera = RFO_ObserverCamera.Cast(game.SpawnEntity(RFO_ObserverCamera, world, spawnParams));
		if (!camera || camera.IsDeleted())
			return null;
		camera.SetCameraIndex(cameraId);
		camera.SetWorldTransform(requestedMatrix);
		camera.SetVerticalFOV(fovDegrees);
		camera.SetNearPlane(nearPlane);
		camera.SetFarPlane(farPlane);
		return camera;
	}

	protected void ApplyRequestedState(RFO_ObserverCamera camera)
	{
		camera.SetWorldTransform(m_RFO_ActualMatrix);
		camera.SetVerticalFOV(m_RFO_ActualFovDegrees);
		camera.SetNearPlane(m_RFO_OriginalNearPlane);
		camera.SetFarPlane(m_RFO_OriginalFarPlane);
	}

	protected void ApplyOriginalState(CameraBase camera)
	{
		camera.SetWorldTransform(m_RFO_OriginalMatrix);
		camera.SetVerticalFOV(m_RFO_OriginalFov);
		camera.SetNearPlane(m_RFO_OriginalNearPlane);
		camera.SetFarPlane(m_RFO_OriginalFarPlane);
	}

	protected bool RestoreDetachedPlayerCamera(BaseWorld world, int currentWorldEpoch)
	{
		if (world != m_RFO_World || currentWorldEpoch != m_RFO_WorldEpoch)
			return RetireOldWorldObserver();
		if (m_RFO_RestoreTargetSelected)
			return FinishDetachedRestoration();
		if (!m_RFO_OriginalCamera || m_RFO_OriginalCamera.IsDeleted())
			return false;
		if (!WorldCameraMatches(m_RFO_ActualMatrix, m_RFO_ActualFovDegrees))
		{
			DestroyObserverCamera(m_RFO_ObserverCamera);
			Clear(false);
			return false;
		}
		ApplyOriginalState(m_RFO_OriginalCamera);
		m_RFO_OriginalCamera.ApplyTransform(0.0);
		m_RFO_RestoreTargetSelected = true;
		return FinishDetachedRestoration();
	}

	protected bool FinishDetachedRestoration()
	{
		if (!m_RFO_OriginalCamera || m_RFO_OriginalCamera.IsDeleted())
			return false;
		ApplyOriginalState(m_RFO_OriginalCamera);
		m_RFO_OriginalCamera.ApplyTransform(0.0);
		if (!OriginalCameraMatches() || !PublishedCameraMatches(m_RFO_OriginalCamera, m_RFO_OriginalMatrix, m_RFO_OriginalFov))
			return false;
		DestroyObserverCamera(m_RFO_ObserverCamera);
		Clear(true);
		return true;
	}

	protected bool FinishOriginalRestoration()
	{
		if (!m_RFO_CameraManager || !m_RFO_OriginalCamera || m_RFO_OriginalCamera.IsDeleted() || m_RFO_CameraManager.CurrentCamera() != m_RFO_OriginalCamera)
			return false;
		ApplyOriginalState(m_RFO_OriginalCamera);
		m_RFO_OriginalCamera.ApplyTransform(0.0);
		if (!OriginalCameraMatches() || !PublishedCameraMatches(m_RFO_OriginalCamera, m_RFO_OriginalMatrix, m_RFO_OriginalFov))
			return false;
		DestroyObserverCamera(m_RFO_ObserverCamera);
		Clear(true);
		return true;
	}

	protected bool OriginalCameraMatches()
	{
		vector matrix[4];
		m_RFO_OriginalCamera.GetWorldCameraTransform(matrix);
		return MatrixEquals(matrix, m_RFO_OriginalMatrix)
			&& Math.AbsFloat(m_RFO_OriginalCamera.GetVerticalFOV() - m_RFO_OriginalFov) <= 0.0001
			&& Math.AbsFloat(m_RFO_OriginalCamera.GetNearPlane() - m_RFO_OriginalNearPlane) <= 0.0001
			&& Math.AbsFloat(m_RFO_OriginalCamera.GetFarPlane() - m_RFO_OriginalFarPlane) <= 0.0001;
	}

	protected bool RetireOldWorldObserver()
	{
		if (!m_RFO_UsesDetachedPlayerCamera && m_RFO_CameraManager && m_RFO_ObserverCamera && m_RFO_CameraManager.CurrentCamera() == m_RFO_ObserverCamera)
		{
			CameraBase replacement = m_RFO_OriginalCamera;
			if (!replacement || replacement.IsDeleted() || !CameraRegistered(m_RFO_CameraManager, replacement))
				replacement = FindPlayerCamera();
			if (!replacement || replacement.IsDeleted() || !CameraRegistered(m_RFO_CameraManager, replacement))
				return false;
			m_RFO_CameraManager.SetCamera(replacement);
			if (m_RFO_CameraManager.CurrentCamera() != replacement)
				return false;
		}
		DestroyObserverCamera(m_RFO_ObserverCamera);
		Clear(true);
		return true;
	}

	protected bool CameraRegistered(CameraManager manager, CameraBase camera)
	{
		if (!manager || !camera || camera.IsDeleted())
			return false;
		array<CameraBase> cameras = new array<CameraBase>();
		manager.GetCamerasList(cameras);
		return cameras.Contains(camera);
	}

	protected bool WorldCameraMatches(vector expectedMatrix[4], float expectedFov)
	{
		if (!m_RFO_World || m_RFO_World.GetCurrentCameraId() != m_RFO_WorldCameraId)
			return false;
		int cameraId;
		vector actualMatrix[4];
		float actualFov;
		if (!RFO_ObserverCameraProjection.SnapshotCurrent(m_RFO_World, cameraId, actualMatrix, actualFov) || cameraId != m_RFO_WorldCameraId)
			return false;
		return MatrixEquals(actualMatrix, expectedMatrix) && Math.AbsFloat(actualFov - expectedFov) <= 0.05;
	}

	protected bool PublishedCameraMatches(CameraBase camera, vector expectedMatrix[4], float expectedFov)
	{
		if (!m_RFO_World || !camera || camera.IsDeleted())
			return false;
		int cameraId;
		vector actualMatrix[4];
		float actualFov;
		if (!RFO_ObserverCameraProjection.SnapshotCurrent(m_RFO_World, cameraId, actualMatrix, actualFov))
			return false;
		return cameraId == camera.GetCameraIndex()
			&& MatrixEquals(actualMatrix, expectedMatrix)
			&& Math.AbsFloat(actualFov - expectedFov) <= 0.05;
	}

	protected bool MatrixEquals(vector left[4], vector right[4])
	{
		for (int row = 0; row < 4; row++)
		{
			for (int column = 0; column < 3; column++)
			{
				if (Math.AbsFloat(left[row][column] - right[row][column]) > 0.0001)
					return false;
			}
		}
		return true;
	}

	protected CameraBase FindPlayerCamera()
	{
		ArmaReforgerScripted game = GetGame();
		if (!game)
			return null;
		PlayerController playerController = game.GetPlayerController();
		if (!playerController)
			return null;
		return playerController.GetPlayerCamera();
	}

	protected void DestroyObserverCamera(RFO_ObserverCamera camera)
	{
		if (!camera || camera.IsDeleted())
			return;
		camera.Disarm();
		delete camera;
	}

	protected void Clear(bool restorationConfirmed)
	{
		m_RFO_Acquired = false;
		m_RFO_Restoring = false;
		m_RFO_RestorationConfirmed = restorationConfirmed;
		m_RFO_JobId = string.Empty;
		m_RFO_LeaseId = string.Empty;
		m_RFO_World = null;
		m_RFO_WorldEpoch = 0;
		m_RFO_CameraManager = null;
		m_RFO_OriginalCamera = null;
		m_RFO_ObserverCamera = null;
		m_RFO_RestoreTargetSelected = false;
		m_RFO_UsesDetachedPlayerCamera = false;
		m_RFO_WorldCameraId = 0;
		m_RFO_LastPostFrameCommit = 0;
	}
}
