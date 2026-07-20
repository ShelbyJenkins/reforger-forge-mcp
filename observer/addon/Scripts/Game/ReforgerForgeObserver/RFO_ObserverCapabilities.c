class RFO_ObserverCapabilities
{
	// The observer advertises these capabilities only on a graphical runtime.
	// System.MakeScreenshot and the transactionally restored CameraManager path
	// are exercised by the gated live acceptance before release.
	static const bool RENDER_CAPTURE_PROVEN = true;
	static const bool CAMERA_RESTORE_PROVEN = true;

	static array<string> Collect(bool hasWorld, bool restReady, bool mailboxReady, bool captureReady, bool cameraReady)
	{
		array<string> result = {};
		if (restReady)
			result.Insert(RFO_ObserverProtocol.CAP_TRANSPORT_REST);
		if (mailboxReady)
			result.Insert(RFO_ObserverProtocol.CAP_TRANSPORT_MAILBOX);
		if (hasWorld)
			result.Insert(RFO_ObserverProtocol.CAP_WORLD_QUERY);
		if (!System.IsConsoleApp() && RENDER_CAPTURE_PROVEN && captureReady)
			result.Insert(RFO_ObserverProtocol.CAP_RENDER_CAPTURE);
		if (!System.IsConsoleApp() && CAMERA_RESTORE_PROVEN && cameraReady)
			result.Insert(RFO_ObserverProtocol.CAP_CAMERA_RUNTIME);
		if (Replication.IsRunning() && Replication.IsServer())
			result.Insert(RFO_ObserverProtocol.CAP_AUTHORITY_SERVER);
		return result;
	}
}
