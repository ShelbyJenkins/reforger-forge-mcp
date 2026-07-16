class RFO_ObserverCameraLease
{
	protected string m_RFO_JobId;
	protected string m_RFO_LeaseId;
	protected BaseWorld m_RFO_World;
	protected int m_RFO_WorldEpoch;
	protected CameraManager m_RFO_CameraManager;
	protected CameraBase m_RFO_OriginalCamera;
	protected CameraBase m_RFO_ObserverCamera;
	protected vector m_RFO_OriginalMatrix[4];
	protected float m_RFO_OriginalFov;
	protected float m_RFO_OriginalNearPlane;
	protected float m_RFO_OriginalFarPlane;
	protected vector m_RFO_ActualMatrix[4];
	protected float m_RFO_ActualFovDegrees;
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
		if (!manager)
			return false;
		CameraBase original = manager.CurrentCamera();
		if (!original || original.IsDeleted())
			return false;

		original.GetWorldCameraTransform(m_RFO_OriginalMatrix);
		m_RFO_OriginalFov = original.GetVerticalFOV();
		m_RFO_OriginalNearPlane = original.GetNearPlane();
		m_RFO_OriginalFarPlane = original.GetFarPlane();

		// Lease the camera that is already active instead of competing with the
		// game's camera owner by installing a second entity. Retain the complete
		// snapshot before the first mutation so every exit path can restore it.
		m_RFO_JobId = jobId;
		m_RFO_LeaseId = "lease-" + jobId;
		m_RFO_World = world;
		m_RFO_WorldEpoch = worldEpoch;
		m_RFO_CameraManager = manager;
		m_RFO_OriginalCamera = original;
		m_RFO_ObserverCamera = original;
		m_RFO_Acquired = true;
		m_RFO_Restoring = false;
		m_RFO_RestorationConfirmed = false;
		m_RFO_RestoreTargetSelected = false;


		original.SetWorldTransform(requestedMatrix);
		original.SetVerticalFOV(fovDegrees);
		original.SetNearPlane(m_RFO_OriginalNearPlane);
		original.SetFarPlane(m_RFO_OriginalFarPlane);
		if (manager.CurrentCamera() != original)
			return false;
		original.GetWorldCameraTransform(m_RFO_ActualMatrix);
		m_RFO_ActualFovDegrees = original.GetVerticalFOV();
		return MatrixEquals(m_RFO_ActualMatrix, requestedMatrix)
			&& Math.AbsFloat(m_RFO_ActualFovDegrees - fovDegrees) <= 0.0001;
	}

	bool Restore(string jobId, BaseWorld world, int currentWorldEpoch)
	{
		if (!m_RFO_Acquired)
			return m_RFO_RestorationConfirmed;
		if (jobId != m_RFO_JobId)
			return false;
		m_RFO_Restoring = true;

		if (world != m_RFO_World || currentWorldEpoch != m_RFO_WorldEpoch)
			return RetireOldWorldObserver();
		if (!m_RFO_CameraManager)
			return false;

		CameraBase current = m_RFO_CameraManager.CurrentCamera();
		if (!m_RFO_ObserverCamera || m_RFO_ObserverCamera.IsDeleted())
		{
			// A non-null, live current camera proves that the observer is no longer
			// active. With no such proof, preserve the transaction for retry.
			if (current && !current.IsDeleted() && current != m_RFO_ObserverCamera)
				Clear(false);
			return false;
		}
		if (!current)
			return false;
		if (m_RFO_RestoreTargetSelected && current == m_RFO_OriginalCamera)
			return FinishOriginalRestoration();
		if (current != m_RFO_ObserverCamera)
		{
			// Another camera owner won after this lease. Never overwrite it.
			Clear(false);
			return false;
		}
		if (!m_RFO_OriginalCamera || m_RFO_OriginalCamera.IsDeleted())
		{
			CameraBase replacement = FindPlayerCamera();
			if (!replacement || replacement == m_RFO_ObserverCamera || replacement.IsDeleted())
				return false;
			m_RFO_CameraManager.SetCamera(replacement);
			if (m_RFO_CameraManager.CurrentCamera() != replacement)
				return false;
			Clear(false);
			return false;
		}

		m_RFO_OriginalCamera.SetWorldTransform(m_RFO_OriginalMatrix);
		m_RFO_OriginalCamera.SetVerticalFOV(m_RFO_OriginalFov);
		m_RFO_OriginalCamera.SetNearPlane(m_RFO_OriginalNearPlane);
		m_RFO_OriginalCamera.SetFarPlane(m_RFO_OriginalFarPlane);
		m_RFO_CameraManager.SetCamera(m_RFO_OriginalCamera);
		if (m_RFO_CameraManager.CurrentCamera() != m_RFO_OriginalCamera)
			return false;
		m_RFO_RestoreTargetSelected = true;
		return FinishOriginalRestoration();
	}

	bool IsHeld()
	{
		return m_RFO_Acquired && m_RFO_CameraManager && m_RFO_ObserverCamera && !m_RFO_ObserverCamera.IsDeleted() && m_RFO_CameraManager.CurrentCamera() == m_RFO_ObserverCamera;
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
		if (!IsOwnedBy(jobId))
			return false;
		m_RFO_ObserverCamera.SetWorldTransform(m_RFO_ActualMatrix);
		m_RFO_ObserverCamera.SetVerticalFOV(m_RFO_ActualFovDegrees);
		m_RFO_ObserverCamera.SetNearPlane(m_RFO_OriginalNearPlane);
		m_RFO_ObserverCamera.SetFarPlane(m_RFO_OriginalFarPlane);
		if (m_RFO_CameraManager.CurrentCamera() != m_RFO_ObserverCamera)
			return false;
		vector maintainedMatrix[4];
		m_RFO_ObserverCamera.GetWorldCameraTransform(maintainedMatrix);
		return MatrixEquals(maintainedMatrix, m_RFO_ActualMatrix)
			&& Math.AbsFloat(m_RFO_ObserverCamera.GetVerticalFOV() - m_RFO_ActualFovDegrees) <= 0.0001;
	}

	string GetLeaseId()
	{
		return m_RFO_LeaseId;
	}

	int GetObserverCameraId()
	{
		if (!m_RFO_ObserverCamera)
			return 0;
		int cameraIndex = m_RFO_ObserverCamera.GetCameraIndex();
		if (cameraIndex < 0)
			return 0;
		return cameraIndex;
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

	protected bool FinishOriginalRestoration()
	{
		if (!m_RFO_CameraManager || !m_RFO_OriginalCamera || m_RFO_OriginalCamera.IsDeleted() || m_RFO_CameraManager.CurrentCamera() != m_RFO_OriginalCamera)
			return false;
		// Reapply on every retry. Some camera implementations commit their
		// projection state on the following update rather than synchronously.
		m_RFO_OriginalCamera.SetWorldTransform(m_RFO_OriginalMatrix);
		m_RFO_OriginalCamera.SetVerticalFOV(m_RFO_OriginalFov);
		m_RFO_OriginalCamera.SetNearPlane(m_RFO_OriginalNearPlane);
		m_RFO_OriginalCamera.SetFarPlane(m_RFO_OriginalFarPlane);
		vector restoredMatrix[4];
		m_RFO_OriginalCamera.GetWorldCameraTransform(restoredMatrix);
		bool exact = MatrixEquals(restoredMatrix, m_RFO_OriginalMatrix)
			&& Math.AbsFloat(m_RFO_OriginalCamera.GetVerticalFOV() - m_RFO_OriginalFov) <= 0.0001
			&& Math.AbsFloat(m_RFO_OriginalCamera.GetNearPlane() - m_RFO_OriginalNearPlane) <= 0.0001
			&& Math.AbsFloat(m_RFO_OriginalCamera.GetFarPlane() - m_RFO_OriginalFarPlane) <= 0.0001;
		if (!exact)
			return false;
		Clear(true);
		return true;
	}

	protected bool RetireOldWorldObserver()
	{
		// Never copy a snapshot from an old world generation into the new one.
		// The old observer may be retired only after every reachable manager no
		// longer reports it as current.
		ArmaReforgerScripted game = GetGame();
		CameraManager currentManager;
		if (game)
			currentManager = game.GetCameraManager();
		bool observerExists = m_RFO_ObserverCamera != null;
		bool oldManagerOwns = observerExists && m_RFO_CameraManager && m_RFO_CameraManager.CurrentCamera() == m_RFO_ObserverCamera;
		bool currentManagerOwns = observerExists && currentManager && currentManager.CurrentCamera() == m_RFO_ObserverCamera;
		if (oldManagerOwns || currentManagerOwns)
		{
			CameraBase replacement = FindPlayerCamera();
			if (!replacement || replacement == m_RFO_ObserverCamera || replacement.IsDeleted())
				return false;
			if (oldManagerOwns)
			{
				m_RFO_CameraManager.SetCamera(replacement);
				if (m_RFO_CameraManager.CurrentCamera() != replacement)
					return false;
			}
			if (currentManagerOwns && currentManager != m_RFO_CameraManager)
			{
				currentManager.SetCamera(replacement);
				if (currentManager.CurrentCamera() != replacement)
					return false;
			}
		}
		if (observerExists && ((m_RFO_CameraManager && m_RFO_CameraManager.CurrentCamera() == m_RFO_ObserverCamera) || (currentManager && currentManager.CurrentCamera() == m_RFO_ObserverCamera)))
			return false;
		Clear(true);
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
	}
}
