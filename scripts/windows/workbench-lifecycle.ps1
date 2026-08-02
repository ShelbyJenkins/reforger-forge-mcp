[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)]
	[ValidateSet('HoldMutex', 'InspectCurrent', 'InspectProcess', 'ListWorkbench', 'MinimizeWindow', 'InspectWindows', 'CloseWindow', 'VerifyEndpointOwner', 'VerifyEndpointVacant', 'VerifyTerminate')]
	[string]$Mode,

	[long]$DeadlineUnixMs = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-LifecycleUnixMilliseconds
{
	return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

function Assert-LifecycleDeadline
{
	if ($DeadlineUnixMs -gt 0 -and (Get-LifecycleUnixMilliseconds) -ge $DeadlineUnixMs)
	{
		throw "Lifecycle helper mode $Mode exceeded its self-enforced deadline."
	}
}

function Write-LifecycleProtocol
{
	param([Parameter(Mandatory = $true)][object]$Value)
	$json = $Value | ConvertTo-Json -Compress -Depth 20
	[Console]::Out.WriteLine($json)
	[Console]::Out.Flush()
}

function Read-LifecycleRequest
{
	Assert-LifecycleDeadline
	$line = [Console]::In.ReadLine()
	if ($null -eq $line -or [string]::IsNullOrWhiteSpace($line))
	{
		throw 'Lifecycle helper received no JSON request.'
	}
	$request = $line | ConvertFrom-Json
	Assert-LifecycleDeadline
	return $request
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
using System.Net;
using System.Net.Sockets;
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
            if (error == 5)
                throw new LifecycleProcessException("access_denied", "Windows denied access to the process image path.");
            if (HasExited())
                throw new LifecycleProcessException("pid_not_found", "The process exited before its executable path could be read.");
            string reason = "helper_failure";
            throw new LifecycleProcessException(reason, "QueryFullProcessImageName failed with Windows error " + error.ToString(CultureInfo.InvariantCulture) + ".");
        }
        if (path.Length == 0 && HasExited())
            throw new LifecycleProcessException("pid_not_found", "The process exited before its executable path could be read.");
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
            if (error == 5)
                throw new LifecycleProcessException("access_denied", "Windows denied access to the process timestamps.");
            if (HasExited())
                throw new LifecycleProcessException("pid_not_found", "The process exited before its creation time could be read.");
            string reason = "helper_failure";
            throw new LifecycleProcessException(reason, "GetProcessTimes failed with Windows error " + error.ToString(CultureInfo.InvariantCulture) + ".");
        }
        if (creation <= 0 && HasExited())
            throw new LifecycleProcessException("pid_not_found", "The process exited before its creation time could be read.");
        if (creation <= 0)
            throw new LifecycleProcessException("helper_failure", "Windows returned an invalid process creation time.");
        return creation.ToString(CultureInfo.InvariantCulture);
    }

    private string GetCommandLine()
    {
        EnsureOpen();
        int required;
        int initialStatus = NtQueryInformationProcess(handle, PROCESS_COMMAND_LINE_INFORMATION, IntPtr.Zero, 0, out required);
        if (required <= 0 && HasExited())
            throw new LifecycleProcessException("pid_not_found", "The process exited before its command line could be read.");
        if (required <= 0)
            throw new LifecycleProcessException("command_line_unverifiable", "Windows did not provide a command-line buffer size (NTSTATUS 0x" + initialStatus.ToString("X8", CultureInfo.InvariantCulture) + ").");

        IntPtr buffer = Marshal.AllocHGlobal(required);
        try
        {
            int returned;
            int status = NtQueryInformationProcess(handle, PROCESS_COMMAND_LINE_INFORMATION, buffer, required, out returned);
            if (status != 0 && HasExited())
                throw new LifecycleProcessException("pid_not_found", "The process exited before its command line could be read.");
            if (status != 0)
                throw new LifecycleProcessException("command_line_unverifiable", "Windows denied exact command-line inspection (NTSTATUS 0x" + status.ToString("X8", CultureInfo.InvariantCulture) + ").");
            UNICODE_STRING value = (UNICODE_STRING)Marshal.PtrToStructure(buffer, typeof(UNICODE_STRING));
            if ((value.Buffer == IntPtr.Zero || value.Length == 0) && HasExited())
                throw new LifecycleProcessException("pid_not_found", "The process exited before its command line could be read.");
            if (value.Buffer == IntPtr.Zero || value.Length == 0)
                throw new LifecycleProcessException("command_line_unverifiable", "Windows returned an empty process command line.");
            string commandLine = Marshal.PtrToStringUni(value.Buffer, value.Length / 2);
            if (String.IsNullOrWhiteSpace(commandLine) && HasExited())
                throw new LifecycleProcessException("pid_not_found", "The process exited before its command line could be read.");
            if (String.IsNullOrWhiteSpace(commandLine))
                throw new LifecycleProcessException("command_line_unverifiable", "Windows returned an empty process command line.");
            return commandLine;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private string[] GetCommandLineArguments()
    {
        string commandLine = GetCommandLine();
        int argc;
        IntPtr argv = CommandLineToArgvW(commandLine, out argc);
        if (argv == IntPtr.Zero)
            throw new LifecycleProcessException("command_line_unverifiable", "Windows could not parse the process command line.");
        try
        {
            string[] arguments = new string[argc];
            for (int index = 0; index < argc; index++)
            {
                IntPtr argumentPointer = Marshal.ReadIntPtr(argv, index * IntPtr.Size);
                arguments[index] = Marshal.PtrToStringUni(argumentPointer) ?? String.Empty;
            }
            return arguments;
        }
        finally
        {
            LocalFree(argv);
        }
    }

    public bool HasExactArgument(string expectedArgument)
    {
        if (String.IsNullOrWhiteSpace(expectedArgument))
            throw new LifecycleProcessException("token_mismatch", "The expected owner argument is empty.");
        foreach (string argument in GetCommandLineArguments())
        {
            if (String.Equals(argument, expectedArgument, StringComparison.Ordinal)) return true;
        }
        return false;
    }

    /// <summary>
    /// Attest an ordered, contiguous argv sequence, rather than merely testing
    /// whether each token occurs somewhere in the command line. This binds a
    /// switch such as -load to its immediately following target path.
    /// </summary>
    public bool HasExactArgumentSequence(string[] expectedArguments)
    {
        if (expectedArguments == null || expectedArguments.Length == 0)
            throw new LifecycleProcessException("token_mismatch", "The expected argument sequence is empty.");
        foreach (string expected in expectedArguments)
        {
            if (String.IsNullOrWhiteSpace(expected))
                throw new LifecycleProcessException("token_mismatch", "The expected argument sequence contains an empty token.");
        }
        string[] actualArguments = GetCommandLineArguments();
        if (expectedArguments.Length > actualArguments.Length) return false;
        for (int start = 0; start <= actualArguments.Length - expectedArguments.Length; start++)
        {
            bool matches = true;
            for (int offset = 0; offset < expectedArguments.Length; offset++)
            {
                if (!String.Equals(actualArguments[start + offset], expectedArguments[offset], StringComparison.Ordinal))
                {
                    matches = false;
                    break;
                }
            }
            if (matches) return true;
        }
        return false;
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

public static class LifecycleTcpTable
{
    private const int AF_INET = 2;
    private const int AF_INET6 = 23;
    private const uint NO_ERROR = 0;
    private const uint ERROR_INSUFFICIENT_BUFFER = 122;

    private enum TCP_TABLE_CLASS
    {
        TCP_TABLE_BASIC_LISTENER,
        TCP_TABLE_BASIC_CONNECTIONS,
        TCP_TABLE_BASIC_ALL,
        TCP_TABLE_OWNER_PID_LISTENER
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MIB_TCPROW_OWNER_PID
    {
        public uint State;
        public uint LocalAddress;
        public uint LocalPort;
        public uint RemoteAddress;
        public uint RemotePort;
        public uint OwningPid;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MIB_TCP6ROW_OWNER_PID
    {
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
        public byte[] LocalAddress;
        public uint LocalScopeId;
        public uint LocalPort;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
        public byte[] RemoteAddress;
        public uint RemoteScopeId;
        public uint RemotePort;
        public uint State;
        public uint OwningPid;
    }

    private sealed class Listener
    {
        public IPAddress Address;
        public int Port;
        public int ProcessId;
    }

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedTcpTable(
        IntPtr table,
        ref int size,
        bool sorted,
        int addressFamily,
        TCP_TABLE_CLASS tableClass,
        uint reserved);

    private static int DecodePort(uint value)
    {
        return checked((int)(((value & 0xFFU) << 8) | ((value >> 8) & 0xFFU)));
    }

    private static List<Listener> ReadListeners(int addressFamily)
    {
        int size = 0;
        uint result = GetExtendedTcpTable(
            IntPtr.Zero,
            ref size,
            true,
            addressFamily,
            TCP_TABLE_CLASS.TCP_TABLE_OWNER_PID_LISTENER,
            0);
        if (result != ERROR_INSUFFICIENT_BUFFER || size <= 0)
            throw new LifecycleProcessException(
                "helper_failure",
                "GetExtendedTcpTable size query failed with Windows error " +
                    result.ToString(CultureInfo.InvariantCulture) + ".");

        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            result = GetExtendedTcpTable(
                buffer,
                ref size,
                true,
                addressFamily,
                TCP_TABLE_CLASS.TCP_TABLE_OWNER_PID_LISTENER,
                0);
            if (result != NO_ERROR)
                throw new LifecycleProcessException(
                    "helper_failure",
                    "GetExtendedTcpTable failed with Windows error " +
                        result.ToString(CultureInfo.InvariantCulture) + ".");

            int count = Marshal.ReadInt32(buffer);
            IntPtr current = IntPtr.Add(buffer, sizeof(uint));
            List<Listener> listeners = new List<Listener>(count);
            if (addressFamily == AF_INET)
            {
                int rowSize = Marshal.SizeOf(typeof(MIB_TCPROW_OWNER_PID));
                for (int index = 0; index < count; index++)
                {
                    MIB_TCPROW_OWNER_PID row = (MIB_TCPROW_OWNER_PID)Marshal.PtrToStructure(
                        current,
                        typeof(MIB_TCPROW_OWNER_PID));
                    listeners.Add(new Listener
                    {
                        Address = new IPAddress(BitConverter.GetBytes(row.LocalAddress)),
                        Port = DecodePort(row.LocalPort),
                        ProcessId = checked((int)row.OwningPid)
                    });
                    current = IntPtr.Add(current, rowSize);
                }
            }
            else
            {
                int rowSize = Marshal.SizeOf(typeof(MIB_TCP6ROW_OWNER_PID));
                for (int index = 0; index < count; index++)
                {
                    MIB_TCP6ROW_OWNER_PID row = (MIB_TCP6ROW_OWNER_PID)Marshal.PtrToStructure(
                        current,
                        typeof(MIB_TCP6ROW_OWNER_PID));
                    listeners.Add(new Listener
                    {
                        Address = new IPAddress(row.LocalAddress, row.LocalScopeId),
                        Port = DecodePort(row.LocalPort),
                        ProcessId = checked((int)row.OwningPid)
                    });
                    current = IntPtr.Add(current, rowSize);
                }
            }
            return listeners;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public static int ResolveLoopbackListenerOwner(string host, int port)
    {
        IPAddress target;
        if (!IPAddress.TryParse(host, out target) || !IPAddress.IsLoopback(target))
            throw new LifecycleProcessException(
                "endpoint_not_loopback",
                "Automated Workbench lifecycle control requires a numeric loopback endpoint.");
        if (port <= 0 || port > 65535)
            throw new LifecycleProcessException("helper_failure", "The lifecycle endpoint port is invalid.");

        int family = target.AddressFamily == AddressFamily.InterNetwork ? AF_INET : AF_INET6;
        IPAddress wildcard = family == AF_INET ? IPAddress.Any : IPAddress.IPv6Any;
        HashSet<int> owners = new HashSet<int>();
        foreach (Listener listener in ReadListeners(family))
        {
            if (listener.Port == port &&
                (listener.Address.Equals(target) || listener.Address.Equals(wildcard)))
            {
                owners.Add(listener.ProcessId);
            }
        }
        // A dual-mode IPv6 wildcard can accept an IPv4 loopback connection and
        // appears only in the AF_INET6 owner table. Include it for an IPv4 target;
        // the successful ping immediately before this check proves reachability.
        if (family == AF_INET)
        {
            foreach (Listener listener in ReadListeners(AF_INET6))
            {
                if (listener.Port == port && listener.Address.Equals(IPAddress.IPv6Any))
                    owners.Add(listener.ProcessId);
            }
        }
        if (owners.Count == 0)
            throw new LifecycleProcessException(
                "listener_not_found",
                "No listening TCP socket was found for the configured loopback endpoint.");
        if (owners.Count != 1)
            throw new LifecycleProcessException(
                "listener_ambiguous",
                "More than one process owns a matching listening TCP socket.");
        foreach (int owner in owners) return owner;
        throw new LifecycleProcessException("helper_failure", "Listener-owner resolution failed.");
    }
}

public static class LifecycleWindowVisibility
{
    private const int SW_SHOWMINNOACTIVE = 7;
    private const uint GW_OWNER = 4;

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    private static IntPtr FindUnseenVisibleTopLevelWindow(
        int processId,
        HashSet<IntPtr> handledWindows)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate (IntPtr hWnd, IntPtr lParam)
        {
            if (handledWindows.Contains(hWnd)) return true;
            uint windowProcessId;
            GetWindowThreadProcessId(hWnd, out windowProcessId);
            if ((int)windowProcessId != processId) return true;
            if (!IsWindowVisible(hWnd)) return true;
            // Only top-level windows (no owner window) are the process's main window.
            if (GetWindow(hWnd, GW_OWNER) != IntPtr.Zero) return true;
            found = hWnd;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    private static bool IsProcessAlive(int processId)
    {
        try
        {
            return !System.Diagnostics.Process.GetProcessById(processId).HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    /// <summary>
    /// Best-effort: polls for newly visible top-level windows for the whole
    /// timeout and minimizes each distinct handle at most once without
    /// activating it (no SetForegroundWindow call). A slow-starting app can
    /// replace an early splash window with its real main window, but restoring
    /// a window the helper already handled will not minimize it again. Exits
    /// early once the process is gone. Never throws.
    /// </summary>
    public static bool TryMinimizeProcessWindow(int processId, int timeoutMilliseconds)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMilliseconds);
        bool handledAtLeastOnce = false;
        HashSet<IntPtr> handledWindows = new HashSet<IntPtr>();
        while (DateTime.UtcNow < deadline)
        {
            if (!IsProcessAlive(processId)) break;
            IntPtr hWnd = FindUnseenVisibleTopLevelWindow(processId, handledWindows);
            if (hWnd != IntPtr.Zero)
            {
                handledWindows.Add(hWnd);
                if (!IsIconic(hWnd))
                {
                    ShowWindow(hWnd, SW_SHOWMINNOACTIVE);
                }
                handledAtLeastOnce = true;
            }
            System.Threading.Thread.Sleep(200);
        }
        return handledAtLeastOnce;
    }
}

public sealed class LifecycleWindowRecord
{
    public string handle { get; set; }
    public string ownerHandle { get; set; }
    public string className { get; set; }
    public string title { get; set; }
    public bool visible { get; set; }
    public bool enabled { get; set; }
    public bool iconic { get; set; }
}

public static class LifecycleWindowInspection
{
    private const uint GW_OWNER = 4;
    private const uint WM_CLOSE = 0x0010;

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowEnabled(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    private static string HandleString(IntPtr handle)
    {
        return handle.ToInt64().ToString(CultureInfo.InvariantCulture);
    }

    private static string WindowClass(IntPtr handle)
    {
        StringBuilder value = new StringBuilder(256);
        GetClassName(handle, value, value.Capacity);
        return value.ToString();
    }

    private static string WindowTitle(IntPtr handle)
    {
        StringBuilder value = new StringBuilder(1024);
        GetWindowText(handle, value, value.Capacity);
        return value.ToString();
    }

    /// <summary>
    /// Some common dialogs are hosted by a helper process rather than the
    /// caller's PID. They are still safely attributable only when walking
    /// GW_OWNER reaches a top-level window owned by the exact target process.
    /// </summary>
    private static bool OwnerChainContainsProcess(IntPtr handle, int processId)
    {
        HashSet<long> seen = new HashSet<long>();
        IntPtr owner = GetWindow(handle, GW_OWNER);
        while (owner != IntPtr.Zero)
        {
            long key = owner.ToInt64();
            if (!seen.Add(key)) return false;
            uint ownerProcessId;
            GetWindowThreadProcessId(owner, out ownerProcessId);
            if ((int)ownerProcessId == processId) return true;
            owner = GetWindow(owner, GW_OWNER);
        }
        return false;
    }

    public static List<LifecycleWindowRecord> ListVisibleProcessWindows(int processId)
    {
        List<LifecycleWindowRecord> result = new List<LifecycleWindowRecord>();
        EnumWindows(delegate (IntPtr hWnd, IntPtr lParam)
        {
            uint windowProcessId;
            GetWindowThreadProcessId(hWnd, out windowProcessId);
            if (!IsWindowVisible(hWnd)) return true;
            if ((int)windowProcessId != processId && !OwnerChainContainsProcess(hWnd, processId)) return true;
            IntPtr owner = GetWindow(hWnd, GW_OWNER);
            result.Add(new LifecycleWindowRecord {
                handle = HandleString(hWnd),
                ownerHandle = HandleString(owner),
                className = WindowClass(hWnd),
                title = WindowTitle(hWnd),
                visible = true,
                enabled = IsWindowEnabled(hWnd),
                iconic = IsIconic(hWnd),
            });
            return true;
        }, IntPtr.Zero);
        return result;
    }

    /// <summary>
    /// Close only a just-inspected exact-Workbench modal. Ordinary dialogs
    /// must be owned children. A narrow Qt compatibility case permits an
    /// unowned top-level dialog only when it is in the exact target process
    /// and the separately attested top-level main window is disabled.
    /// </summary>
    public static bool CloseVisibleModalWindow(
        int processId,
        string expectedHandle,
        string expectedClassName,
        string expectedTitle,
        string expectedOwnerHandle,
        string closeKind,
        string expectedDisabledMainHandle)
    {
        long handleValue;
        long ownerValue;
        if (!Int64.TryParse(expectedHandle, NumberStyles.Integer, CultureInfo.InvariantCulture, out handleValue))
            return false;
        if (!Int64.TryParse(expectedOwnerHandle, NumberStyles.Integer, CultureInfo.InvariantCulture, out ownerValue))
            return false;
        IntPtr handle = new IntPtr(handleValue);
        uint windowProcessId;
        GetWindowThreadProcessId(handle, out windowProcessId);
        if (windowProcessId == 0 || !IsWindowVisible(handle)) return false;
        if (!String.Equals(WindowClass(handle), expectedClassName ?? String.Empty, StringComparison.Ordinal)) return false;
        if (!String.Equals(WindowTitle(handle), expectedTitle ?? String.Empty, StringComparison.Ordinal)) return false;
        if (GetWindow(handle, GW_OWNER).ToInt64() != ownerValue) return false;
        if ((int)windowProcessId != processId && !OwnerChainContainsProcess(handle, processId)) return false;

        if (String.Equals(closeKind, "owned_child", StringComparison.Ordinal))
        {
            if (ownerValue == 0) return false;
        }
        else if (String.Equals(closeKind, "disabled_main_new_top_level", StringComparison.Ordinal))
        {
            // An unowned dialog cannot be tied to another process through an
            // owner chain. Require it to be a direct exact-Workbench window,
            // and prove that the separately snapshotted top-level main window
            // is still disabled immediately before posting WM_CLOSE.
            if (ownerValue != 0 || (int)windowProcessId != processId) return false;
            long mainHandleValue;
            if (!Int64.TryParse(expectedDisabledMainHandle, NumberStyles.Integer, CultureInfo.InvariantCulture, out mainHandleValue))
                return false;
            IntPtr mainHandle = new IntPtr(mainHandleValue);
            if (mainHandle == handle || !IsWindowVisible(mainHandle) || IsWindowEnabled(mainHandle)) return false;
            uint mainProcessId;
            GetWindowThreadProcessId(mainHandle, out mainProcessId);
            if ((int)mainProcessId != processId || GetWindow(mainHandle, GW_OWNER) != IntPtr.Zero) return false;
        }
        else
        {
            return false;
        }
        return PostMessage(handle, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
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

function Resolve-LifecycleProcessException
{
	param([Parameter(Mandatory = $true)][Management.Automation.ErrorRecord]$ErrorRecord)
	$exception = $ErrorRecord.Exception.GetBaseException()
	if ($exception -isnot [LifecycleProcessException])
	{
		throw 'The lifecycle process exception wrapper did not contain the expected native failure.'
	}
	return $exception
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
	if ($DeadlineUnixMs -gt 0)
	{
		$remainingMs = $DeadlineUnixMs - (Get-LifecycleUnixMilliseconds)
		if ($remainingMs -le 0) { Assert-LifecycleDeadline }
		$timeoutMs = [Math]::Min($timeoutMs, [int][Math]::Min($remainingMs, [int]::MaxValue))
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
		Assert-LifecycleDeadline
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
		Assert-LifecycleDeadline
		$identity = ConvertTo-LifecycleIdentity -Handle $handle
		$identity.userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
		Write-LifecycleProtocol ([ordered]@{ ok = $true; status = 'found'; identity = $identity })
	}
	catch [LifecycleProcessException]
	{
		$processException = Resolve-LifecycleProcessException -ErrorRecord $_
		Write-LifecycleProcessRefusal -Exception $processException
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
	$expectedArguments = @(Get-LifecycleProperty -Object $request -Name 'expectedArguments' -Default @())
	$handle = $null
	try
	{
		$handle = [LifecycleProcessHandle]::Open($processId, $false)
		Assert-LifecycleDeadline
		$identity = ConvertTo-LifecycleIdentity -Handle $handle
		$argumentMatched = $null
		if (-not [string]::IsNullOrWhiteSpace($expectedArgument))
		{
			$argumentMatched = $handle.HasExactArgument($expectedArgument)
		}
		$expectedArgumentsMatched = $null
		if ($expectedArguments.Count -gt 0)
		{
			$sequence = New-Object 'System.Collections.Generic.List[string]'
			foreach ($expected in $expectedArguments)
			{
				$value = [string]$expected
				if ([string]::IsNullOrWhiteSpace($value))
				{
					throw [LifecycleProcessException]::new('token_mismatch', 'The expected command-line argument sequence contains an empty token.')
				}
				$sequence.Add($value)
			}
			$expectedArgumentsMatched = $handle.HasExactArgumentSequence($sequence.ToArray())
		}
		Assert-LifecycleDeadline
		Write-LifecycleProtocol ([ordered]@{
			ok = $true
			status = 'found'
			identity = $identity
			ownerArgumentMatched = $argumentMatched
			expectedArgumentsMatched = $expectedArgumentsMatched
		})
	}
	catch [LifecycleProcessException]
	{
		$processException = Resolve-LifecycleProcessException -ErrorRecord $_
		if ($processException.Reason -eq 'pid_not_found')
		{
			Write-LifecycleProtocol ([ordered]@{ ok = $true; status = 'absent' })
		}
		else
		{
			Write-LifecycleProcessRefusal -Exception $processException
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
		Assert-LifecycleDeadline
		$handle = $null
		try
		{
			$handle = [LifecycleProcessHandle]::Open($process.Id, $false)
			[void]$processes.Add((ConvertTo-LifecycleIdentity -Handle $handle))
		}
		catch [LifecycleProcessException]
		{
			$processException = Resolve-LifecycleProcessException -ErrorRecord $_
			if ($processException.Reason -ne 'pid_not_found')
			{
				[void]$unverifiable.Add([ordered]@{
					pid = $process.Id
					reason = $processException.Reason
					message = $processException.Message
				})
			}
		}
		finally
		{
			if ($null -ne $handle) { $handle.Dispose() }
			$process.Dispose()
		}
	}
	Assert-LifecycleDeadline
	Write-LifecycleProtocol ([ordered]@{
		ok = $true
		status = 'complete'
		processes = @($processes | ForEach-Object { $_ })
		unverifiable = @($unverifiable | ForEach-Object { $_ })
	})
}

function Invoke-MinimizeWindow
{
	$request = Read-LifecycleRequest
	$processId = [int](Get-LifecycleProperty -Object $request -Name 'pid' -Default 0)
	try
	{
		if ($processId -le 0)
		{
			throw [LifecycleProcessException]::new('helper_failure', 'The target process ID is invalid.')
		}
		$remainingMs = 120000
		if ($DeadlineUnixMs -gt 0)
		{
			$remainingMs = [Math]::Max(1, [Math]::Min($remainingMs, [int]($DeadlineUnixMs - (Get-LifecycleUnixMilliseconds))))
		}
		$minimized = [LifecycleWindowVisibility]::TryMinimizeProcessWindow($processId, $remainingMs)
		Write-LifecycleProtocol ([ordered]@{
			ok = $true
			status = $(if ($minimized) { 'minimized' } else { 'window_not_found' })
		})
	}
	catch [LifecycleProcessException]
	{
		$processException = Resolve-LifecycleProcessException -ErrorRecord $_
		Write-LifecycleProcessRefusal -Exception $processException
	}
}

function Assert-ExactWindowProcess
{
	param(
		[Parameter(Mandatory = $true)][object]$Expected,
		[Parameter(Mandatory = $true)][LifecycleProcessHandle]$Handle
	)
	$expectedPath = [string](Get-LifecycleProperty -Object $Expected -Name 'executablePath' -Default '')
	$expectedCreation = [string](Get-LifecycleProperty -Object $Expected -Name 'creationTime' -Default '')
	$expectedArgument = [string](Get-LifecycleProperty -Object $Expected -Name 'ownerTokenArgument' -Default '')
	if ([string]::IsNullOrWhiteSpace($expectedPath) -or [string]::IsNullOrWhiteSpace($expectedCreation) -or
		[string]::IsNullOrWhiteSpace($expectedArgument))
	{
		throw [LifecycleProcessException]::new('helper_failure', 'The expected owned Workbench identity is incomplete.')
	}
	if (-not [StringComparer]::OrdinalIgnoreCase.Equals(
		[IO.Path]::GetFullPath($expectedPath), [IO.Path]::GetFullPath($Handle.GetExecutablePath())))
	{
		throw [LifecycleProcessException]::new('executable_mismatch', 'The window target executable does not match the exact owned Workbench.')
	}
	if (-not [StringComparer]::Ordinal.Equals($expectedCreation, $Handle.GetCreationTime()))
	{
		throw [LifecycleProcessException]::new('creation_time_mismatch', 'The window target creation time does not match the exact owned Workbench.')
	}
	if (-not $Handle.HasExactArgument($expectedArgument))
	{
		throw [LifecycleProcessException]::new('token_mismatch', 'The exact owner argument is absent from the window target process.')
	}
}

function Invoke-InspectWindows
{
	$request = Read-LifecycleRequest
	$expected = Get-LifecycleProperty -Object $request -Name 'expected'
	$processId = [int](Get-LifecycleProperty -Object $expected -Name 'pid' -Default 0)
	$handle = $null
	try
	{
		$handle = [LifecycleProcessHandle]::Open($processId, $false)
		Assert-ExactWindowProcess -Expected $expected -Handle $handle
		Assert-LifecycleDeadline
		$windows = [LifecycleWindowInspection]::ListVisibleProcessWindows($processId)
		Write-LifecycleProtocol ([ordered]@{
			ok = $true
			status = 'complete'
			windows = @($windows | ForEach-Object { $_ })
		})
	}
	catch [LifecycleProcessException]
	{
		$processException = Resolve-LifecycleProcessException -ErrorRecord $_
		Write-LifecycleProcessRefusal -Exception $processException
	}
	finally
	{
		if ($null -ne $handle) { $handle.Dispose() }
	}
}

function Invoke-CloseWindow
{
	$request = Read-LifecycleRequest
	$expected = Get-LifecycleProperty -Object $request -Name 'expected'
	$processId = [int](Get-LifecycleProperty -Object $expected -Name 'pid' -Default 0)
	$window = Get-LifecycleProperty -Object $request -Name 'window'
	$handle = $null
	try
	{
		$handle = [LifecycleProcessHandle]::Open($processId, $false)
		Assert-ExactWindowProcess -Expected $expected -Handle $handle
		$closed = [LifecycleWindowInspection]::CloseVisibleModalWindow(
			$processId,
			[string](Get-LifecycleProperty -Object $window -Name 'handle' -Default ''),
			[string](Get-LifecycleProperty -Object $window -Name 'className' -Default ''),
			[string](Get-LifecycleProperty -Object $window -Name 'title' -Default ''),
			[string](Get-LifecycleProperty -Object $window -Name 'ownerHandle' -Default ''),
			[string](Get-LifecycleProperty -Object $window -Name 'kind' -Default ''),
			[string](Get-LifecycleProperty -Object $window -Name 'disabledMainHandle' -Default ''))
		Assert-LifecycleDeadline
		Write-LifecycleProtocol ([ordered]@{
			ok = $closed
			status = $(if ($closed) { 'closed' } else { 'refused' })
			reason = $(if ($closed) { $null } else { 'window_mismatch' })
		message = $(if ($closed) { $null } else { 'The visible native modal no longer matched the exact close request.' })
		})
	}
	catch [LifecycleProcessException]
	{
		$processException = Resolve-LifecycleProcessException -ErrorRecord $_
		Write-LifecycleProcessRefusal -Exception $processException
	}
	finally
	{
		if ($null -ne $handle) { $handle.Dispose() }
	}
}

function Invoke-VerifyEndpointOwner
{
	$request = Read-LifecycleRequest
	$endpoint = Get-LifecycleProperty -Object $request -Name 'endpoint'
	$expected = Get-LifecycleProperty -Object $request -Name 'expected'
	$hostName = [string](Get-LifecycleProperty -Object $endpoint -Name 'host' -Default '')
	$portNumber = [int](Get-LifecycleProperty -Object $endpoint -Name 'port' -Default 0)
	$processId = [int](Get-LifecycleProperty -Object $expected -Name 'pid' -Default 0)
	$expectedPath = [string](Get-LifecycleProperty -Object $expected -Name 'executablePath' -Default '')
	$expectedCreation = [string](Get-LifecycleProperty -Object $expected -Name 'creationTime' -Default '')
	$expectedArgument = [string](Get-LifecycleProperty -Object $expected -Name 'ownerTokenArgument' -Default '')
	$handle = $null
	try
	{
		$loopbackAddress = $null
		if (-not [Net.IPAddress]::TryParse($hostName, [ref]$loopbackAddress) -or
			-not [Net.IPAddress]::IsLoopback($loopbackAddress))
		{
			throw [LifecycleProcessException]::new(
				'endpoint_not_loopback',
				'Automated Workbench lifecycle control requires a numeric loopback endpoint.')
		}
		if ($portNumber -le 0 -or $portNumber -gt 65535)
		{
			throw [LifecycleProcessException]::new('helper_failure', 'The lifecycle endpoint port is invalid.')
		}
		# Retain the expected process handle across both listener-table samples and
		# the sole-Workbench scan so PID reuse cannot satisfy this operation.
		$handle = [LifecycleProcessHandle]::Open($processId, $false)
		$actualPath = $handle.GetExecutablePath()
		$actualCreation = $handle.GetCreationTime()
		if (-not [StringComparer]::OrdinalIgnoreCase.Equals(
			[IO.Path]::GetFullPath($expectedPath),
			[IO.Path]::GetFullPath($actualPath)))
		{
			throw [LifecycleProcessException]::new('executable_mismatch', 'The endpoint owner executable path does not match the recorded Workbench.')
		}
		if (-not [StringComparer]::Ordinal.Equals($expectedCreation, $actualCreation))
		{
			throw [LifecycleProcessException]::new('creation_time_mismatch', 'The endpoint owner creation time does not match the recorded Workbench.')
		}
		if ($handle.HasExited())
		{
			throw [LifecycleProcessException]::new('workbench_process_mismatch', 'The recorded Workbench exited before endpoint ownership could be proven.')
		}
		if (-not $handle.HasExactArgument($expectedArgument))
		{
			throw [LifecycleProcessException]::new('token_mismatch', 'The exact owner argument is absent from the endpoint-owner process.')
		}
		Assert-LifecycleDeadline

		$firstListenerPid = [LifecycleTcpTable]::ResolveLoopbackListenerOwner($hostName, $portNumber)
		if ($firstListenerPid -ne $processId)
		{
			throw [LifecycleProcessException]::new(
				'listener_pid_mismatch',
				"The listening TCP socket belongs to PID $firstListenerPid, not recorded Workbench PID $processId.")
		}

		$workbenchIdentities = New-Object 'System.Collections.Generic.List[object]'
		foreach ($process in [Diagnostics.Process]::GetProcessesByName('ArmaReforgerWorkbenchSteamDiag'))
		{
			$scanHandle = $null
			try
			{
				Assert-LifecycleDeadline
				$scanHandle = [LifecycleProcessHandle]::Open($process.Id, $false)
				[void]$workbenchIdentities.Add((ConvertTo-LifecycleIdentity -Handle $scanHandle))
			}
			catch [LifecycleProcessException]
			{
				$processException = Resolve-LifecycleProcessException -ErrorRecord $_
				if ($processException.Reason -ne 'pid_not_found') { throw }
			}
			finally
			{
				if ($null -ne $scanHandle) { $scanHandle.Dispose() }
				$process.Dispose()
			}
		}
		if ($workbenchIdentities.Count -ne 1)
		{
			throw [LifecycleProcessException]::new(
				'workbench_process_mismatch',
				"Endpoint ownership requires exactly one Workbench process; found $($workbenchIdentities.Count).")
		}
		$soleWorkbench = $workbenchIdentities[0]
		if ([int]$soleWorkbench.pid -ne $processId -or
			-not [StringComparer]::Ordinal.Equals([string]$soleWorkbench.creationTime, $expectedCreation) -or
			-not [StringComparer]::OrdinalIgnoreCase.Equals(
				[IO.Path]::GetFullPath([string]$soleWorkbench.executablePath),
				[IO.Path]::GetFullPath($expectedPath)))
		{
			throw [LifecycleProcessException]::new(
				'workbench_process_mismatch',
				'The sole Workbench process does not match the exact recorded identity.')
		}

		Assert-LifecycleDeadline
		$secondListenerPid = [LifecycleTcpTable]::ResolveLoopbackListenerOwner($hostName, $portNumber)
		if ($secondListenerPid -ne $processId)
		{
			throw [LifecycleProcessException]::new(
				'listener_pid_mismatch',
				'The listening TCP socket owner changed during endpoint verification.')
		}
		if ($handle.HasExited() -or -not $handle.HasExactArgument($expectedArgument))
		{
			throw [LifecycleProcessException]::new(
				'workbench_process_mismatch',
				'The exact Workbench identity changed during endpoint verification.')
		}
		Assert-LifecycleDeadline
		Write-LifecycleProtocol ([ordered]@{
			ok = $true
			status = 'owned'
			listenerPid = $secondListenerPid
			identity = ConvertTo-LifecycleIdentity -Handle $handle
		})
	}
	catch [LifecycleProcessException]
	{
		$processException = Resolve-LifecycleProcessException -ErrorRecord $_
		if ($processException.Reason -eq 'pid_not_found')
		{
			Write-LifecycleProtocol ([ordered]@{
				ok = $false
				status = 'refused'
				reason = 'workbench_process_mismatch'
				message = 'The recorded Workbench process is absent.'
			})
		}
		else
		{
			Write-LifecycleProcessRefusal -Exception $processException
		}
	}
	finally
	{
		if ($null -ne $handle) { $handle.Dispose() }
	}
}

function Invoke-VerifyEndpointVacant
{
	$request = Read-LifecycleRequest
	$endpoint = Get-LifecycleProperty -Object $request -Name 'endpoint'
	$hostName = [string](Get-LifecycleProperty -Object $endpoint -Name 'host' -Default '')
	$portNumber = [int](Get-LifecycleProperty -Object $endpoint -Name 'port' -Default 0)
	try
	{
		$loopbackAddress = $null
		if (-not [Net.IPAddress]::TryParse($hostName, [ref]$loopbackAddress) -or
			-not [Net.IPAddress]::IsLoopback($loopbackAddress))
		{
			throw [LifecycleProcessException]::new(
				'endpoint_not_loopback',
				'Automated Workbench lifecycle control requires a numeric loopback endpoint.')
		}
		if ($portNumber -le 0 -or $portNumber -gt 65535)
		{
			throw [LifecycleProcessException]::new('helper_failure', 'The lifecycle endpoint port is invalid.')
		}
		Assert-LifecycleDeadline
		$listenerPid = [LifecycleTcpTable]::ResolveLoopbackListenerOwner($hostName, $portNumber)
		# The TCP owner table can briefly retain a row after its owning process
		# has exited. Treat that row as vacant only after a native process handle
		# proves the PID is gone; a live or unverifiable PID remains fail-closed.
		$listenerHandle = $null
		try
		{
			$listenerHandle = [LifecycleProcessHandle]::Open($listenerPid, $false)
			if ($listenerHandle.HasExited())
			{
				Write-LifecycleProtocol ([ordered]@{ ok = $true; status = 'vacant' })
				return
			}
		}
		catch [LifecycleProcessException]
		{
			$listenerException = Resolve-LifecycleProcessException -ErrorRecord $_
			if ($listenerException.Reason -eq 'pid_not_found')
			{
				Write-LifecycleProtocol ([ordered]@{ ok = $true; status = 'vacant' })
				return
			}
			throw
		}
		finally
		{
			if ($null -ne $listenerHandle) { $listenerHandle.Dispose() }
		}
		Write-LifecycleProtocol ([ordered]@{
			ok = $false
			status = 'refused'
			reason = 'listener_present'
			listenerPid = $listenerPid
			message = "Loopback endpoint ${hostName}:$portNumber is still owned by PID $listenerPid."
		})
	}
	catch [LifecycleProcessException]
	{
		$processException = Resolve-LifecycleProcessException -ErrorRecord $_
		if ($processException.Reason -eq 'listener_not_found')
		{
			Write-LifecycleProtocol ([ordered]@{ ok = $true; status = 'vacant' })
		}
		else
		{
			Write-LifecycleProcessRefusal -Exception $processException
		}
	}
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
	if ($DeadlineUnixMs -gt 0)
	{
		$remainingMs = $DeadlineUnixMs - (Get-LifecycleUnixMilliseconds)
		if ($remainingMs -le 0) { Assert-LifecycleDeadline }
		$timeoutMs = [Math]::Min($timeoutMs, [int][Math]::Min($remainingMs, [int]::MaxValue))
	}
	$handle = $null
	try
	{
		$handle = [LifecycleProcessHandle]::Open($processId, $true)
		Assert-LifecycleDeadline
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
		Assert-LifecycleDeadline
		$terminated = $handle.TerminateAndWait($timeoutMs)
		Write-LifecycleProtocol ([ordered]@{
			ok = $true
			status = $(if ($terminated) { 'terminated' } else { 'already_exited' })
		})
	}
	catch [LifecycleProcessException]
	{
		$processException = Resolve-LifecycleProcessException -ErrorRecord $_
		if ($processException.Reason -eq 'pid_not_found')
		{
			Write-LifecycleProtocol ([ordered]@{ ok = $true; status = 'already_exited' })
		}
		else
		{
			Write-LifecycleProcessRefusal -Exception $processException
		}
	}
	finally
	{
		if ($null -ne $handle) { $handle.Dispose() }
	}
}

try
{
	Assert-LifecycleDeadline
	switch ($Mode)
	{
		'HoldMutex' { Invoke-HoldMutex }
		'InspectCurrent' { Invoke-InspectCurrent }
		'InspectProcess' { Invoke-InspectProcess }
		'ListWorkbench' { Invoke-ListWorkbench }
		'MinimizeWindow' { Invoke-MinimizeWindow }
		'InspectWindows' { Invoke-InspectWindows }
		'CloseWindow' { Invoke-CloseWindow }
		'VerifyEndpointOwner' { Invoke-VerifyEndpointOwner }
		'VerifyEndpointVacant' { Invoke-VerifyEndpointVacant }
		'VerifyTerminate' { Invoke-VerifyTerminate }
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
