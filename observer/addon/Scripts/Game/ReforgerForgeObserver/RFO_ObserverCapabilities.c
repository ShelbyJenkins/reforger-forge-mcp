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
			result.Insert("transport.rest");
		if (mailboxReady)
			result.Insert("transport.mailbox");
		if (hasWorld)
			result.Insert("world.query");
		if (!System.IsConsoleApp() && RENDER_CAPTURE_PROVEN && captureReady)
			result.Insert("render.capture");
		if (!System.IsConsoleApp() && CAMERA_RESTORE_PROVEN && cameraReady)
			result.Insert("camera.runtime");
		if (Replication.IsRunning() && Replication.IsServer())
			result.Insert("authority.server");
		return result;
	}
}
