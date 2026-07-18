class RFO_ObserverCameraClass : CameraBaseClass
{
}

// Local, transient camera owned by one observer lease. It is spawned from the
// managed companion add-on, so target projects do not need a prefab or scripts.
class RFO_ObserverCamera : CameraBase
{
	protected bool m_RFO_Armed;

	void RFO_ObserverCamera(IEntitySource src, IEntity parent)
	{
		SetFlags(EntityFlags.ACTIVE, false);
		SetEventMask(EntityEvent.INIT | EntityEvent.POSTFRAME);
	}

	void Arm()
	{
		m_RFO_Armed = true;
	}

	void Disarm()
	{
		m_RFO_Armed = false;
	}

	bool IsArmed()
	{
		return m_RFO_Armed;
	}

	override protected void EOnPostFrame(IEntity owner, float timeSlice)
	{
		if (!m_RFO_Armed || !owner)
			return;
		RFO_ObserverService.GetInstance().OnObserverCameraPostFrame(this, owner.GetWorld(), timeSlice);
	}
}
