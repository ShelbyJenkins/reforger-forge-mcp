[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)]
	[ValidateSet('HoldMutex', 'InspectCurrent', 'InspectProcess', 'ListWorkbench', 'VerifyTerminate', 'ReplaceState', 'ArchiveState')]
	[string]$Mode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-LifecycleProtocol
{
	param([Parameter(Mandatory = $true)][object]$Value)
	$json = $Value | ConvertTo-Json -Compress -Depth 20
	[Console]::Out.WriteLine($json)
	[Console]::Out.Flush()
}

function Read-LifecycleRequest
{
	$line = [Console]::In.ReadLine()
	if ($null -eq $line -or [string]::IsNullOrWhiteSpace($line))
	{
		throw 'Lifecycle helper received no JSON request.'
	}
	return $line | ConvertFrom-Json
}

function Get-LifecycleProperty
{
	param(
		[Parameter(Mandatory = $true)][object]$Object,
		[Parameter(Mandatory = $true)][string]$Name,
		[object]$Default = $null
	)
	$property = $Object.PSObject.Properties[$Name]
	if ($null -eq $property)
	{
		return $Default
	}
	return $property.Value
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public sealed class LifecycleProcessException : Exception
{
    public string Reason { get; private set; }

    public LifecycleProcessException(string reason, string message) : base(message)
    {
        Reason = reason;
    }
}

public sealed class LifecycleProcessHandle : IDisposable
{
    private const uint PROCESS_TERMINATE = 0x0001;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint WAIT_TIMEOUT = 0x00000102;
    private const int PROCESS_COMMAND_LINE_INFORMATION = 60;

    [StructLayout(LayoutKind.Sequential)]
    private struct UNICODE_STRING
    {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder path, ref int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(
        IntPtr process,
        out long creationTime,
        out long exitTime,
        out long kernelTime,
        out long userTime);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr process,
        int processInformationClass,
        IntPtr processInformation,
        int processInformationLength,
        out int returnLength);

    [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CommandLineToArgvW(string commandLine, out int argc);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    private IntPtr handle;
    public int ProcessId { get; private set; }

    private LifecycleProcessHandle(int processId, IntPtr openedHandle)
    {
        ProcessId = processId;
        handle = openedHandle;
    }

    public static LifecycleProcessHandle Open(int processId, bool forTermination)
    {
        if (processId <= 0)
            throw new LifecycleProcessException("pid_not_found", "Process ID is invalid.");

        uint access = PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE;
        if (forTermination) access |= PROCESS_TERMINATE;
        IntPtr opened = OpenProcess(access, false, processId);
        if (opened == IntPtr.Zero)
        {
            int error = Marshal.GetLastWin32Error();
            if (error == 5)
                throw new LifecycleProcessException("access_denied", "Windows denied access to the process handle.");
            if (error == 87)
                throw new LifecycleProcessException("pid_not_found", "The process does not exist.");
            throw new LifecycleProcessException("helper_failure", "OpenProcess failed with Windows error " + error.ToString(CultureInfo.InvariantCulture) + ".");
        }
        return new LifecycleProcessHandle(processId, opened);
    }

    private void EnsureOpen()
    {
        if (handle == IntPtr.Zero)
            throw new ObjectDisposedException("LifecycleProcessHandle");
    }

    public string GetExecutablePath()
    {
        EnsureOpen();
        int capacity = 32768;
        StringBuilder path = new StringBuilder(capacity);
        if (!QueryFullProcessImageName(handle, 0, path, ref capacity))
        {
            int error = Marshal.GetLastWin32Error();
            string reason = error == 5 ? "access_denied" : "helper_failure";
            throw new LifecycleProcessException(reason, "QueryFullProcessImageName failed with Windows error " + error.ToString(CultureInfo.InvariantCulture) + ".");
        }
        if (path.Length == 0)
            throw new LifecycleProcessException("helper_failure", "Windows returned an empty executable path.");
        return path.ToString();
    }

    public string GetCreationTime()
    {
        EnsureOpen();
        long creation;
        long exit;
        long kernel;
        long user;
        if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user))
        {
            int error = Marshal.GetLastWin32Error();
            string reason = error == 5 ? "access_denied" : "helper_failure";
            throw new LifecycleProcessException(reason, "GetProcessTimes failed with Windows error " + error.ToString(CultureInfo.InvariantCulture) + ".");
        }
        if (creation <= 0)
            throw new LifecycleProcessException("helper_failure", "Windows returned an invalid process creation time.");
        return creation.ToString(CultureInfo.InvariantCulture);
    }

    private string GetCommandLine()
    {
        EnsureOpen();
        int required;
        int initialStatus = NtQueryInformationProcess(handle, PROCESS_COMMAND_LINE_INFORMATION, IntPtr.Zero, 0, out required);
        if (required <= 0)
            throw new LifecycleProcessException("command_line_unverifiable", "Windows did not provide a command-line buffer size (NTSTATUS 0x" + initialStatus.ToString("X8", CultureInfo.InvariantCulture) + ").");

        IntPtr buffer = Marshal.AllocHGlobal(required);
        try
        {
            int returned;
            int status = NtQueryInformationProcess(handle, PROCESS_COMMAND_LINE_INFORMATION, buffer, required, out returned);
            if (status != 0)
                throw new LifecycleProcessException("command_line_unverifiable", "Windows denied exact command-line inspection (NTSTATUS 0x" + status.ToString("X8", CultureInfo.InvariantCulture) + ").");
            UNICODE_STRING value = (UNICODE_STRING)Marshal.PtrToStructure(buffer, typeof(UNICODE_STRING));
            if (value.Buffer == IntPtr.Zero || value.Length == 0)
                throw new LifecycleProcessException("command_line_unverifiable", "Windows returned an empty process command line.");
            string commandLine = Marshal.PtrToStringUni(value.Buffer, value.Length / 2);
            if (String.IsNullOrWhiteSpace(commandLine))
                throw new LifecycleProcessException("command_line_unverifiable", "Windows returned an empty process command line.");
            return commandLine;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public bool HasExactArgument(string expectedArgument)
    {
        if (String.IsNullOrWhiteSpace(expectedArgument))
            throw new LifecycleProcessException("token_mismatch", "The expected owner argument is empty.");
        string commandLine = GetCommandLine();
        int argc;
        IntPtr argv = CommandLineToArgvW(commandLine, out argc);
        if (argv == IntPtr.Zero)
            throw new LifecycleProcessException("command_line_unverifiable", "Windows could not parse the process command line.");
        try
        {
            for (int index = 0; index < argc; index++)
            {
                IntPtr argumentPointer = Marshal.ReadIntPtr(argv, index * IntPtr.Size);
                string argument = Marshal.PtrToStringUni(argumentPointer);
                if (String.Equals(argument, expectedArgument, StringComparison.Ordinal)) return true;
            }
            return false;
        }
        finally
        {
            LocalFree(argv);
        }
    }

    public bool HasExited()
    {
        EnsureOpen();
        uint result = WaitForSingleObject(handle, 0);
        if (result == WAIT_OBJECT_0) return true;
        if (result == WAIT_TIMEOUT) return false;
        int error = Marshal.GetLastWin32Error();
        throw new LifecycleProcessException("helper_failure", "WaitForSingleObject failed with Windows error " + error.ToString(CultureInfo.InvariantCulture) + ".");
    }

    public bool TerminateAndWait(int timeoutMilliseconds)
    {
        EnsureOpen();
        if (HasExited()) return false;
        if (!TerminateProcess(handle, 1))
        {
            int error = Marshal.GetLastWin32Error();
            string reason = error == 5 ? "access_denied" : "helper_failure";
            throw new LifecycleProcessException(reason, "TerminateProcess failed with Windows error " + error.ToString(CultureInfo.InvariantCulture) + ".");
        }
        uint result = WaitForSingleObject(handle, checked((uint)timeoutMilliseconds));
        if (result == WAIT_OBJECT_0) return true;
        if (result == WAIT_TIMEOUT)
            throw new LifecycleProcessException("timeout", "The exact process handle did not signal exit before the timeout.");
        int waitError = Marshal.GetLastWin32Error();
        throw new LifecycleProcessException("helper_failure", "WaitForSingleObject failed with Windows error " + waitError.ToString(CultureInfo.InvariantCulture) + ".");
    }

    public void Dispose()
    {
        if (handle != IntPtr.Zero)
        {
            CloseHandle(handle);
            handle = IntPtr.Zero;
        }
        GC.SuppressFinalize(this);
    }

    ~LifecycleProcessHandle()
    {
        Dispose();
    }
}

public static class LifecycleFile
{
    private const uint MOVEFILE_REPLACE_EXISTING = 0x1;
    private const uint MOVEFILE_WRITE_THROUGH = 0x8;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool MoveFileEx(string existingPath, string newPath, uint flags);

    public static void AtomicReplace(string temporaryPath, string destinationPath)
    {
        if (!MoveFileEx(temporaryPath, destinationPath, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Atomic lifecycle-state replacement failed.");
    }

    public static void AtomicMoveNew(string sourcePath, string destinationPath)
    {
        if (!MoveFileEx(sourcePath, destinationPath, MOVEFILE_WRITE_THROUGH))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Lifecycle-state archival failed.");
    }
}
'@

function ConvertTo-LifecycleIdentity
{
	param([Parameter(Mandatory = $true)][LifecycleProcessHandle]$Handle)
	return [ordered]@{
		pid = $Handle.ProcessId
		executablePath = $Handle.GetExecutablePath()
		creationTime = $Handle.GetCreationTime()
	}
}

function Write-LifecycleProcessRefusal
{
	param([Parameter(Mandatory = $true)][LifecycleProcessException]$Exception)
	Write-LifecycleProtocol ([ordered]@{
		ok = $false
		status = 'refused'
		reason = $Exception.Reason
		message = $Exception.Message
	})
}

function Invoke-HoldMutex
{
	$request = Read-LifecycleRequest
	$mutexName = [string](Get-LifecycleProperty -Object $request -Name 'mutexName' -Default '')
	$timeoutMs = [int](Get-LifecycleProperty -Object $request -Name 'timeoutMs' -Default 0)
	if ([string]::IsNullOrWhiteSpace($mutexName) -or $timeoutMs -le 0)
	{
		throw 'Mutex request is invalid.'
	}

	$security = [Security.AccessControl.MutexSecurity]::new()
	$world = [Security.Principal.SecurityIdentifier]::new(
		[Security.Principal.WellKnownSidType]::WorldSid,
		$null)
	$rights = [Security.AccessControl.MutexRights]::Synchronize -bor [Security.AccessControl.MutexRights]::Modify
	$rule = [Security.AccessControl.MutexAccessRule]::new(
		$world,
		$rights,
		[Security.AccessControl.AccessControlType]::Allow)
	$security.AddAccessRule($rule)

	$createdNew = $false
	$mutex = [Threading.Mutex]::new($false, $mutexName, [ref]$createdNew, $security)
	$owned = $false
	$abandoned = $false
	try
	{
		try
		{
			$owned = $mutex.WaitOne($timeoutMs)
		}
		catch [Threading.AbandonedMutexException]
		{
			$owned = $true
			$abandoned = $true
		}
		if (-not $owned)
		{
			Write-LifecycleProtocol ([ordered]@{ ok = $false; status = 'timeout'; reason = 'mutex_timeout' })
			return
		}

		Write-LifecycleProtocol ([ordered]@{ ok = $true; status = 'acquired'; abandoned = $abandoned })
		# The mutex remains owned by this exact PowerShell thread until Node sends a
		# release line or its private stdin pipe closes.
		$null = [Console]::In.ReadLine()
	}
	finally
	{
		if ($owned)
		{
			$mutex.ReleaseMutex()
		}
		$mutex.Dispose()
	}
}

function Invoke-InspectCurrent
{
	$request = Read-LifecycleRequest
	$processId = [int](Get-LifecycleProperty -Object $request -Name 'pid' -Default 0)
	$handle = $null
	try
	{
		$handle = [LifecycleProcessHandle]::Open($processId, $false)
		$identity = ConvertTo-LifecycleIdentity -Handle $handle
		$identity.userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
		Write-LifecycleProtocol ([ordered]@{ ok = $true; status = 'found'; identity = $identity })
	}
	catch [LifecycleProcessException]
	{
		Write-LifecycleProcessRefusal -Exception $_.Exception
	}
	finally
	{
		if ($null -ne $handle) { $handle.Dispose() }
	}
}

function Invoke-InspectProcess
{
	$request = Read-LifecycleRequest
	$processId = [int](Get-LifecycleProperty -Object $request -Name 'pid' -Default 0)
	$expectedArgument = [string](Get-LifecycleProperty -Object $request -Name 'expectedOwnerTokenArgument' -Default '')
	$handle = $null
	try
	{
		$handle = [LifecycleProcessHandle]::Open($processId, $false)
		$identity = ConvertTo-LifecycleIdentity -Handle $handle
		$argumentMatched = $null
		if (-not [string]::IsNullOrWhiteSpace($expectedArgument))
		{
			$argumentMatched = $handle.HasExactArgument($expectedArgument)
		}
		Write-LifecycleProtocol ([ordered]@{
			ok = $true
			status = 'found'
			identity = $identity
			ownerArgumentMatched = $argumentMatched
		})
	}
	catch [LifecycleProcessException]
	{
		if ($_.Exception.Reason -eq 'pid_not_found')
		{
			Write-LifecycleProtocol ([ordered]@{ ok = $true; status = 'absent' })
		}
		else
		{
			Write-LifecycleProcessRefusal -Exception $_.Exception
		}
	}
	finally
	{
		if ($null -ne $handle) { $handle.Dispose() }
	}
}

function Invoke-ListWorkbench
{
	$null = Read-LifecycleRequest
	$processes = New-Object 'System.Collections.Generic.List[object]'
	$unverifiable = New-Object 'System.Collections.Generic.List[object]'
	foreach ($process in [Diagnostics.Process]::GetProcessesByName('ArmaReforgerWorkbenchSteamDiag'))
	{
		$handle = $null
		try
		{
			$handle = [LifecycleProcessHandle]::Open($process.Id, $false)
			[void]$processes.Add((ConvertTo-LifecycleIdentity -Handle $handle))
		}
		catch [LifecycleProcessException]
		{
			if ($_.Exception.Reason -ne 'pid_not_found')
			{
				[void]$unverifiable.Add([ordered]@{
					pid = $process.Id
					reason = $_.Exception.Reason
					message = $_.Exception.Message
				})
			}
		}
		finally
		{
			if ($null -ne $handle) { $handle.Dispose() }
			$process.Dispose()
		}
	}
	Write-LifecycleProtocol ([ordered]@{
		ok = $true
		status = 'complete'
		processes = @($processes)
		unverifiable = @($unverifiable)
	})
}

function Invoke-VerifyTerminate
{
	$request = Read-LifecycleRequest
	$expected = Get-LifecycleProperty -Object $request -Name 'expected'
	$timeoutMs = [int](Get-LifecycleProperty -Object $request -Name 'timeoutMs' -Default 0)
	$processId = [int](Get-LifecycleProperty -Object $expected -Name 'pid' -Default 0)
	$expectedPath = [string](Get-LifecycleProperty -Object $expected -Name 'executablePath' -Default '')
	$expectedCreation = [string](Get-LifecycleProperty -Object $expected -Name 'creationTime' -Default '')
	$expectedArgument = [string](Get-LifecycleProperty -Object $expected -Name 'ownerTokenArgument' -Default '')
	$handle = $null
	try
	{
		$handle = [LifecycleProcessHandle]::Open($processId, $true)
		$actualPath = $handle.GetExecutablePath()
		$actualCreation = $handle.GetCreationTime()
		if (-not [StringComparer]::OrdinalIgnoreCase.Equals(
			[IO.Path]::GetFullPath($expectedPath),
			[IO.Path]::GetFullPath($actualPath)))
		{
			Write-LifecycleProtocol ([ordered]@{ ok = $false; status = 'refused'; reason = 'executable_mismatch'; message = 'The retained process handle executable path does not match.' })
			return
		}
		if (-not [StringComparer]::Ordinal.Equals($expectedCreation, $actualCreation))
		{
			Write-LifecycleProtocol ([ordered]@{ ok = $false; status = 'refused'; reason = 'creation_time_mismatch'; message = 'The retained process handle creation time does not match.' })
			return
		}
		if (-not $handle.HasExactArgument($expectedArgument))
		{
			Write-LifecycleProtocol ([ordered]@{ ok = $false; status = 'refused'; reason = 'token_mismatch'; message = 'The exact owner argument is absent from the retained process instance.' })
			return
		}
		$terminated = $handle.TerminateAndWait($timeoutMs)
		Write-LifecycleProtocol ([ordered]@{
			ok = $true
			status = $(if ($terminated) { 'terminated' } else { 'already_exited' })
		})
	}
	catch [LifecycleProcessException]
	{
		if ($_.Exception.Reason -eq 'pid_not_found')
		{
			Write-LifecycleProtocol ([ordered]@{ ok = $true; status = 'already_exited' })
		}
		else
		{
			Write-LifecycleProcessRefusal -Exception $_.Exception
		}
	}
	finally
	{
		if ($null -ne $handle) { $handle.Dispose() }
	}
}

function Invoke-ReplaceState
{
	$request = Read-LifecycleRequest
	$statePath = [IO.Path]::GetFullPath([string](Get-LifecycleProperty -Object $request -Name 'statePath' -Default ''))
	$expectedGeneration = Get-LifecycleProperty -Object $request -Name 'expectedGeneration'
	$nextJson = [string](Get-LifecycleProperty -Object $request -Name 'nextJson' -Default '')
	$next = $nextJson.TrimStart([char]0xFEFF) | ConvertFrom-Json
	if ([int](Get-LifecycleProperty -Object $next -Name 'version' -Default 0) -ne 2 -or
		[string]::IsNullOrWhiteSpace([string](Get-LifecycleProperty -Object $next -Name 'generation' -Default '')))
	{
		throw 'Replacement lifecycle state is not a valid version-2 record.'
	}

	$exists = [IO.File]::Exists($statePath)
	if ($null -eq $expectedGeneration)
	{
		if ($exists) { throw 'Lifecycle state generation mismatch: expected no active record.' }
	}
	else
	{
		if (-not $exists) { throw 'Lifecycle state generation mismatch: the active record is missing.' }
		$currentJson = [IO.File]::ReadAllText($statePath, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
		$current = $currentJson | ConvertFrom-Json
		$currentVersion = [int](Get-LifecycleProperty -Object $current -Name 'version' -Default 0)
		$currentGeneration = [string](Get-LifecycleProperty -Object $current -Name 'generation' -Default '')
		if ($currentVersion -ne 2 -or -not [StringComparer]::Ordinal.Equals([string]$expectedGeneration, $currentGeneration))
		{
			throw 'Lifecycle state generation mismatch; no state was replaced.'
		}
	}

	$directory = [IO.Path]::GetDirectoryName($statePath)
	[IO.Directory]::CreateDirectory($directory) | Out-Null
	$tempPath = Join-Path $directory ('.lifecycle-' + [Guid]::NewGuid().ToString('N') + '.tmp')
	$stream = $null
	try
	{
		$bytes = [Text.UTF8Encoding]::new($false).GetBytes($nextJson)
		$stream = [IO.FileStream]::new(
			$tempPath,
			[IO.FileMode]::CreateNew,
			[IO.FileAccess]::Write,
			[IO.FileShare]::None,
			4096,
			[IO.FileOptions]::WriteThrough)
		$stream.Write($bytes, 0, $bytes.Length)
		$stream.Flush($true)
		$stream.Dispose()
		$stream = $null
		[LifecycleFile]::AtomicReplace($tempPath, $statePath)
	}
	finally
	{
		if ($null -ne $stream) { $stream.Dispose() }
		if ([IO.File]::Exists($tempPath)) { [IO.File]::Delete($tempPath) }
	}
	Write-LifecycleProtocol ([ordered]@{ ok = $true; status = 'replaced' })
}

function Invoke-ArchiveState
{
	$request = Read-LifecycleRequest
	$statePath = [IO.Path]::GetFullPath([string](Get-LifecycleProperty -Object $request -Name 'statePath' -Default ''))
	$archivePath = [IO.Path]::GetFullPath([string](Get-LifecycleProperty -Object $request -Name 'archivePath' -Default ''))
	$expectedHash = [string](Get-LifecycleProperty -Object $request -Name 'expectedSha256' -Default '')
	if (-not [IO.File]::Exists($statePath)) { throw 'Lifecycle state archival failed because the active record is missing.' }
	$bytes = [IO.File]::ReadAllBytes($statePath)
	$sha = [Security.Cryptography.SHA256]::Create()
	try
	{
		$actualHash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
	}
	finally
	{
		$sha.Dispose()
	}
	if (-not [StringComparer]::OrdinalIgnoreCase.Equals($expectedHash, $actualHash))
	{
		throw 'Lifecycle state archival hash mismatch; no state was moved.'
	}
	[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($archivePath)) | Out-Null
	[LifecycleFile]::AtomicMoveNew($statePath, $archivePath)
	Write-LifecycleProtocol ([ordered]@{ ok = $true; status = 'archived' })
}

try
{
	switch ($Mode)
	{
		'HoldMutex' { Invoke-HoldMutex }
		'InspectCurrent' { Invoke-InspectCurrent }
		'InspectProcess' { Invoke-InspectProcess }
		'ListWorkbench' { Invoke-ListWorkbench }
		'VerifyTerminate' { Invoke-VerifyTerminate }
		'ReplaceState' { Invoke-ReplaceState }
		'ArchiveState' { Invoke-ArchiveState }
	}
}
catch
{
	Write-LifecycleProtocol ([ordered]@{
		ok = $false
		status = 'error'
		reason = 'helper_failure'
		message = $_.Exception.Message
	})
	exit 1
}
