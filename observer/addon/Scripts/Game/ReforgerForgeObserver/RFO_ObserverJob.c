enum RFO_ObserverJobState
{
	QUEUED,
	DISPATCHED,
	ACCEPTED,
	RESOLVING,
	PRELOADING,
	ACQUIRING_CAMERA,
	POSITIONING,
	SETTLING,
	CAPTURING,
	AWAITING_ARTIFACT,
	RESTORING,
	COMPLETED,
	FAILED,
	CANCELLED
}

class RFO_ObserverCommandView : JsonApiStruct
{
	string kind;
	ref array<float> position;
	ref array<float> orientation;
	ref array<float> target;
	float fov;

	void RFO_ObserverCommandView()
	{
		position = new array<float>();
		orientation = new array<float>();
		target = new array<float>();
		RegV("kind");
		RegV("position");
		RegV("orientation");
		RegV("target");
		RegV("fov");
	}
}

// JsonApiStruct binds integer and floating-point JSON tokens strictly. The
// host therefore supplies an equivalent, schema-checked decimal-string view
// for every runtime command. Decode it before any camera validation so values
// such as FOV 65 and the identity quaternion retain their intended types.
class RFO_ObserverCommandWireView : JsonApiStruct
{
	ref array<string> position;
	ref array<string> orientation;
	ref array<string> target;
	string fov;

	void RFO_ObserverCommandWireView()
	{
		position = new array<string>();
		orientation = new array<string>();
		target = new array<string>();
		RegV("position");
		RegV("orientation");
		RegV("target");
		RegV("fov");
	}
}

class RFO_ObserverRuntimeCommand : JsonApiStruct
{
	string protocolVersion;
	string jobId;
	string idempotencyKey;
	string instanceId;
	int worldEpoch;
	string deadlineAt;
	ref RFO_ObserverCommandView view;
	int settleFrames;
	string performancePolicy;
	string commandKind;
	int deliveryAttempt;
	string deliveryToken;
	string deliveryLeaseExpiresAt;
	string cancellationRequestedAt;
	ref RFO_ObserverCommandWireView wireView;

	void RFO_ObserverRuntimeCommand()
	{
		view = new RFO_ObserverCommandView();
		wireView = new RFO_ObserverCommandWireView();
		RegV("protocolVersion");
		RegV("jobId");
		RegV("idempotencyKey");
		RegV("instanceId");
		RegV("worldEpoch");
		RegV("deadlineAt");
		RegV("view");
		RegV("settleFrames");
		RegV("performancePolicy");
		RegV("commandKind");
		RegV("deliveryAttempt");
		RegV("deliveryToken");
		RegV("deliveryLeaseExpiresAt");
		RegV("cancellationRequestedAt");
		RegV("wireView");
	}

	bool IsBoundedEnvelope()
	{
		if (protocolVersion != RFO_ObserverProtocol.RUNTIME_PROTOCOL_VERSION || !RFO_ObserverValidation.Identifier(jobId) || !RFO_ObserverValidation.Identifier(instanceId))
			return false;
		if (idempotencyKey.IsEmpty() || idempotencyKey.Length() > 128)
			return false;
		if (commandKind != "capture" && commandKind != "cancel")
			return false;
		if (deliveryAttempt <= 0 || !RFO_ObserverValidation.SecretIdentifier(deliveryToken, 16, 256))
			return false;
		if (!RFO_ObserverTime.IsUtcTimestamp(deadlineAt) || !RFO_ObserverTime.IsUtcTimestamp(deliveryLeaseExpiresAt))
			return false;
		if (commandKind == "cancel" && !RFO_ObserverTime.IsUtcTimestamp(cancellationRequestedAt))
			return false;
		return view != null && DecodeWireView();
	}

	protected bool DecodeWireView()
	{
		if (!wireView || !DecodeArray(wireView.position, view.position, 3) || !DecodeArray(wireView.orientation, view.orientation, 4) || !DecodeArray(wireView.target, view.target, 3))
			return false;
		float decodedFov;
		if (!DecodeDecimal(wireView.fov, decodedFov))
			return false;
		view.fov = decodedFov;
		return true;
	}

	protected bool DecodeArray(array<string> encoded, array<float> decoded, int maximumCount)
	{
		if (!encoded || !decoded || encoded.Count() > maximumCount)
			return false;
		decoded.Clear();
		for (int index = 0; index < encoded.Count(); index++)
		{
			float value;
			if (!DecodeDecimal(encoded[index], value))
				return false;
			decoded.Insert(value);
		}
		return true;
	}

	protected bool DecodeDecimal(string encoded, out float value)
	{
		value = 0.0;
		if (encoded.IsEmpty() || encoded.Length() > 32)
			return false;
		int start;
		if (encoded.Substring(0, 1) == "-")
		{
			if (encoded.Length() == 1)
				return false;
			start = 1;
		}
		bool decimalSeen;
		int digits;
		for (int index = start; index < encoded.Length(); index++)
		{
			int character = encoded.ToAscii(index);
			if (character >= 48 && character <= 57)
			{
				digits++;
				continue;
			}
			if (character == 46 && !decimalSeen)
			{
				decimalSeen = true;
				continue;
			}
			return false;
		}
		if (digits <= 0 || encoded.EndsWith("."))
			return false;
		value = encoded.ToFloat();
		return value == value && Math.AbsFloat(value) <= 1000000000.0;
	}
}

class RFO_ObserverCommandResponse : JsonApiStruct
{
	ref RFO_ObserverRuntimeCommand command;

	void RFO_ObserverCommandResponse()
	{
		command = new RFO_ObserverRuntimeCommand();
		RegV("command");
	}
}

class RFO_ObserverAcknowledgement : JsonApiStruct
{
	bool accepted;
	string instanceId;
	string jobId;
	string state;
	int sequence;

	void RFO_ObserverAcknowledgement()
	{
		RegV("accepted");
		RegV("instanceId");
		RegV("jobId");
		RegV("state");
		RegV("sequence");
	}
}

class RFO_ObserverJob
{
	string jobId;
	string idempotencyKey;
	string deliveryToken;
	string deadlineAt;
	int worldEpoch;
	string worldId;
	int settleFrames;
	string performancePolicy;
	string viewKind;
	vector position;
	vector target;
	float orientation[4];
	float fov;
	RFO_ObserverJobState state;
	int sequence = -1;
	bool cancellationRequested;
	bool statusPending;
	bool artifactPending;
	bool screenshotIssued;
	bool screenshotStable;
	bool restorationAttempted;
	bool restorationConfirmed;
	bool cameraWasAcquired;
	bool terminalStatusDelivered;
	bool hasActualCameraSnapshot;
	bool terminalLogged;
	bool restorationLogged;
	int settledFrames;
	int lastSettleFrame = -1;
	int screenshotIssuedFrame;
	int screenshotLastLength;
	int screenshotStableFrames;
	int screenshotByteCount;
	string screenshotIssuedAt;
	string screenshotCompletedAt;
	string terminalErrorCode;
	string terminalMessage;
	vector actualCameraMatrix[4];
	float actualFov;

	bool Initialize(RFO_ObserverRuntimeCommand command, RFO_ObserverSession session, RFO_ObserverWorld world)
	{
		if (!command || !command.IsBoundedEnvelope() || command.commandKind != "capture")
			return false;
		if (command.instanceId.IsEmpty() || command.settleFrames < 0 || command.settleFrames > session.limits.maxSettleFrames)
			return false;
		if (RFO_ObserverTime.IsExpired(command.deadlineAt) || command.performancePolicy == "performance")
			return false;
		if (command.performancePolicy != "evidence" && command.performancePolicy != "instrumented")
			return false;
		if (!ValidateView(command.view, session))
			return false;
		if (command.worldEpoch != world.GetEpoch())
			return false;

		jobId = command.jobId;
		idempotencyKey = command.idempotencyKey;
		deliveryToken = command.deliveryToken;
		deadlineAt = command.deadlineAt;
		worldEpoch = command.worldEpoch;
		worldId = world.GetId();
		settleFrames = command.settleFrames;
		performancePolicy = command.performancePolicy;
		viewKind = command.view.kind;
		if (command.view.position.Count() == 3)
			position = Vector(command.view.position[0], command.view.position[1], command.view.position[2]);
		if (command.view.target.Count() == 3)
			target = Vector(command.view.target[0], command.view.target[1], command.view.target[2]);
		if (command.view.orientation.Count() == 4)
		{
			for (int index = 0; index < 4; index++)
				orientation[index] = command.view.orientation[index];
		}
		fov = command.view.fov;
		state = RFO_ObserverJobState.ACCEPTED;
		return true;
	}

	bool DeadlineExpired()
	{
		return RFO_ObserverTime.IsExpired(deadlineAt);
	}

	bool IsCameraView()
	{
		return viewKind == "pose" || viewKind == "lookAt";
	}

	bool IsTerminal()
	{
		return state == RFO_ObserverJobState.COMPLETED || state == RFO_ObserverJobState.FAILED || state == RFO_ObserverJobState.CANCELLED;
	}

	void RequestCancellation(string token)
	{
		cancellationRequested = true;
		if (!token.IsEmpty())
			deliveryToken = token;
	}

	bool MatchesRequest(RFO_ObserverRuntimeCommand command)
	{
		if (!command || !command.view || command.jobId != jobId || command.idempotencyKey != idempotencyKey)
			return false;
		if (command.worldEpoch != worldEpoch || command.deadlineAt != deadlineAt || command.settleFrames != settleFrames || command.performancePolicy != performancePolicy)
			return false;
		if (command.view.kind != viewKind || command.view.fov != fov)
			return false;
		if (viewKind == "current")
			return command.view.position.Count() == 0 && command.view.orientation.Count() == 0 && command.view.target.Count() == 0;
		if (!SameVector3(command.view.position, position))
			return false;
		if (viewKind == "pose")
		{
			if (command.view.target.Count() != 0 || command.view.orientation.Count() != 4)
				return false;
			for (int orientationIndex = 0; orientationIndex < 4; orientationIndex++)
			{
				if (command.view.orientation[orientationIndex] != orientation[orientationIndex])
					return false;
			}
			return true;
		}
		return command.view.orientation.Count() == 0 && SameVector3(command.view.target, target);
	}

	string StateName()
	{
		switch (state)
		{
			case RFO_ObserverJobState.ACCEPTED: return RFO_ObserverProtocol.STATE_ACCEPTED;
			case RFO_ObserverJobState.RESOLVING: return RFO_ObserverProtocol.STATE_RESOLVING;
			case RFO_ObserverJobState.PRELOADING: return RFO_ObserverProtocol.STATE_PRELOADING;
			case RFO_ObserverJobState.ACQUIRING_CAMERA: return RFO_ObserverProtocol.STATE_ACQUIRING_CAMERA;
			case RFO_ObserverJobState.POSITIONING: return RFO_ObserverProtocol.STATE_POSITIONING;
			case RFO_ObserverJobState.SETTLING: return RFO_ObserverProtocol.STATE_SETTLING;
			case RFO_ObserverJobState.CAPTURING: return RFO_ObserverProtocol.STATE_CAPTURING;
			case RFO_ObserverJobState.AWAITING_ARTIFACT: return RFO_ObserverProtocol.STATE_AWAITING_ARTIFACT;
			case RFO_ObserverJobState.RESTORING: return RFO_ObserverProtocol.STATE_RESTORING;
			case RFO_ObserverJobState.COMPLETED: return RFO_ObserverProtocol.STATE_COMPLETED;
			case RFO_ObserverJobState.FAILED: return RFO_ObserverProtocol.STATE_FAILED;
			case RFO_ObserverJobState.CANCELLED: return RFO_ObserverProtocol.STATE_CANCELLED;
		}
		return RFO_ObserverProtocol.STATE_QUEUED;
	}

	protected bool ValidateView(RFO_ObserverCommandView captureView, RFO_ObserverSession session)
	{
		if (captureView.kind == "current")
			return captureView.position.Count() == 0 && captureView.target.Count() == 0 && captureView.orientation.Count() == 0;
		if (captureView.fov < session.limits.minFov || captureView.fov > session.limits.maxFov)
			return false;
		if (captureView.position.Count() != 3 || !RFO_ObserverValidation.Vector3(captureView.position, session.limits.maxCaptureDistance))
			return false;
		if (captureView.kind == "pose")
		{
			if (captureView.orientation.Count() != 4)
				return false;
			float lengthSquared;
			for (int index = 0; index < 4; index++)
			{
				float value = captureView.orientation[index];
				if (value != value || Math.AbsFloat(value) > 1.0)
					return false;
				lengthSquared += value * value;
			}
			return Math.AbsFloat(lengthSquared - 1.0) < 0.02;
		}
		if (captureView.kind != "lookAt" || captureView.target.Count() != 3 || !RFO_ObserverValidation.Vector3(captureView.target, session.limits.maxCaptureDistance))
			return false;
		vector from = Vector(captureView.position[0], captureView.position[1], captureView.position[2]);
		vector to = Vector(captureView.target[0], captureView.target[1], captureView.target[2]);
		float distance = vector.Distance(from, to);
		return distance > 0.0001 && distance <= session.limits.maxCaptureDistance;
	}

	protected bool SameVector3(array<float> values, vector expected)
	{
		return values && values.Count() == 3 && values[0] == expected[0] && values[1] == expected[1] && values[2] == expected[2];
	}
}

class RFO_ObserverValidation
{
	static bool Identifier(string value)
	{
		return SecretIdentifier(value, 1, 96);
	}

	static bool SecretIdentifier(string value, int minimum, int maximum)
	{
		if (value.Length() < minimum || value.Length() > maximum)
			return false;
		for (int index = 0; index < value.Length(); index++)
		{
			int character = value.ToAscii(index);
			bool valid = (character >= 48 && character <= 57) || (character >= 65 && character <= 90) || (character >= 97 && character <= 122) || character == 95 || character == 45;
			if (!valid)
				return false;
		}
		return true;
	}

	static bool Vector3(array<float> values, float maximumDistance)
	{
		if (!values || values.Count() != 3)
			return false;
		vector result = Vector(values[0], values[1], values[2]);
		for (int index = 0; index < 3; index++)
		{
			if (values[index] != values[index] || Math.AbsFloat(values[index]) > maximumDistance)
				return false;
		}
		return vector.Distance(vector.Zero, result) <= maximumDistance;
	}
}
