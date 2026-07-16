class RFO_ObserverTime
{
	static string UtcNowIso()
	{
		int year;
		int month;
		int day;
		int hour;
		int minute;
		int second;
		System.GetYearMonthDayUTC(year, month, day);
		System.GetHourMinuteSecondUTC(hour, minute, second);
		return string.Format("%1-%2-%3T%4:%5:%6.000Z", Pad(year, 4), Pad(month, 2), Pad(day, 2), Pad(hour, 2), Pad(minute, 2), Pad(second, 2));
	}

	static bool IsExpired(string utcTimestamp)
	{
		if (!IsUtcTimestamp(utcTimestamp))
			return true;

		int year;
		int month;
		int day;
		int hour;
		int minute;
		int second;
		System.GetYearMonthDayUTC(year, month, day);
		System.GetHourMinuteSecondUTC(hour, minute, second);

		int requested[6];
		requested[0] = utcTimestamp.Substring(0, 4).ToInt();
		requested[1] = utcTimestamp.Substring(5, 2).ToInt();
		requested[2] = utcTimestamp.Substring(8, 2).ToInt();
		requested[3] = utcTimestamp.Substring(11, 2).ToInt();
		requested[4] = utcTimestamp.Substring(14, 2).ToInt();
		requested[5] = utcTimestamp.Substring(17, 2).ToInt();
		int current[6];
		current[0] = year;
		current[1] = month;
		current[2] = day;
		current[3] = hour;
		current[4] = minute;
		current[5] = second;
		for (int index = 0; index < 6; index++)
		{
			if (requested[index] < current[index])
				return true;
			if (requested[index] > current[index])
				return false;
		}
		// Without a wall-clock millisecond API, treat the entire matching second
		// as expired. This conservative boundary never claims a post-deadline
		// screenshot completed before a fractional-second deadline.
		return true;
	}

	static bool IsUtcTimestamp(string value)
	{
		if (value.Length() < 20 || value.Length() > 32)
			return false;
		if (value.Substring(4, 1) != "-" || value.Substring(7, 1) != "-" || value.Substring(10, 1) != "T")
			return false;
		if (value.Substring(13, 1) != ":" || value.Substring(16, 1) != ":" || !value.EndsWith("Z"))
			return false;
		return IsDigits(value, 0, 4) && IsDigits(value, 5, 2) && IsDigits(value, 8, 2) && IsDigits(value, 11, 2) && IsDigits(value, 14, 2) && IsDigits(value, 17, 2);
	}

	static string Pad(int value, int width)
	{
		string result = value.ToString();
		while (result.Length() < width)
			result = "0" + result;
		return result;
	}

	protected static bool IsDigits(string value, int start, int length)
	{
		for (int index = start; index < start + length; index++)
		{
			if (!value.IsDigitAt(index))
				return false;
		}
		return true;
	}
}
