class RFO_ObserverJson
{
	static string Quote(string value)
	{
		string escaped = value;
		escaped.Replace("\\", "\\\\");
		escaped.Replace("\"", "\\\"");
		escaped.Replace("\r", "\\r");
		escaped.Replace("\n", "\\n");
		escaped.Replace("\t", "\\t");
		return "\"" + escaped + "\"";
	}

	static string NullableString(string value)
	{
		if (value.IsEmpty())
			return "null";
		return Quote(value);
	}

	static string Boolean(bool value)
	{
		if (value)
			return "true";
		return "false";
	}

	static string Vector3(vector value)
	{
		string result = "[" + value[0].ToString();
		result += "," + value[1].ToString();
		result += "," + value[2].ToString();
		return result + "]";
	}

	static string Matrix4(vector matrix[4])
	{
		string result = "[";
		for (int row = 0; row < 4; row++)
		{
			for (int column = 0; column < 4; column++)
			{
				if (row > 0 || column > 0)
					result += ",";
				float value;
				if (column < 3)
					value = matrix[row][column];
				else if (row == 3)
					value = 1.0;
				result += value.ToString();
			}
		}
		return result + "]";
	}
}
