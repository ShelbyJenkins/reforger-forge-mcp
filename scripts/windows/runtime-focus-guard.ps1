[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)]
	[ValidateRange(1, 4294967295)]
	[long]$TargetPid,

	[Parameter(Mandatory = $true)]
	[long]$DeadlineUnixMs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-FocusGuardProtocol
{
	param([Parameter(Mandatory = $true)][object]$Value)
	[Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 8))
	[Console]::Out.Flush()
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public sealed class RuntimeFocusGuardResult
{
    public int ProtectedWindowCount { get; set; }
    public bool ForegroundIntercepted { get; set; }
    public bool ForegroundRestored { get; set; }
    public bool FinalForegroundOwned { get; set; }
    public bool TargetExited { get; set; }
}

public static class RuntimeFocusGuard
{
    private const int GWL_EXSTYLE = -20;
    private const long WS_EX_NOACTIVATE = 0x08000000L;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_FRAMECHANGED = 0x0020;
    private const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    private const uint EVENT_OBJECT_CREATE = 0x8000;
    private const uint EVENT_OBJECT_SHOW = 0x8002;
    private const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    private const uint WINEVENT_SKIPOWNPROCESS = 0x0002;
    private const int OBJID_WINDOW = 0;

    private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
    private delegate void WinEventProc(
        IntPtr hook,
        uint eventType,
        IntPtr window,
        int objectId,
        int childId,
        uint eventThread,
        uint eventTime
    );

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeMessage
    {
        public IntPtr Window;
        public uint Message;
        public UIntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public int PointX;
        public int PointY;
        public uint Private;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr window);

    [DllImport("user32.dll")]
    private static extern IntPtr SetActiveWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr window);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint first, uint second, bool attach);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    private static extern IntPtr SetWindowLongPtr(IntPtr window, int index, IntPtr value);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(
        IntPtr window,
        IntPtr insertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags
    );

    [DllImport("user32.dll")]
    private static extern IntPtr SetWinEventHook(
        uint eventMin,
        uint eventMax,
        IntPtr module,
        WinEventProc callback,
        uint processId,
        uint threadId,
        uint flags
    );

    [DllImport("user32.dll")]
    private static extern bool UnhookWinEvent(IntPtr hook);

    [DllImport("user32.dll")]
    private static extern bool PeekMessage(
        out NativeMessage message,
        IntPtr window,
        uint minimum,
        uint maximum,
        uint remove
    );

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref NativeMessage message);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref NativeMessage message);

    private static bool IsOwnedWindow(IntPtr window, uint targetPid)
    {
        if (window == IntPtr.Zero) return false;
        uint processId;
        GetWindowThreadProcessId(window, out processId);
        return processId == targetPid;
    }

    private static bool RestoreForeground(IntPtr restoreWindow)
    {
        if (restoreWindow == IntPtr.Zero || !IsWindow(restoreWindow)) return false;
        IntPtr currentForeground = GetForegroundWindow();
        uint ignored;
        uint foregroundThread = GetWindowThreadProcessId(currentForeground, out ignored);
        uint restoreThread = GetWindowThreadProcessId(restoreWindow, out ignored);
        uint currentThread = GetCurrentThreadId();
        bool attachedForeground = foregroundThread != 0 && foregroundThread != currentThread &&
            AttachThreadInput(currentThread, foregroundThread, true);
        bool attachedRestore = restoreThread != 0 && restoreThread != currentThread &&
            restoreThread != foregroundThread && AttachThreadInput(currentThread, restoreThread, true);
        try
        {
            BringWindowToTop(restoreWindow);
            SetActiveWindow(restoreWindow);
            return SetForegroundWindow(restoreWindow) || GetForegroundWindow() == restoreWindow;
        }
        finally
        {
            if (attachedRestore) AttachThreadInput(currentThread, restoreThread, false);
            if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
        }
    }

    public static RuntimeFocusGuardResult Protect(uint targetPid, long deadlineUnixMs)
    {
        var result = new RuntimeFocusGuardResult();
        var originalStyles = new Dictionary<IntPtr, IntPtr>();
        IntPtr restoreWindow = GetForegroundWindow();
        if (IsOwnedWindow(restoreWindow, targetPid)) restoreWindow = IntPtr.Zero;

        Action<IntPtr> protectWindow = delegate(IntPtr window)
        {
            if (!IsOwnedWindow(window, targetPid)) return;
            IntPtr currentStyle = GetWindowLongPtr(window, GWL_EXSTYLE);
            if (!originalStyles.ContainsKey(window)) originalStyles.Add(window, currentStyle);
            long protectedStyle = currentStyle.ToInt64() | WS_EX_NOACTIVATE;
            SetWindowLongPtr(window, GWL_EXSTYLE, new IntPtr(protectedStyle));
            SetWindowPos(
                window,
                IntPtr.Zero,
                0,
                0,
                0,
                0,
                SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED
            );
        };

        Action interceptForeground = delegate()
        {
            if (!IsOwnedWindow(GetForegroundWindow(), targetPid)) return;
            result.ForegroundIntercepted = true;
            result.ForegroundRestored = RestoreForeground(restoreWindow) || result.ForegroundRestored;
        };

        WinEventProc callback = delegate(
            IntPtr hook,
            uint eventType,
            IntPtr window,
            int objectId,
            int childId,
            uint eventThread,
            uint eventTime)
        {
            if (objectId == OBJID_WINDOW || eventType == EVENT_SYSTEM_FOREGROUND)
                protectWindow(window);
            if (eventType == EVENT_SYSTEM_FOREGROUND) interceptForeground();
        };

        IntPtr foregroundHook = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            IntPtr.Zero,
            callback,
            targetPid,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS
        );
        IntPtr objectHook = SetWinEventHook(
            EVENT_OBJECT_CREATE,
            EVENT_OBJECT_SHOW,
            IntPtr.Zero,
            callback,
            targetPid,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS
        );

        try
        {
            while (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() < deadlineUnixMs)
            {
                try
                {
                    using (Process target = Process.GetProcessById((int)targetPid))
                    {
                        if (target.HasExited)
                        {
                            result.TargetExited = true;
                            break;
                        }
                    }
                }
                catch (ArgumentException)
                {
                    result.TargetExited = true;
                    break;
                }

                EnumWindows(delegate(IntPtr window, IntPtr parameter)
                {
                    protectWindow(window);
                    return true;
                }, IntPtr.Zero);
                interceptForeground();

                NativeMessage message;
                while (PeekMessage(out message, IntPtr.Zero, 0, 0, 0x0001))
                {
                    TranslateMessage(ref message);
                    DispatchMessage(ref message);
                }
                Thread.Sleep(5);
            }
        }
        finally
        {
            if (foregroundHook != IntPtr.Zero) UnhookWinEvent(foregroundHook);
            if (objectHook != IntPtr.Zero) UnhookWinEvent(objectHook);
            foreach (KeyValuePair<IntPtr, IntPtr> item in originalStyles)
            {
                if (!IsOwnedWindow(item.Key, targetPid)) continue;
                SetWindowLongPtr(item.Key, GWL_EXSTYLE, item.Value);
                SetWindowPos(
                    item.Key,
                    IntPtr.Zero,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED
                );
            }
        }

        interceptForeground();
        result.ProtectedWindowCount = originalStyles.Count;
        result.FinalForegroundOwned = IsOwnedWindow(GetForegroundWindow(), targetPid);
        return result;
    }
}
'@

try
{
	if ($DeadlineUnixMs -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
	{
		throw 'Runtime focus guard deadline has already expired.'
	}
	$result = [RuntimeFocusGuard]::Protect([uint32]$TargetPid, $DeadlineUnixMs)
	Write-FocusGuardProtocol ([ordered]@{
		ok = (-not $result.FinalForegroundOwned)
		status = $(if ($result.TargetExited) { 'target_exited' } else { 'protected' })
		protectedWindowCount = $result.ProtectedWindowCount
		foregroundIntercepted = $result.ForegroundIntercepted
		foregroundRestored = $result.ForegroundRestored
		finalForegroundOwned = $result.FinalForegroundOwned
	})
}
catch
{
	Write-FocusGuardProtocol ([ordered]@{
		ok = $false
		status = 'error'
		message = $_.Exception.Message
	})
	exit 1
}
