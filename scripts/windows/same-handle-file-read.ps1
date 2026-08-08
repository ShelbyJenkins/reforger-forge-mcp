[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)]
	[string]$LiteralPath,

	[Parameter(Mandatory = $true)]
	[long]$MaximumBytes,

	[Parameter(Mandatory = $true)]
	[ValidateSet('true', 'false')]
	[string]$IncludeBytes
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-SameHandleProtocol
{
	param([Parameter(Mandatory = $true)][object]$Value)
	[Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 6))
	[Console]::Out.Flush()
}

Add-Type -TypeDefinition @'
using System;
using System.Globalization;
using System.IO;
using System.Numerics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

public sealed class SameHandleFileBoundaryException : Exception
{
    public string BoundaryCode { get; private set; }

    public SameHandleFileBoundaryException(string code, string message) : base(message)
    {
        BoundaryCode = code;
    }

    public SameHandleFileBoundaryException(string code, string message, Exception inner) : base(message, inner)
    {
        BoundaryCode = code;
    }
}

public sealed class SameHandleFileBoundaryResult
{
    public string FinalPath { get; set; }
    public string Device { get; set; }
    public string Inode { get; set; }
    public string PathDevice { get; set; }
    public string PathInode { get; set; }
    public long ByteLength { get; set; }
    public string ModifiedNanoseconds { get; set; }
    public string ChangedNanoseconds { get; set; }
    public string BirthNanoseconds { get; set; }
    public string Sha256 { get; set; }
    public string BytesBase64 { get; set; }
}

internal sealed class SameHandleSnapshot
{
    public string FinalPath;
    public ulong VolumeSerialNumber;
    public ulong FileIdLow;
    public ulong FileIdHigh;
    public uint PathVolumeSerialNumber;
    public ulong PathFileIndex;
    public long ByteLength;
    public long CreationTime;
    public long LastWriteTime;
    public long ChangeTime;
    public uint Attributes;
    public uint ReparseTag;
}

public static class SameHandleFileBoundary
{
    private const uint GENERIC_READ = 0x80000000;
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint FILE_SHARE_DELETE = 0x00000004;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_FLAG_SEQUENTIAL_SCAN = 0x08000000;
    private const int FILE_BASIC_INFO_CLASS = 0;
    private const int FILE_STANDARD_INFO_CLASS = 1;
    private const int FILE_ATTRIBUTE_TAG_INFO_CLASS = 9;
    private const int FILE_ID_INFO_CLASS = 18;
    private const long WINDOWS_TO_UNIX_EPOCH_TICKS = 116444736000000000L;

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_BASIC_INFO
    {
        public long CreationTime;
        public long LastAccessTime;
        public long LastWriteTime;
        public long ChangeTime;
        public uint FileAttributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_STANDARD_INFO
    {
        public long AllocationSize;
        public long EndOfFile;
        public uint NumberOfLinks;
        [MarshalAs(UnmanagedType.Bool)] public bool DeletePending;
        [MarshalAs(UnmanagedType.Bool)] public bool Directory;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_ATTRIBUTE_TAG_INFO
    {
        public uint FileAttributes;
        public uint ReparseTag;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_ID_128
    {
        public ulong LowPart;
        public ulong HighPart;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_ID_INFO
    {
        public ulong VolumeSerialNumber;
        public FILE_ID_128 FileId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle file,
        int informationClass,
        out FILE_BASIC_INFO information,
        uint bufferSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle file,
        out BY_HANDLE_FILE_INFORMATION information);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle file,
        int informationClass,
        out FILE_STANDARD_INFO information,
        uint bufferSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle file,
        int informationClass,
        out FILE_ATTRIBUTE_TAG_INFO information,
        uint bufferSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle file,
        int informationClass,
        out FILE_ID_INFO information,
        uint bufferSize);

    [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleLength(
        SafeFileHandle file,
        IntPtr path,
        uint pathLength,
        uint flags);

    [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleValue(
        SafeFileHandle file,
        StringBuilder path,
        uint pathLength,
        uint flags);

    private static SameHandleFileBoundaryException NativeFailure(string code, string operation)
    {
        int nativeError = Marshal.GetLastWin32Error();
        return new SameHandleFileBoundaryException(
            code,
            operation + " failed with Windows error " + nativeError.ToString(CultureInfo.InvariantCulture) + ".");
    }

    private static SafeFileHandle Open(string path)
    {
        SafeFileHandle handle = CreateFileW(
            path,
            GENERIC_READ | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            IntPtr.Zero,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN,
            IntPtr.Zero);
        if (handle == null || handle.IsInvalid)
        {
            if (handle != null) handle.Dispose();
            throw NativeFailure("OPEN_FAILED", "CreateFileW");
        }
        return handle;
    }

    private static string NormalizeFinalPath(string value)
    {
        if (value.StartsWith(@"\\?\UNC\", StringComparison.Ordinal))
            value = @"\\" + value.Substring(8);
        else if (value.StartsWith(@"\\?\", StringComparison.Ordinal))
            value = value.Substring(4);
        return Path.GetFullPath(value);
    }

    private static string ReadFinalPath(SafeFileHandle handle)
    {
        uint required = GetFinalPathNameByHandleLength(handle, IntPtr.Zero, 0, 0);
        if (required == 0) throw NativeFailure("FINAL_PATH_UNAVAILABLE", "GetFinalPathNameByHandleW");
        if (required > 32768)
            throw new SameHandleFileBoundaryException("FINAL_PATH_UNAVAILABLE", "The final handle path exceeds the Windows path bound.");
        StringBuilder value = new StringBuilder(checked((int)required + 1));
        uint written = GetFinalPathNameByHandleValue(handle, value, (uint)value.Capacity, 0);
        if (written == 0 || written >= value.Capacity)
            throw NativeFailure("FINAL_PATH_UNAVAILABLE", "GetFinalPathNameByHandleW");
        return NormalizeFinalPath(value.ToString());
    }

    private static T ReadInformation<T>(SafeFileHandle handle, int informationClass, InformationReader<T> reader, string name) where T : struct
    {
        T value;
        uint size = checked((uint)Marshal.SizeOf(typeof(T)));
        if (!reader(handle, informationClass, out value, size))
            throw NativeFailure("IDENTITY_UNAVAILABLE", name);
        return value;
    }

    private delegate bool InformationReader<T>(SafeFileHandle handle, int informationClass, out T information, uint size) where T : struct;

    private static SameHandleSnapshot Capture(SafeFileHandle handle)
    {
        FILE_BASIC_INFO basic = ReadInformation<FILE_BASIC_INFO>(handle, FILE_BASIC_INFO_CLASS, GetFileInformationByHandleEx, "FileBasicInfo");
        FILE_STANDARD_INFO standard = ReadInformation<FILE_STANDARD_INFO>(handle, FILE_STANDARD_INFO_CLASS, GetFileInformationByHandleEx, "FileStandardInfo");
        FILE_ATTRIBUTE_TAG_INFO tag = ReadInformation<FILE_ATTRIBUTE_TAG_INFO>(handle, FILE_ATTRIBUTE_TAG_INFO_CLASS, GetFileInformationByHandleEx, "FileAttributeTagInfo");
        FILE_ID_INFO identity = ReadInformation<FILE_ID_INFO>(handle, FILE_ID_INFO_CLASS, GetFileInformationByHandleEx, "FileIdInfo");
        BY_HANDLE_FILE_INFORMATION pathIdentity;
        if (!GetFileInformationByHandle(handle, out pathIdentity))
            throw NativeFailure("IDENTITY_UNAVAILABLE", "GetFileInformationByHandle");

        uint attributes = basic.FileAttributes | tag.FileAttributes;
        if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || tag.ReparseTag != 0)
            throw new SameHandleFileBoundaryException("REPARSE_POINT", "The opened object is a reparse point.");
        if (standard.Directory || (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0)
            throw new SameHandleFileBoundaryException("NOT_REGULAR_FILE", "The opened object is not a regular file.");
        if (standard.EndOfFile < 0)
            throw new SameHandleFileBoundaryException("CHANGED", "The opened file reported an invalid size.");
        if (identity.VolumeSerialNumber == 0 || (identity.FileId.LowPart == 0 && identity.FileId.HighPart == 0))
            throw new SameHandleFileBoundaryException("IDENTITY_UNAVAILABLE", "Windows returned a zero volume or file identifier.");
        ulong pathFileIndex = ((ulong)pathIdentity.FileIndexHigh << 32) | pathIdentity.FileIndexLow;
        if (pathIdentity.VolumeSerialNumber == 0 || pathFileIndex == 0)
            throw new SameHandleFileBoundaryException("IDENTITY_UNAVAILABLE", "Windows returned a zero path-comparison identifier.");

        return new SameHandleSnapshot {
            FinalPath = ReadFinalPath(handle),
            VolumeSerialNumber = identity.VolumeSerialNumber,
            FileIdLow = identity.FileId.LowPart,
            FileIdHigh = identity.FileId.HighPart,
            PathVolumeSerialNumber = pathIdentity.VolumeSerialNumber,
            PathFileIndex = pathFileIndex,
            ByteLength = standard.EndOfFile,
            CreationTime = basic.CreationTime,
            LastWriteTime = basic.LastWriteTime,
            ChangeTime = basic.ChangeTime,
            Attributes = attributes,
            ReparseTag = tag.ReparseTag
        };
    }

    private static bool SameSnapshot(SameHandleSnapshot left, SameHandleSnapshot right)
    {
        return left.VolumeSerialNumber == right.VolumeSerialNumber &&
            left.FileIdLow == right.FileIdLow && left.FileIdHigh == right.FileIdHigh &&
            left.PathVolumeSerialNumber == right.PathVolumeSerialNumber &&
            left.PathFileIndex == right.PathFileIndex &&
            left.ByteLength == right.ByteLength && left.CreationTime == right.CreationTime &&
            left.LastWriteTime == right.LastWriteTime && left.ChangeTime == right.ChangeTime &&
            left.Attributes == right.Attributes && left.ReparseTag == right.ReparseTag &&
            String.Equals(left.FinalPath, right.FinalPath, StringComparison.Ordinal);
    }

    private static string Unsigned128Decimal(ulong low, ulong high)
    {
        byte[] bytes = new byte[17];
        Array.Copy(BitConverter.GetBytes(low), 0, bytes, 0, 8);
        Array.Copy(BitConverter.GetBytes(high), 0, bytes, 8, 8);
        return new BigInteger(bytes).ToString(CultureInfo.InvariantCulture);
    }

    private static string UnixNanoseconds(long windowsTicks)
    {
        BigInteger ticks = new BigInteger(windowsTicks) - new BigInteger(WINDOWS_TO_UNIX_EPOCH_TICKS);
        return (ticks * new BigInteger(100)).ToString(CultureInfo.InvariantCulture);
    }

    private static void RequireExpectedPath(string expected, string actual)
    {
        if (!String.Equals(expected, actual, StringComparison.Ordinal))
            throw new SameHandleFileBoundaryException("PATH_MISMATCH", "The final handle path does not match the requested canonical path.");
    }

    public static SameHandleFileBoundaryResult Read(string literalPath, long maximumBytes, bool includeBytes)
    {
        if (String.IsNullOrWhiteSpace(literalPath) || maximumBytes <= 0 || maximumBytes > 67108864)
            throw new SameHandleFileBoundaryException("INVALID_REQUEST", "The same-handle read request is outside its fixed bounds.");
        string expectedPath;
        try { expectedPath = Path.GetFullPath(literalPath); }
        catch (Exception error) { throw new SameHandleFileBoundaryException("INVALID_REQUEST", "The requested path is invalid.", error); }

        SafeFileHandle handle = Open(expectedPath);
        try
        {
            SameHandleSnapshot before = Capture(handle);
            RequireExpectedPath(expectedPath, before.FinalPath);
            if (before.ByteLength > maximumBytes)
                throw new SameHandleFileBoundaryException("OVERSIZE", "The opened file exceeds the requested byte bound.");

            byte[] retained = includeBytes ? new byte[checked((int)before.ByteLength)] : null;
            string digest;
            using (FileStream stream = new FileStream(handle, FileAccess.Read, 1048576, false))
            using (SHA256 sha256 = SHA256.Create())
            {
                byte[] buffer = new byte[Math.Min(1048576, Math.Max(1, checked((int)Math.Min(before.ByteLength, 1048576L))))];
                long total = 0;
                while (total < before.ByteLength)
                {
                    int requested = checked((int)Math.Min(buffer.Length, before.ByteLength - total));
                    int count = stream.Read(buffer, 0, requested);
                    if (count <= 0)
                        throw new SameHandleFileBoundaryException("CHANGED", "The opened file ended before its proved size.");
                    sha256.TransformBlock(buffer, 0, count, null, 0);
                    if (retained != null) Buffer.BlockCopy(buffer, 0, retained, checked((int)total), count);
                    total += count;
                }
                sha256.TransformFinalBlock(new byte[0], 0, 0);
                digest = BitConverter.ToString(sha256.Hash).Replace("-", "").ToLowerInvariant();

                SameHandleSnapshot after = Capture(handle);
                if (!SameSnapshot(before, after))
                    throw new SameHandleFileBoundaryException("CHANGED", "The open handle changed while it was read.");

                using (SafeFileHandle currentHandle = Open(expectedPath))
                {
                    SameHandleSnapshot current = Capture(currentHandle);
                    RequireExpectedPath(expectedPath, current.FinalPath);
                    if (!SameSnapshot(before, current))
                        throw new SameHandleFileBoundaryException("HANDLE_PATH_MISMATCH", "The requested path no longer names the read handle identity.");
                }
            }

            return new SameHandleFileBoundaryResult {
                FinalPath = before.FinalPath,
                Device = before.VolumeSerialNumber.ToString(CultureInfo.InvariantCulture),
                Inode = Unsigned128Decimal(before.FileIdLow, before.FileIdHigh),
                PathDevice = before.PathVolumeSerialNumber.ToString(CultureInfo.InvariantCulture),
                PathInode = before.PathFileIndex.ToString(CultureInfo.InvariantCulture),
                ByteLength = before.ByteLength,
                ModifiedNanoseconds = UnixNanoseconds(before.LastWriteTime),
                ChangedNanoseconds = UnixNanoseconds(before.ChangeTime),
                BirthNanoseconds = UnixNanoseconds(before.CreationTime),
                Sha256 = digest,
                BytesBase64 = retained == null ? null : Convert.ToBase64String(retained)
            };
        }
        finally
        {
            if (!handle.IsClosed) handle.Dispose();
        }
    }
}
'@ -Language CSharp -ReferencedAssemblies 'System.Numerics.dll' -ErrorAction Stop

try
{
	$result = [SameHandleFileBoundary]::Read($LiteralPath, $MaximumBytes, $IncludeBytes -eq 'true')
	Write-SameHandleProtocol ([ordered]@{
		schemaVersion = 1
		ok = $true
		status = 'verified'
		finalPath = $result.FinalPath
		device = $result.Device
		inode = $result.Inode
		pathDevice = $result.PathDevice
		pathInode = $result.PathInode
		byteLength = $result.ByteLength
		modifiedNanoseconds = $result.ModifiedNanoseconds
		changedNanoseconds = $result.ChangedNanoseconds
		birthNanoseconds = $result.BirthNanoseconds
		sha256 = $result.Sha256
		bytesBase64 = $result.BytesBase64
		handleIdentityStable = $true
		handlePathStable = $true
		pathHandleMatched = $true
		reparseTraversal = $false
	})
	exit 0
}
catch
{
	$exception = $_.Exception
	while ($null -ne $exception.InnerException)
	{
		if ($exception.PSObject.Properties.Name -contains 'BoundaryCode') { break }
		$exception = $exception.InnerException
	}
	$code = if ($exception.PSObject.Properties.Name -contains 'BoundaryCode') {
		[string]$exception.BoundaryCode
	} else {
		'HELPER_FAILURE'
	}
	$message = if ([string]::IsNullOrWhiteSpace($exception.Message)) {
		'Windows same-handle evidence collection failed.'
	} else {
		[string]$exception.Message
	}
	Write-SameHandleProtocol ([ordered]@{
		schemaVersion = 1
		ok = $false
		status = 'refused'
		code = $code
		message = $message
	})
	exit 2
}
