[CmdletBinding()]
param(
	[long]$DeadlineUnixMs = 0,
	[ValidateSet('all', 'latest-choice', 'destroyed-window', 'reused-hwnd', 'pid-reuse')]
	[string]$SelfTestScenario
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
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class RuntimeFocusGuardResult
{
    public int TargetPid { get; set; }
    public string TargetCreationTime { get; set; }
    public int HookCount { get; set; }
    public bool HooksUnhooked { get; set; }
    public bool CallbackRooted { get; set; }
    public bool CallbackReleased { get; set; }
    public int ProtectedWindowCount { get; set; }
    public int StyleVerifiedCount { get; set; }
    public bool ForegroundIntercepted { get; set; }
    public bool ForegroundRestored { get; set; }
    public bool FinalForegroundOwned { get; set; }
    public bool TargetExited { get; set; }
    public string FailureMessage { get; set; }
}

internal sealed class FocusProcessHandle : IDisposable
{
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint WAIT_OBJECT_0 = 0;
    private const int PROCESS_COMMAND_LINE_INFORMATION = 60;

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString
    {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder path, ref int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr process, int informationClass, IntPtr information, int length, out int returned);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(string commandLine, out int argc);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    private IntPtr handle;
    public int ProcessId { get; private set; }
    public string CreationTime { get; private set; }

    private FocusProcessHandle(int pid, IntPtr value)
    {
        ProcessId = pid;
        handle = value;
        CreationTime = ReadCreationTime();
    }

    public static FocusProcessHandle Open(int pid)
    {
        if (pid <= 0) throw new InvalidOperationException("The focus target PID is invalid.");
        IntPtr value = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, pid);
        if (value == IntPtr.Zero)
            throw new InvalidOperationException("OpenProcess failed with Windows error " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + ".");
        try { return new FocusProcessHandle(pid, value); }
        catch { CloseHandle(value); throw; }
    }

    private void EnsureOpen()
    {
        if (handle == IntPtr.Zero) throw new ObjectDisposedException("FocusProcessHandle");
    }

    private string ReadCreationTime()
    {
        long creation, exit, kernel, user;
        if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user) || creation <= 0)
            throw new InvalidOperationException("GetProcessTimes could not prove the focus target generation.");
        return creation.ToString(CultureInfo.InvariantCulture);
    }

    public bool HasExited()
    {
        EnsureOpen();
        return WaitForSingleObject(handle, 0) == WAIT_OBJECT_0;
    }

    public string GetExecutablePath()
    {
        EnsureOpen();
        int size = 32768;
        StringBuilder path = new StringBuilder(size);
        if (!QueryFullProcessImageName(handle, 0, path, ref size) || path.Length == 0)
            throw new InvalidOperationException("QueryFullProcessImageName could not verify the focus target.");
        return System.IO.Path.GetFullPath(path.ToString());
    }

    private string GetCommandLine()
    {
        EnsureOpen();
        int required;
        NtQueryInformationProcess(handle, PROCESS_COMMAND_LINE_INFORMATION, IntPtr.Zero, 0, out required);
        if (required <= 0) throw new InvalidOperationException("Windows did not provide the target command-line size.");
        IntPtr buffer = Marshal.AllocHGlobal(required);
        try
        {
            int returned;
            int status = NtQueryInformationProcess(handle, PROCESS_COMMAND_LINE_INFORMATION, buffer, required, out returned);
            if (status != 0) throw new InvalidOperationException("Windows could not verify the target command line.");
            UnicodeString value = (UnicodeString)Marshal.PtrToStructure(buffer, typeof(UnicodeString));
            if (value.Buffer == IntPtr.Zero || value.Length == 0) throw new InvalidOperationException("The target command line is empty.");
            return Marshal.PtrToStringUni(value.Buffer, value.Length / 2);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    public bool HasExactArgument(string expected)
    {
        int count;
        IntPtr values = CommandLineToArgvW(GetCommandLine(), out count);
        if (values == IntPtr.Zero) throw new InvalidOperationException("Windows could not parse the target command line.");
        try
        {
            for (int index = 0; index < count; index++)
            {
                IntPtr item = Marshal.ReadIntPtr(values, index * IntPtr.Size);
                if (String.Equals(Marshal.PtrToStringUni(item), expected, StringComparison.Ordinal)) return true;
            }
            return false;
        }
        finally { LocalFree(values); }
    }

    public bool IsSameGeneration()
    {
        return !HasExited() && String.Equals(ReadCreationTime(), CreationTime, StringComparison.Ordinal);
    }

    public void Dispose()
    {
        if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
        GC.SuppressFinalize(this);
    }
}

internal interface IForegroundChoice : IDisposable
{
    IntPtr Window { get; }
    uint ThreadId { get; }
    bool IsCurrent();
}

internal sealed class ForegroundChoice : IForegroundChoice
{
    public IntPtr Window { get; private set; }
    public uint ThreadId { get; private set; }
    public FocusProcessHandle Process { get; private set; }

    public ForegroundChoice(IntPtr window, uint threadId, FocusProcessHandle process)
    {
        Window = window; ThreadId = threadId; Process = process;
    }

    public bool IsCurrent()
    {
        if (!RuntimeFocusGuardSession.IsNativeWindow(Window) || !Process.IsSameGeneration()) return false;
        uint pid;
        uint thread = RuntimeFocusGuardSession.WindowProcess(Window, out pid);
        return pid == (uint)Process.ProcessId && thread == ThreadId;
    }

    public void Dispose() { Process.Dispose(); }
}

// Keep the mutable selection policy independent from HWND values. The native
// choice still proves HWND + thread + retained process generation, while this
// ledger makes destruction an explicit revocation. That revocation is required
// even when Windows later recycles the same numeric HWND in the same process
// and GUI thread, where another IsCurrent() sample could otherwise be ambiguous.
internal sealed class ForegroundChoiceLedger : IDisposable
{
    private IForegroundChoice latest;

    public void RecordLatest(IntPtr window, Func<IntPtr, IForegroundChoice> capture)
    {
        if (latest != null && latest.Window == window && latest.IsCurrent()) return;
        IForegroundChoice choice = capture(window);
        IForegroundChoice previous = latest;
        latest = choice;
        if (previous != null) previous.Dispose();
    }

    public bool TryGetCurrent(out IForegroundChoice choice)
    {
        choice = latest;
        if (choice == null) return false;
        if (choice.IsCurrent()) return true;
        latest = null;
        choice.Dispose();
        choice = null;
        return false;
    }

    public void InvalidateWindow(IntPtr window)
    {
        if (latest == null || latest.Window != window) return;
        IForegroundChoice invalid = latest;
        latest = null;
        invalid.Dispose();
    }

    public void Dispose()
    {
        if (latest == null) return;
        IForegroundChoice previous = latest;
        latest = null;
        previous.Dispose();
    }
}

internal sealed class WindowStyleRecord
{
    public IntPtr Window;
    public bool OriginallyNoActivate;
}

public sealed class RuntimeFocusGuardSession : IDisposable
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
    private const uint EVENT_OBJECT_DESTROY = 0x8001;
    private const uint EVENT_OBJECT_SHOW = 0x8002;
    private const uint WINEVENT_OUTOFCONTEXT = 0;
    private const uint WINEVENT_SKIPOWNPROCESS = 2;
    private const int OBJID_WINDOW = 0;
    private const uint PM_REMOVE = 1;

    private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
    private delegate void WinEventProc(IntPtr hook, uint eventType, IntPtr window, int objectId, int childId, uint eventThread, uint eventTime);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeMessage
    {
        public IntPtr Window; public uint Message; public UIntPtr WParam; public IntPtr LParam;
        public uint Time; public int PointX; public int PointY; public uint Private;
    }

    [DllImport("user32.dll", SetLastError = true)] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetActiveWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] private static extern void SetLastError(uint error);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint first, uint second, bool attach);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)] private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)] private static extern IntPtr SetWindowLongPtr(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module, WinEventProc callback, uint processId, uint threadId, uint flags);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out NativeMessage message, IntPtr window, uint minimum, uint maximum, uint remove);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref NativeMessage message);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref NativeMessage message);

    private readonly object sync = new object();
    private readonly string expectedPath;
    private readonly string ownerArgument;
    private readonly string faultMode;
    private readonly long deadlineUnixMs;
    private readonly ManualResetEvent ready = new ManualResetEvent(false);
    private readonly ManualResetEvent finished = new ManualResetEvent(false);
    private readonly Dictionary<IntPtr, WindowStyleRecord> styles = new Dictionary<IntPtr, WindowStyleRecord>();
    private Thread thread;
    private FocusProcessHandle target;
    private readonly ForegroundChoiceLedger foregroundChoices = new ForegroundChoiceLedger();
    private WinEventProc callback;
    private GCHandle callbackRoot;
    private bool callbackRootAllocated;
    private IntPtr foregroundHook;
    private IntPtr objectHook;
    private volatile Exception startupFailure;
    private volatile Exception runtimeFailure;
    private volatile bool abort;
    private readonly RuntimeFocusGuardResult result = new RuntimeFocusGuardResult();

    public RuntimeFocusGuardSession(string executablePath, string expectedOwnerArgument, string injectedFault, long deadline)
    {
        expectedPath = System.IO.Path.GetFullPath(executablePath);
        ownerArgument = expectedOwnerArgument;
        faultMode = injectedFault ?? "none";
        deadlineUnixMs = deadline;
    }

    public int HookCount { get { return result.HookCount; } }
    public bool CallbackRooted { get { return result.CallbackRooted; } }
    internal static bool IsNativeWindow(IntPtr window) { return window != IntPtr.Zero && IsWindow(window); }
    internal static uint WindowProcess(IntPtr window, out uint pid) { return GetWindowThreadProcessId(window, out pid); }
    internal static bool MatchesExactTargetGeneration(int exactPid, bool generationCurrent, uint windowPid)
    {
        return exactPid > 0 && generationCurrent && windowPid == (uint)exactPid;
    }

    public void Start()
    {
        thread = new Thread(Run);
        thread.IsBackground = true;
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        if (!ready.WaitOne(15000)) throw new InvalidOperationException("Focus hook readiness timed out.");
        if (startupFailure != null) throw new InvalidOperationException("Focus hook readiness failed: " + startupFailure.Message, startupFailure);
    }

    private long NowUnixMs() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }

    private void Run()
    {
        try
        {
            InstallHooks();
            ObserveForeground();
            ready.Set();
            int collections = 0;
            while (!abort && runtimeFailure == null && NowUnixMs() < deadlineUnixMs)
            {
                FocusProcessHandle exact = TargetSnapshot();
                if (exact != null && exact.HasExited()) { result.TargetExited = true; break; }
                EnumWindows(delegate(IntPtr window, IntPtr parameter) { TryProtect(window); return runtimeFailure == null; }, IntPtr.Zero);
                ObserveForeground();
                NativeMessage message;
                while (PeekMessage(out message, IntPtr.Zero, 0, 0, PM_REMOVE))
                {
                    TranslateMessage(ref message); DispatchMessage(ref message);
                }
                if ((++collections % 40) == 0) GC.Collect(0, GCCollectionMode.Forced);
                Thread.Sleep(5);
            }
        }
        catch (Exception error)
        {
            if (result.HookCount == 0) startupFailure = error; else runtimeFailure = error;
            ready.Set();
        }
        finally
        {
            try { Cleanup(); }
            catch (Exception cleanupError) { if (runtimeFailure == null) runtimeFailure = cleanupError; }
            finished.Set();
        }
    }

    private void InstallHooks()
    {
        callback = OnWinEvent;
        callbackRoot = GCHandle.Alloc(callback);
        callbackRootAllocated = true;
        result.CallbackRooted = true;
        if (String.Equals(faultMode, "hook", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Injected SetWinEventHook failure.");
        foregroundHook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, callback, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
        if (foregroundHook == IntPtr.Zero) throw new InvalidOperationException("SetWinEventHook(foreground) failed with Windows error " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + ".");
        result.HookCount = 1;
        objectHook = SetWinEventHook(EVENT_OBJECT_CREATE, EVENT_OBJECT_SHOW, IntPtr.Zero, callback, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
        if (objectHook == IntPtr.Zero) throw new InvalidOperationException("SetWinEventHook(object) failed with Windows error " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + ".");
        result.HookCount = 2;
    }

    private FocusProcessHandle TargetSnapshot() { lock (sync) { return target; } }

    private bool VerifyCandidate(FocusProcessHandle candidate)
    {
        return String.Equals(candidate.GetExecutablePath(), expectedPath, StringComparison.OrdinalIgnoreCase) &&
            candidate.HasExactArgument(ownerArgument) && candidate.IsSameGeneration();
    }

    private bool TryBindCandidate(uint pid)
    {
        if (pid == 0 || pid > Int32.MaxValue) return false;
        lock (sync)
        {
            if (target != null) return target.ProcessId == (int)pid && target.IsSameGeneration();
        }
        FocusProcessHandle candidate = null;
        try
        {
            candidate = FocusProcessHandle.Open((int)pid);
            if (!VerifyCandidate(candidate)) return false;
            lock (sync)
            {
                if (target == null)
                {
                    target = candidate; candidate = null;
                    result.TargetPid = target.ProcessId;
                    result.TargetCreationTime = target.CreationTime;
                    return true;
                }
                return target.ProcessId == (int)pid && target.IsSameGeneration();
            }
        }
        catch (Exception error)
        {
            // A matching executable whose command line cannot be verified is a
            // fail-closed candidate; unrelated desktop processes are ignored.
            try
            {
                if (candidate != null && String.Equals(candidate.GetExecutablePath(), expectedPath, StringComparison.OrdinalIgnoreCase))
                    runtimeFailure = error;
            }
            catch { }
            return false;
        }
        finally { if (candidate != null) candidate.Dispose(); }
    }

    public void Bind(int pid)
    {
        if (finished.WaitOne(0)) throw new InvalidOperationException("The focus guard deadline ended before target bind.");
        if (!TryBindCandidate((uint)pid))
            throw new InvalidOperationException("The bound focus target did not match the exact executable and owner argument.");
        FocusProcessHandle exact = TargetSnapshot();
        if (exact == null || exact.ProcessId != pid)
            throw new InvalidOperationException("The focus guard discovered a different target generation before bind.");
    }

    private bool IsExactTargetWindow(IntPtr window)
    {
        if (window == IntPtr.Zero) return false;
        uint pid; GetWindowThreadProcessId(window, out pid);
        FocusProcessHandle exact = TargetSnapshot();
        if (exact == null && !TryBindCandidate(pid)) return false;
        exact = TargetSnapshot();
        return exact != null && MatchesExactTargetGeneration(exact.ProcessId, exact.IsSameGeneration(), pid);
    }

    private IntPtr ReadStyle(IntPtr window)
    {
        SetLastError(0);
        IntPtr value = GetWindowLongPtr(window, GWL_EXSTYLE);
        int error = Marshal.GetLastWin32Error();
        if (value == IntPtr.Zero && error != 0) throw new InvalidOperationException("GetWindowLongPtr failed with Windows error " + error.ToString(CultureInfo.InvariantCulture) + ".");
        return value;
    }

    private void WriteStyle(IntPtr window, long style)
    {
        SetLastError(0);
        IntPtr previous = SetWindowLongPtr(window, GWL_EXSTYLE, new IntPtr(style));
        int error = Marshal.GetLastWin32Error();
        if (previous == IntPtr.Zero && error != 0) throw new InvalidOperationException("SetWindowLongPtr failed with Windows error " + error.ToString(CultureInfo.InvariantCulture) + ".");
    }

    private void TryProtect(IntPtr window)
    {
        try
        {
            if (!IsExactTargetWindow(window) || styles.ContainsKey(window)) return;
            if (String.Equals(faultMode, "style", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Injected window-style failure.");
            IntPtr original = ReadStyle(window);
            long protectedStyle = original.ToInt64() | WS_EX_NOACTIVATE;
            WriteStyle(window, protectedStyle);
            try
            {
                if ((ReadStyle(window).ToInt64() & WS_EX_NOACTIVATE) == 0)
                    throw new InvalidOperationException("WS_EX_NOACTIVATE style readback did not match the write.");
                if (!SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED))
                    throw new InvalidOperationException("SetWindowPos failed with Windows error " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + ".");
            }
            catch
            {
                // The window is not admitted to the restoration table until
                // both native operations and readback succeed. Roll back the
                // partial style write immediately on the failure path.
                try
                {
                    WriteStyle(window, original.ToInt64());
                    SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
                }
                catch { }
                throw;
            }
            styles.Add(window, new WindowStyleRecord { Window = window, OriginallyNoActivate = (original.ToInt64() & WS_EX_NOACTIVATE) != 0 });
            result.ProtectedWindowCount++;
            result.StyleVerifiedCount++;
        }
        catch (Exception error) { runtimeFailure = error; }
    }

    private IForegroundChoice CaptureChoice(IntPtr window)
    {
        if (!IsNativeWindow(window)) return null;
        uint pid; uint threadId = GetWindowThreadProcessId(window, out pid);
        if (pid == 0 || pid > Int32.MaxValue) return null;
        FocusProcessHandle process = null;
        try
        {
            process = FocusProcessHandle.Open((int)pid);
            ForegroundChoice choice = new ForegroundChoice(window, threadId, process);
            if (!choice.IsCurrent()) { choice.Dispose(); return null; }
            return choice;
        }
        catch { if (process != null) process.Dispose(); return null; }
    }

    private void RecordLatestForeground(IntPtr window)
    {
        // A different foreground HWND is itself evidence that the user's
        // choice changed.  If that process cannot be opened (for example an
        // elevated or protected window), discard the older restorable choice
        // instead of later restoring that stale window over the user's newer
        // selection.  A subsequent target activation will then fail closed
        // because there is no exact restorable choice.
        foregroundChoices.RecordLatest(window, CaptureChoice);
    }

    private bool RestoreLatestForeground()
    {
        IForegroundChoice choice;
        if (!foregroundChoices.TryGetCurrent(out choice)) return false;
        IntPtr current = GetForegroundWindow();
        uint ignored;
        uint currentThread = GetCurrentThreadId();
        uint foregroundThread = GetWindowThreadProcessId(current, out ignored);
        bool attachedForeground = foregroundThread != 0 && foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
        bool attachedRestore = choice.ThreadId != 0 && choice.ThreadId != currentThread && choice.ThreadId != foregroundThread && AttachThreadInput(currentThread, choice.ThreadId, true);
        try
        {
            BringWindowToTop(choice.Window); SetActiveWindow(choice.Window);
            return SetForegroundWindow(choice.Window) || GetForegroundWindow() == choice.Window;
        }
        finally
        {
            if (attachedRestore) AttachThreadInput(currentThread, choice.ThreadId, false);
            if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
        }
    }

    private void ObserveForeground()
    {
        IntPtr foreground = GetForegroundWindow();
        if (IsExactTargetWindow(foreground))
        {
            TryProtect(foreground);
            result.ForegroundIntercepted = true;
            bool restored = RestoreLatestForeground();
            result.ForegroundRestored = result.ForegroundRestored || restored;
            if (!restored) runtimeFailure = new InvalidOperationException("The target activated and the latest verified non-target foreground could not be restored.");
        }
        else RecordLatestForeground(foreground);
    }

    private void OnWinEvent(IntPtr hook, uint eventType, IntPtr window, int objectId, int childId, uint eventThread, uint eventTime)
    {
        try
        {
            if (eventType == EVENT_OBJECT_DESTROY && objectId == OBJID_WINDOW)
            {
                styles.Remove(window);
                foregroundChoices.InvalidateWindow(window);
                return;
            }
            if (objectId == OBJID_WINDOW && (eventType == EVENT_OBJECT_CREATE || eventType == EVENT_OBJECT_SHOW)) TryProtect(window);
            if (eventType == EVENT_SYSTEM_FOREGROUND) ObserveForeground();
        }
        catch (Exception error) { runtimeFailure = error; }
    }

    private void RestoreStyles()
    {
        foreach (WindowStyleRecord item in new List<WindowStyleRecord>(styles.Values))
        {
            if (!IsExactTargetWindow(item.Window)) continue;
            long current = ReadStyle(item.Window).ToInt64();
            long restored = item.OriginallyNoActivate ? current | WS_EX_NOACTIVATE : current & ~WS_EX_NOACTIVATE;
            WriteStyle(item.Window, restored);
            bool actual = (ReadStyle(item.Window).ToInt64() & WS_EX_NOACTIVATE) != 0;
            if (actual != item.OriginallyNoActivate) throw new InvalidOperationException("Window style restoration readback failed.");
            if (!SetWindowPos(item.Window, IntPtr.Zero, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED))
                throw new InvalidOperationException("Window style restoration SetWindowPos failed.");
        }
    }

    private void Cleanup()
    {
        Exception cleanupFailure = null;
        try { RestoreStyles(); }
        catch (Exception error) { cleanupFailure = error; }
        try { ObserveForeground(); }
        catch (Exception error) { if (cleanupFailure == null) cleanupFailure = error; }
        bool foregroundUnhooked = foregroundHook == IntPtr.Zero || UnhookWinEvent(foregroundHook);
        bool objectUnhooked = objectHook == IntPtr.Zero || UnhookWinEvent(objectHook);
        result.HooksUnhooked = foregroundUnhooked && objectUnhooked;
        if (!result.HooksUnhooked && cleanupFailure == null)
            cleanupFailure = new InvalidOperationException("A focus WinEvent hook could not be removed.");
        // Never release the managed callback while either native hook may still
        // call it. A failed unhook intentionally retains the root until process exit.
        if (callbackRootAllocated && result.HooksUnhooked)
        {
            callbackRoot.Free(); callbackRootAllocated = false; result.CallbackReleased = true;
        }
        result.FinalForegroundOwned = IsExactTargetWindow(GetForegroundWindow());
        foregroundChoices.Dispose();
        lock (sync) { if (target != null) { target.Dispose(); target = null; } }
        if (cleanupFailure != null) throw cleanupFailure;
    }

    public RuntimeFocusGuardResult WaitForResult()
    {
        long remaining = Math.Max(1, deadlineUnixMs - NowUnixMs() + 5000);
        if (!finished.WaitOne((int)Math.Min(Int32.MaxValue, remaining))) throw new InvalidOperationException("Focus protection did not finish by its deadline.");
        if (runtimeFailure != null) result.FailureMessage = runtimeFailure.Message;
        if (result.TargetPid == 0 && result.FailureMessage == null) result.FailureMessage = "No exact target process was bound.";
        if (result.ProtectedWindowCount == 0 && result.FailureMessage == null) result.FailureMessage = "No target startup window was observed and protected.";
        return result;
    }

    public void Abort() { abort = true; }

    public void Dispose()
    {
        abort = true;
        if (thread != null && thread.IsAlive) thread.Join(5000);
        ready.Dispose(); finished.Dispose();
    }
}

internal sealed class SyntheticForegroundChoice : IForegroundChoice
{
    public IntPtr Window { get; private set; }
    public uint ThreadId { get; private set; }
    public bool Current { get; set; }
    public int CurrentChecks { get; private set; }
    public int DisposeCount { get; private set; }

    public SyntheticForegroundChoice(long window, uint threadId)
    {
        Window = new IntPtr(window);
        ThreadId = threadId;
        Current = true;
    }

    public bool IsCurrent()
    {
        CurrentChecks++;
        return Current;
    }

    public void Dispose() { DisposeCount++; }
}

public sealed class RuntimeFocusGuardSelfTestResult
{
    public string Scenario { get; set; }
    public bool Passed { get; set; }
    public long SelectedWindow { get; set; }
    public bool MutationAuthorized { get; set; }
    public int DisposedCount { get; set; }
}

// This harness runs inside the same Add-Type assembly as the production helper
// but never creates or activates a window. It deterministically proves the
// ordering/revocation policy that cannot safely be forced on an unattended
// desktop. The opt-in fixture remains responsible for real WinEvent/USER32 use.
public static class RuntimeFocusGuardDeterministicChecks
{
    private static RuntimeFocusGuardSelfTestResult LatestChoice()
    {
        ForegroundChoiceLedger ledger = new ForegroundChoiceLedger();
        SyntheticForegroundChoice first = new SyntheticForegroundChoice(0xA, 10);
        SyntheticForegroundChoice second = new SyntheticForegroundChoice(0xB, 20);
        ledger.RecordLatest(first.Window, delegate(IntPtr ignored) { return first; });
        ledger.RecordLatest(second.Window, delegate(IntPtr ignored) { return second; });
        IForegroundChoice selected;
        bool available = ledger.TryGetCurrent(out selected);
        bool passed = available && selected.Window == second.Window && first.DisposeCount == 1;
        long selectedWindow = available ? selected.Window.ToInt64() : 0;
        ledger.Dispose();
        return new RuntimeFocusGuardSelfTestResult {
            Scenario = "latest-choice", Passed = passed, SelectedWindow = selectedWindow,
            MutationAuthorized = available, DisposedCount = first.DisposeCount + second.DisposeCount
        };
    }

    private static RuntimeFocusGuardSelfTestResult DestroyedWindow()
    {
        ForegroundChoiceLedger ledger = new ForegroundChoiceLedger();
        SyntheticForegroundChoice choice = new SyntheticForegroundChoice(0xA, 10);
        ledger.RecordLatest(choice.Window, delegate(IntPtr ignored) { return choice; });
        choice.Current = false;
        IForegroundChoice selected;
        bool available = ledger.TryGetCurrent(out selected);
        bool passed = !available && selected == null && choice.DisposeCount == 1;
        ledger.Dispose();
        return new RuntimeFocusGuardSelfTestResult {
            Scenario = "destroyed-window", Passed = passed, SelectedWindow = 0,
            MutationAuthorized = available, DisposedCount = choice.DisposeCount
        };
    }

    private static RuntimeFocusGuardSelfTestResult ReusedHwnd()
    {
        ForegroundChoiceLedger ledger = new ForegroundChoiceLedger();
        SyntheticForegroundChoice choice = new SyntheticForegroundChoice(0xA, 10);
        ledger.RecordLatest(choice.Window, delegate(IntPtr ignored) { return choice; });
        ledger.InvalidateWindow(choice.Window);
        int checksAfterDestroy = choice.CurrentChecks;
        // Model an HWND recycled in the same PID/thread: an identity-only check
        // would again say current, but explicit destroy revocation owns no choice.
        choice.Current = true;
        IForegroundChoice selected;
        bool available = ledger.TryGetCurrent(out selected);
        bool passed = !available && selected == null && choice.DisposeCount == 1 &&
            choice.CurrentChecks == checksAfterDestroy;
        ledger.Dispose();
        return new RuntimeFocusGuardSelfTestResult {
            Scenario = "reused-hwnd", Passed = passed, SelectedWindow = 0,
            MutationAuthorized = available, DisposedCount = choice.DisposeCount
        };
    }

    private static RuntimeFocusGuardSelfTestResult ReusedPid()
    {
        bool recycledAuthorized = RuntimeFocusGuardSession.MatchesExactTargetGeneration(4242, false, 4242);
        bool currentAuthorized = RuntimeFocusGuardSession.MatchesExactTargetGeneration(4242, true, 4242);
        bool otherAuthorized = RuntimeFocusGuardSession.MatchesExactTargetGeneration(4242, true, 4343);
        return new RuntimeFocusGuardSelfTestResult {
            Scenario = "pid-reuse",
            Passed = !recycledAuthorized && currentAuthorized && !otherAuthorized,
            SelectedWindow = 0,
            MutationAuthorized = recycledAuthorized,
            DisposedCount = 0
        };
    }

    public static RuntimeFocusGuardSelfTestResult[] RunAll()
    {
        return new RuntimeFocusGuardSelfTestResult[] {
            LatestChoice(), DestroyedWindow(), ReusedHwnd(), ReusedPid()
        };
    }

    public static RuntimeFocusGuardSelfTestResult Run(string scenario)
    {
        foreach (RuntimeFocusGuardSelfTestResult item in RunAll())
            if (String.Equals(item.Scenario, scenario, StringComparison.OrdinalIgnoreCase)) return item;
        throw new InvalidOperationException("Unknown deterministic focus scenario.");
    }
}
'@

if (-not [string]::IsNullOrWhiteSpace($SelfTestScenario))
{
	try
	{
		$cases = if ($SelfTestScenario -eq 'all')
		{
			@([RuntimeFocusGuardDeterministicChecks]::RunAll())
		}
		else
		{
			@([RuntimeFocusGuardDeterministicChecks]::Run($SelfTestScenario))
		}
		$ok = @($cases | Where-Object { -not $_.Passed }).Count -eq 0
		Write-FocusGuardProtocol ([ordered]@{
			ok = $ok
			status = 'self_test'
			cases = $cases
		})
		if (-not $ok) { exit 1 }
		return
	}
	catch
	{
		Write-FocusGuardProtocol ([ordered]@{ ok = $false; status = 'self_test_error'; message = $_.Exception.Message })
		exit 1
	}
}

$session = $null
try
{
	if ($DeadlineUnixMs -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
	{
		throw 'Runtime focus guard deadline has already expired.'
	}
	$configLine = [Console]::In.ReadLine()
	if ([string]::IsNullOrWhiteSpace($configLine)) { throw 'Runtime focus guard received no configuration.' }
	$config = $configLine | ConvertFrom-Json
	$session = [RuntimeFocusGuardSession]::new(
		[string]$config.executablePath,
		[string]$config.ownerTokenArgument,
		[string]$config.faultMode,
		$DeadlineUnixMs)
	$session.Start()
	Write-FocusGuardProtocol ([ordered]@{
		ok = $true
		status = 'ready'
		hookCount = $session.HookCount
		callbackRooted = $session.CallbackRooted
	})

	$commandLine = [Console]::In.ReadLine()
	if ([string]::IsNullOrWhiteSpace($commandLine)) { throw 'Runtime focus guard received no bind command.' }
	$command = $commandLine | ConvertFrom-Json
	if ([string]$command.action -eq 'abort')
	{
		$session.Abort()
		Write-FocusGuardProtocol ([ordered]@{ ok = $false; status = 'aborted'; message = 'Focus guard was aborted before spawn.' })
		return
	}
	if ([string]$command.action -ne 'bind') { throw 'Runtime focus guard received an invalid bind command.' }
	$session.Bind([int]$command.targetPid)
	$result = $session.WaitForResult()
	$ok = [string]::IsNullOrWhiteSpace($result.FailureMessage) -and
		-not $result.TargetExited -and $result.HookCount -ge 2 -and
		$result.HooksUnhooked -and $result.CallbackRooted -and $result.CallbackReleased -and
		$result.ProtectedWindowCount -gt 0 -and $result.StyleVerifiedCount -gt 0 -and
		-not $result.FinalForegroundOwned
	Write-FocusGuardProtocol ([ordered]@{
		ok = $ok
		status = $(if ($ok) { 'protected' } elseif ($result.TargetExited) { 'target_exited' } else { 'protection_failed' })
		targetPid = $result.TargetPid
		targetCreationTime = $result.TargetCreationTime
		hookCount = $result.HookCount
		hooksUnhooked = $result.HooksUnhooked
		callbackRooted = $result.CallbackRooted
		callbackReleased = $result.CallbackReleased
		protectedWindowCount = $result.ProtectedWindowCount
		styleVerifiedCount = $result.StyleVerifiedCount
		foregroundIntercepted = $result.ForegroundIntercepted
		foregroundRestored = $result.ForegroundRestored
		finalForegroundOwned = $result.FinalForegroundOwned
		message = $result.FailureMessage
	})
	if (-not $ok) { exit 1 }
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
finally
{
	if ($null -ne $session) { $session.Dispose() }
}
