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
	// MpTest's player camera is intentionally detached from CameraManager. Its
	// render slot can still be transactionally borrowed when the exact
	// CameraBase and BaseWorld publication are both proved on restoration.
	protected bool m_RFO_UsesDetachedPlayerCamera;
	protected int m_RFO_WorldCameraId;
	protected int m_RFO_LastPostFrameCommit;
	protected bool m_RFO_Acquired;
	protected bool m_RFO_Restoring;
	protected bool m_RFO_RestorationConfirmed;
	protected bool m_RFO_RestoreTargetSelected;
	protected bool m_RFO_RestorationPostFrameConfirmed;
	protected string m_RFO_LastLeaseabilityReason;
	// Kept separately from leaseability because heartbeat probes deliberately
	// refresh leaseability while a failed restoration still needs its first
	// concrete failure reason preserved for terminal diagnostics.
	protected string m_RFO_LastCameraFailureReason;

	// Read-only readiness probe shared by capability advertisement and the
	// per-job resolving state. It deliberately stops before spawning or
	// selecting an observer camera, so polling it cannot mutate camera state.
	bool CanAcquire(BaseWorld world)
	{
		ArmaReforgerScripted game;
		CameraManager manager;
		CameraBase original;
		bool detachedPlayerCamera;
		int cameraId;
		return ResolveLeaseableCamera(world, game, manager, original, detachedPlayerCamera, cameraId);
	}

	string GetLastLeaseabilityReason()
	{
		return m_RFO_LastLeaseabilityReason;
	}

	string GetLastCameraFailureReason()
	{
		return m_RFO_LastCameraFailureReason;
	}

	bool Acquire(string jobId, BaseWorld world, int worldEpoch, vector requestedMatrix[4], float fovDegrees)
	{
		ArmaReforgerScripted game;
		CameraManager manager;
		CameraBase original;
		bool detachedPlayerCamera;
		int cameraId;
		if (!ResolveLeaseableCamera(world, game, manager, original, detachedPlayerCamera, cameraId))
			return false;
		original.GetWorldCameraTransform(m_RFO_OriginalMatrix);
		m_RFO_OriginalFov = original.GetVerticalFOV();
		m_RFO_OriginalNearPlane = original.GetNearPlane();
		m_RFO_OriginalFarPlane = original.GetFarPlane();
		RFO_ObserverCamera observer = SpawnObserverCamera(game, world, cameraId, requestedMatrix, fovDegrees, m_RFO_OriginalNearPlane, m_RFO_OriginalFarPlane);
		if (!observer)
		{
			m_RFO_LastLeaseabilityReason = "observer_spawn_failed";
			return false;
		}

		// A manager-owned camera is switched by CameraManager. MpTest's detached
		// player camera instead keeps CameraManager untouched and publishes the
		// observer entity into its already-active BaseWorld slot in POSTFRAME.
		// Both paths must prove their exact restore target before release.
		if (!detachedPlayerCamera)
		{
			bool editorCameraInterlock = RFO_ObserverEditorCameraArbitration.CanBeginManagerLease(manager, original);
			if (editorCameraInterlock)
				RFO_ObserverEditorCameraArbitration.BeginManagerLease(manager, original);
			if (manager && CameraRegistered(manager, original) && CameraRegistered(manager, observer) && manager.CurrentCamera() == original)
				manager.SetCamera(observer);
			if (!manager || manager.CurrentCamera() != observer)
			{
				if (editorCameraInterlock)
					RFO_ObserverEditorCameraArbitration.EndManagerLease();
				DestroyObserverCamera(observer);
				m_RFO_LastLeaseabilityReason = "manager_selection_failed";
				return false;
			}
		}
		else if (manager && manager.CurrentCamera() && manager.CurrentCamera() != observer)
		{
			DestroyObserverCamera(observer);
			m_RFO_LastLeaseabilityReason = "detached_camera_owner_changed";
			return false;
		}
		else if (manager && manager.CurrentCamera() == observer)
		{
			// Some runtimes auto-select the newly spawned camera. Continue only if
			// the original is registered and can be selected during restoration.
			if (!CameraRegistered(manager, original))
			{
				ApplyOriginalState(original);
				original.ApplyTransform(0.0);
				DestroyObserverCamera(observer);
				m_RFO_LastLeaseabilityReason = "restore_target_unregistered";
				return false;
			}
			detachedPlayerCamera = false;
		}

		Initialize(jobId, world, worldEpoch, manager, original, observer, detachedPlayerCamera, cameraId, requestedMatrix, fovDegrees);
		observer.Arm();
		m_RFO_LastLeaseabilityReason = string.Empty;
		return true;
	}

	bool CommitPostFrame(RFO_ObserverCamera camera, BaseWorld world, int currentWorldEpoch, float timeSlice)
	{
		if (!m_RFO_Acquired || m_RFO_Restoring || camera != m_RFO_ObserverCamera || !camera || !camera.IsArmed() || camera.IsDeleted())
			return false;
		if (world != m_RFO_World || currentWorldEpoch != m_RFO_WorldEpoch || world.GetCurrentCameraId() != m_RFO_WorldCameraId)
			return false;
		if (!m_RFO_UsesDetachedPlayerCamera && (!m_RFO_CameraManager || m_RFO_CameraManager.CurrentCamera() != camera))
		{
			SetCameraFailureReason("camera_manager_owner_changed");
			return false;
		}

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
		// Keep the observer entity armed while restoration is pending. Its
		// POSTFRAME callback is the only point at which a CameraBase publication
		// can be verified after normal gameplay camera updates. Destruction is
		// deliberately deferred to this following Update call.
		if (m_RFO_RestorationPostFrameConfirmed)
		{
			if (!RestorationCleanupBindingStillCurrent(world, currentWorldEpoch))
			{
				SetCameraFailureReason("restore_cleanup_binding_changed");
				return false;
			}
			DestroyObserverCamera(m_RFO_ObserverCamera);
			Clear(true);
			return true;
		}
		if (m_RFO_UsesDetachedPlayerCamera)
			return RestoreDetachedPlayerCamera(world, currentWorldEpoch);
		if (world != m_RFO_World || currentWorldEpoch != m_RFO_WorldEpoch)
			return RetireOldWorldObserver();
		if (!m_RFO_CameraManager)
		{
			SetCameraFailureReason("restore_camera_manager_unavailable");
			return false;
		}
		CameraBase current = m_RFO_CameraManager.CurrentCamera();
		if (!m_RFO_ObserverCamera || m_RFO_ObserverCamera.IsDeleted())
		{
			SetCameraFailureReason("restore_observer_camera_unavailable");
			if (current && !current.IsDeleted() && current != m_RFO_ObserverCamera)
				Clear(false);
			return false;
		}
		if (m_RFO_RestoreTargetSelected && current == m_RFO_OriginalCamera)
			return false;
		if (current != m_RFO_ObserverCamera)
		{
			// Another camera owner won. Never switch away from it during cleanup.
			SetCameraFailureReason("restore_manager_owner_changed");
			DestroyObserverCamera(m_RFO_ObserverCamera);
			Clear(false);
			return false;
		}
		if (!m_RFO_OriginalCamera || m_RFO_OriginalCamera.IsDeleted() || !CameraRegistered(m_RFO_CameraManager, m_RFO_OriginalCamera))
		{
			SetCameraFailureReason("restore_target_unavailable");
			return false;
		}

		ApplyOriginalState(m_RFO_OriginalCamera);
		m_RFO_CameraManager.SetCamera(m_RFO_OriginalCamera);
		if (m_RFO_CameraManager.CurrentCamera() != m_RFO_OriginalCamera)
		{
			SetCameraFailureReason("restore_target_selection_failed");
			return false;
		}
		m_RFO_RestoreTargetSelected = true;
		return false;
	}

	// Restoration is staged from the service Update, but CameraBase publishes
	// its native render slot in POSTFRAME. Reapply and prove the original state
	// here, then disarm the witness without deleting it from its own callback.
	// The next Update observes the proof, destroys the observer, and clears the
	// lease transaction.
	bool CommitRestorationPostFrame(RFO_ObserverCamera camera, BaseWorld world, int currentWorldEpoch, float timeSlice)
	{
		if (!m_RFO_Acquired || !m_RFO_Restoring || !m_RFO_RestoreTargetSelected || m_RFO_RestorationPostFrameConfirmed)
			return false;
		if (camera != m_RFO_ObserverCamera || !camera || !camera.IsArmed() || camera.IsDeleted())
		{
			SetCameraFailureReason("restore_postframe_observer_unavailable");
			return false;
		}
		if (world != m_RFO_World || currentWorldEpoch != m_RFO_WorldEpoch || !m_RFO_OriginalCamera || m_RFO_OriginalCamera.IsDeleted())
		{
			SetCameraFailureReason("restore_postframe_world_or_target_changed");
			return false;
		}
		if (m_RFO_UsesDetachedPlayerCamera)
		{
			if (world.GetCurrentCameraId() != m_RFO_WorldCameraId)
			{
				SetCameraFailureReason("restore_postframe_world_camera_changed");
				return false;
			}
		}
		else if (!m_RFO_CameraManager || m_RFO_CameraManager.CurrentCamera() != m_RFO_OriginalCamera)
		{
			SetCameraFailureReason("restore_postframe_manager_owner_changed");
			return false;
		}

		ApplyOriginalState(m_RFO_OriginalCamera);
		m_RFO_OriginalCamera.ApplyTransform(timeSlice);
		if (!OriginalCameraMatches() || !PublishedCameraMatches(m_RFO_OriginalCamera, m_RFO_OriginalMatrix, m_RFO_OriginalFov))
		{
			SetCameraFailureReason("restore_postframe_state_unpublished");
			return false;
		}
		m_RFO_RestorationPostFrameConfirmed = true;
		m_RFO_ObserverCamera.Disarm();
		return true;
	}

	bool IsHeld()
	{
		if (!m_RFO_Acquired)
			return false;
		// During restoration the original camera is intentionally selected and
		// the observer may be disarmed after POSTFRAME proof. That is not an
		// ownership loss; restoration-specific checks record any real failure.
		if (m_RFO_Restoring)
			return false;
		if (!m_RFO_ObserverCamera || m_RFO_ObserverCamera.IsDeleted() || !m_RFO_ObserverCamera.IsArmed())
		{
			SetCameraFailureReason("observer_camera_unavailable");
			return false;
		}
		if (!m_RFO_World || m_RFO_World.GetCurrentCameraId() != m_RFO_WorldCameraId)
		{
			SetCameraFailureReason("world_camera_slot_changed");
			return false;
		}
		if (m_RFO_UsesDetachedPlayerCamera)
			return true;
		if (!m_RFO_CameraManager || m_RFO_CameraManager.CurrentCamera() != m_RFO_ObserverCamera)
		{
			SetCameraFailureReason("camera_manager_owner_changed");
			return false;
		}
		return true;
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
		if (frame - m_RFO_LastPostFrameCommit <= 2)
			return true;
		SetCameraFailureReason("observer_postframe_stalled");
		return false;
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

	protected void Initialize(string jobId, BaseWorld world, int worldEpoch, CameraManager manager, CameraBase original, RFO_ObserverCamera observer, bool detachedPlayerCamera, int cameraId, vector requestedMatrix[4], float fovDegrees)
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
		m_RFO_RestorationPostFrameConfirmed = false;
		m_RFO_UsesDetachedPlayerCamera = detachedPlayerCamera;
		m_RFO_LastCameraFailureReason = string.Empty;
	}

	protected bool ResolveLeaseableCamera(BaseWorld world, out ArmaReforgerScripted game, out CameraManager manager, out CameraBase original, out bool detachedPlayerCamera, out int cameraId)
	{
		game = null;
		manager = null;
		original = null;
		detachedPlayerCamera = false;
		cameraId = -1;
		m_RFO_LastLeaseabilityReason = string.Empty;
		if (m_RFO_Acquired)
		{
			m_RFO_LastLeaseabilityReason = "lease_already_held";
			return false;
		}
		if (!RFO_ObserverCapabilities.CAMERA_RESTORE_PROVEN)
		{
			m_RFO_LastLeaseabilityReason = "restoration_unproven";
			return false;
		}
		if (!world)
		{
			m_RFO_LastLeaseabilityReason = "world_unavailable";
			return false;
		}
		game = GetGame();
		if (!game)
		{
			m_RFO_LastLeaseabilityReason = "game_unavailable";
			return false;
		}
		if (game.GetWorld() != world)
		{
			m_RFO_LastLeaseabilityReason = "world_mismatch";
			return false;
		}

		manager = game.GetCameraManager();
		if (manager)
			original = manager.CurrentCamera();
		if (!original || original.IsDeleted())
		{
			CameraBase playerCamera = FindPlayerCamera();
			if (playerCamera && !playerCamera.IsDeleted())
			{
				original = playerCamera;
				detachedPlayerCamera = true;
			}
		}
		// Exact restoration requires a CameraBase snapshot, including the near
		// plane. Reforger exposes no BaseWorld near-plane getter, so a raw
		// world-slot-only camera cannot be borrowed without inventing state.
		if (!original || original.IsDeleted())
		{
			m_RFO_LastLeaseabilityReason = "camera_unavailable";
			return false;
		}

		cameraId = original.GetCameraIndex();
		if (cameraId < 0)
		{
			m_RFO_LastLeaseabilityReason = "camera_slot_unavailable";
			return false;
		}
		if (world.GetCurrentCameraId() != cameraId)
		{
			m_RFO_LastLeaseabilityReason = "camera_slot_mismatch";
			return false;
		}
		if (!detachedPlayerCamera && (!manager || manager.CurrentCamera() != original || !CameraRegistered(manager, original)))
		{
			m_RFO_LastLeaseabilityReason = "manager_camera_unregistered";
			return false;
		}
		return true;
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
		{
			if (!m_RFO_World || m_RFO_World.GetCurrentCameraId() != m_RFO_WorldCameraId)
			{
				SetCameraFailureReason("restore_detached_world_camera_changed");
				DestroyObserverCamera(m_RFO_ObserverCamera);
				Clear(false);
			}
			return false;
		}
		if (!m_RFO_OriginalCamera || m_RFO_OriginalCamera.IsDeleted())
		{
			SetCameraFailureReason("restore_detached_target_unavailable");
			return false;
		}
		// Do not overwrite a player/Game Master camera that has changed while the
		// observer was active. The requested projection must still be the one
		// currently published by the slot we borrowed.
		if (!WorldCameraMatches(m_RFO_ActualMatrix, m_RFO_ActualFovDegrees))
		{
			SetCameraFailureReason("restore_detached_view_changed");
			DestroyObserverCamera(m_RFO_ObserverCamera);
			Clear(false);
			return false;
		}
		ApplyOriginalState(m_RFO_OriginalCamera);
		m_RFO_RestoreTargetSelected = true;
		return false;
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

	protected bool RestorationCleanupBindingStillCurrent(BaseWorld world, int currentWorldEpoch)
	{
		if (world != m_RFO_World || currentWorldEpoch != m_RFO_WorldEpoch || !m_RFO_OriginalCamera || m_RFO_OriginalCamera.IsDeleted())
			return false;
		if (m_RFO_OriginalCamera.GetCameraIndex() != m_RFO_WorldCameraId || world.GetCurrentCameraId() != m_RFO_WorldCameraId)
			return false;
		// A reselected observer must never be deleted from stale POSTFRAME proof.
		if (m_RFO_CameraManager && m_RFO_CameraManager.CurrentCamera() == m_RFO_ObserverCamera)
			return false;
		if (m_RFO_UsesDetachedPlayerCamera)
		{
			// A detached player camera normally has no manager owner. If one appears
			// during cleanup, accept only the exact snapshot target.
			if (m_RFO_CameraManager && m_RFO_CameraManager.CurrentCamera() && m_RFO_CameraManager.CurrentCamera() != m_RFO_OriginalCamera)
				return false;
			return true;
		}
		return m_RFO_CameraManager && m_RFO_CameraManager.CurrentCamera() == m_RFO_OriginalCamera;
	}

	protected bool RetireOldWorldObserver()
	{
		if (!m_RFO_UsesDetachedPlayerCamera && m_RFO_CameraManager && m_RFO_ObserverCamera && m_RFO_CameraManager.CurrentCamera() == m_RFO_ObserverCamera)
		{
			CameraBase replacement = m_RFO_OriginalCamera;
			if (!replacement || replacement.IsDeleted() || !CameraRegistered(m_RFO_CameraManager, replacement))
				replacement = FindPlayerCamera();
			if (!replacement || replacement.IsDeleted() || !CameraRegistered(m_RFO_CameraManager, replacement))
			{
				SetCameraFailureReason("retire_restore_target_unavailable");
				return false;
			}
			m_RFO_CameraManager.SetCamera(replacement);
			if (m_RFO_CameraManager.CurrentCamera() != replacement)
			{
				SetCameraFailureReason("retire_target_selection_failed");
				return false;
			}
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

	protected void SetCameraFailureReason(string reason)
	{
		if (m_RFO_LastCameraFailureReason.IsEmpty())
			m_RFO_LastCameraFailureReason = reason;
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
		m_RFO_RestorationPostFrameConfirmed = false;
		m_RFO_UsesDetachedPlayerCamera = false;
		RFO_ObserverEditorCameraArbitration.EndManagerLease();
		m_RFO_WorldCameraId = 0;
		m_RFO_LastPostFrameCommit = 0;
		m_RFO_LastLeaseabilityReason = string.Empty;
	}
}
