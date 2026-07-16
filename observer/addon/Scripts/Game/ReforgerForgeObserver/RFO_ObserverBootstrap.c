modded class ArmaReforgerScripted
{
	override void OnAfterInit(BaseWorld world)
	{
		super.OnAfterInit(world);
		RFO_ObserverService.GetInstance().Start(world);
	}

	override bool OnGameStart()
	{
		bool result = super.OnGameStart();
		RFO_ObserverService.GetInstance().Start(GetWorld());
		return result;
	}

	override void OnUpdate(BaseWorld world, float timeslice)
	{
		super.OnUpdate(world, timeslice);
		RFO_ObserverService.GetInstance().Update(world, timeslice);
	}

	override void OnGameEnd()
	{
		RFO_ObserverService.GetInstance().Shutdown(GetWorld());
		super.OnGameEnd();
	}
}
