class RFO_ObserverCameraProjection
{
	static const float MATRIX_EPSILON = 0.001;
	static const float FOV_SYMMETRY_EPSILON = 0.05;

	static bool SnapshotCurrent(BaseWorld world, out int cameraId, out vector matrix[4], out float fovDegrees)
	{
		cameraId = -1;
		fovDegrees = 0;
		if (!world)
			return false;
		cameraId = world.GetCurrentCameraId();
		if (cameraId < 0)
			return false;
		world.GetCurrentCamera(matrix);
		return MatrixValid(matrix) && MeasureVerticalFov(world, cameraId, fovDegrees);
	}

	static bool MeasureVerticalFov(BaseWorld world, int cameraId, out float fovDegrees)
	{
		fovDegrees = 0;
		if (!world || cameraId < 0)
			return false;
		int width;
		int height;
		System.GetRenderingResolution(width, height);
		if (width < 2 || height < 4)
			return false;
		int centerPixelX = width / 2;
		int centerPixelY = height / 2;
		int samplePixelOffset = height / 4;
		if (samplePixelOffset < 1)
			return false;
		float centerX = centerPixelX;
		float centerY = centerPixelY;
		float sampleOffset = samplePixelOffset;
		float sampleScale = (2.0 * samplePixelOffset) / height;
		vector centerDirection;
		vector topDirection;
		vector bottomDirection;
		world.ProjectViewportToWorld(centerX, centerY, cameraId, width, height, centerDirection);
		world.ProjectViewportToWorld(centerX, centerY - sampleOffset, cameraId, width, height, topDirection);
		world.ProjectViewportToWorld(centerX, centerY + sampleOffset, cameraId, width, height, bottomDirection);
		float centerLength = centerDirection.Length();
		float topLength = topDirection.Length();
		float bottomLength = bottomDirection.Length();
		if (centerLength <= 0.000001 || topLength <= 0.000001 || bottomLength <= 0.000001)
			return false;
		float topCosine = vector.Dot(centerDirection / centerLength, topDirection / topLength);
		float bottomCosine = vector.Dot(centerDirection / centerLength, bottomDirection / bottomLength);
		topCosine = Math.Clamp(topCosine, -1, 1);
		bottomCosine = Math.Clamp(bottomCosine, -1, 1);
		float topSampleRadians = Math.Acos(topCosine);
		float bottomSampleRadians = Math.Acos(bottomCosine);
		if (Math.AbsFloat(topSampleRadians - bottomSampleRadians) * Math.RAD2DEG > FOV_SYMMETRY_EPSILON)
			return false;
		float sampleRadians = (topSampleRadians + bottomSampleRadians) * 0.5;
		fovDegrees = 2 * Math.Atan2(Math.Tan(sampleRadians), sampleScale) * Math.RAD2DEG;
		return fovDegrees == fovDegrees && fovDegrees >= 1 && fovDegrees <= 179;
	}

	static bool MatrixValid(vector matrix[4])
	{
		float len0 = matrix[0].Length();
		float len1 = matrix[1].Length();
		float len2 = matrix[2].Length();
		if (len0 != len0 || len1 != len1 || len2 != len2)
			return false;
		if (Math.AbsFloat(len0 - 1) > MATRIX_EPSILON || Math.AbsFloat(len1 - 1) > MATRIX_EPSILON || Math.AbsFloat(len2 - 1) > MATRIX_EPSILON)
			return false;
		if (Math.AbsFloat(vector.Dot(matrix[0], matrix[1])) > MATRIX_EPSILON || Math.AbsFloat(vector.Dot(matrix[0], matrix[2])) > MATRIX_EPSILON || Math.AbsFloat(vector.Dot(matrix[1], matrix[2])) > MATRIX_EPSILON)
			return false;
		float positionLength = matrix[3].Length();
		return positionLength == positionLength && positionLength <= 1000000;
	}
}
