// The GameMaster/Cain editor camera continuously reselects itself through its
// editor component. A runtime observer manager lease cannot coexist with that
// write on the same CameraManager. This interlock is entered only after the
// observer has snapshotted an exact restore target and is released only after
// POSTFRAME restoration proof (or a fail-closed cleanup).
class RFO_ObserverEditorCameraArbitration
{
	protected static bool s_RFO_ManagerLeaseActive;
	protected static CameraManager s_RFO_LeaseManager;
	protected static CameraBase s_RFO_LeaseOriginalCamera;

	// This is deliberately limited to the exact stock editor camera that is
	// about to be borrowed. Other manager-owned cameras retain their ordinary
	// lease behavior and must still fail closed on any ownership loss.
	static bool CanBeginManagerLease(CameraManager manager, CameraBase original)
	{
		if (!manager || !original || manager.CurrentCamera() != original)
			return false;
		CameraBase editorCamera = SCR_CameraEditorComponent.GetCameraInstance();
		return editorCamera && editorCamera == original;
	}

	static void BeginManagerLease(CameraManager manager, CameraBase original)
	{
		if (!CanBeginManagerLease(manager, original))
			return;
		s_RFO_LeaseManager = manager;
		s_RFO_LeaseOriginalCamera = original;
		s_RFO_ManagerLeaseActive = true;
	}

	static void EndManagerLease()
	{
		s_RFO_ManagerLeaseActive = false;
		s_RFO_LeaseManager = null;
		s_RFO_LeaseOriginalCamera = null;
	}

	static bool IsManagerLeaseActive(CameraManager manager, CameraBase camera)
	{
		return s_RFO_ManagerLeaseActive
			&& manager
			&& camera
			&& manager == s_RFO_LeaseManager
			&& camera == s_RFO_LeaseOriginalCamera;
	}
}

// This modded core component is deliberately inert unless the companion
// observer holds an exact lease for this component's own manager and camera.
// It prevents only the two competing camera-selection writes; the rest of
// GameMaster's normal per-frame editor behavior remains untouched.
modded class SCR_CameraEditorComponent
{
	override protected bool TryForceCamera()
	{
		if (RFO_ObserverEditorCameraArbitration.IsManagerLeaseActive(m_CameraManager, m_Camera))
			return m_Camera && m_CameraManager;
		return super.TryForceCamera();
	}

	// CameraManager deactivates the editor camera synchronously when it selects
	// the observer. The stock callback normally reselects the editor camera
	// immediately, so it must share the same exact, time-bounded interlock.
	override protected void OnCameraDectivate()
	{
		if (RFO_ObserverEditorCameraArbitration.IsManagerLeaseActive(m_CameraManager, m_Camera))
			return;
		super.OnCameraDectivate();
	}
}
