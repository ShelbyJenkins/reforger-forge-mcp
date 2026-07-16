class RFO_ObserverWorld
{
	protected BaseWorld m_RFO_WorldObject;
	protected string m_RFO_WorldResource;
	protected string m_RFO_WorldId;
	protected int m_RFO_WorldEpoch;

	bool Refresh(BaseWorld world)
	{
		string resource;
		if (world && GetGame())
			resource = GetGame().GetWorldFile();
		bool changed = m_RFO_WorldObject != world || m_RFO_WorldResource != resource;
		if (!changed)
			return false;

		m_RFO_WorldObject = world;
		m_RFO_WorldResource = resource;
		if (resource.Length() <= 512)
			m_RFO_WorldId = resource;
		else
			m_RFO_WorldId = string.Empty;
		m_RFO_WorldEpoch++;
		return true;
	}

	bool Available()
	{
		return m_RFO_WorldObject != null && !m_RFO_WorldId.IsEmpty();
	}

	bool Matches(BaseWorld world, int epoch)
	{
		return m_RFO_WorldObject == world && m_RFO_WorldEpoch == epoch;
	}

	BaseWorld GetObject()
	{
		return m_RFO_WorldObject;
	}

	string GetId()
	{
		return m_RFO_WorldId;
	}

	int GetEpoch()
	{
		return m_RFO_WorldEpoch;
	}

}
