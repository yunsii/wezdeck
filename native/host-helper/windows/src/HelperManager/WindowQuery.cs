using System.Diagnostics;

namespace WezTerm.WindowsHostHelper;

internal static class WindowQuery
{
    // Enumerate every visible top-level editor window owned by the target
    // process group. Unlike Process.MainWindowHandle (one handle per process),
    // this sees each Electron/VS Code window individually, which is what the
    // max-window cap needs to count correctly.
    public static List<WindowMatch> EnumerateVisibleTopLevelWindows(string expectedProcessName)
    {
        var processIds = new HashSet<int>();
        foreach (var process in Process.GetProcessesByName(expectedProcessName))
        {
            try
            {
                processIds.Add(process.Id);
            }
            finally
            {
                process.Dispose();
            }
        }

        var windows = new List<WindowMatch>();
        if (processIds.Count == 0)
        {
            return windows;
        }

        NativeMethods.EnumWindows((windowHandle, _) =>
        {
            if (!IsCountableTopLevelWindow(windowHandle))
            {
                return true;
            }

            NativeMethods.GetWindowThreadProcessId(windowHandle, out var processId);
            if (processId != 0 && processIds.Contains((int)processId))
            {
                windows.Add(new WindowMatch((int)processId, windowHandle));
            }

            return true;
        }, IntPtr.Zero);

        return windows;
    }

    private static bool IsCountableTopLevelWindow(IntPtr windowHandle)
    {
        if (!NativeMethods.IsWindowVisible(windowHandle))
        {
            return false;
        }

        // Owned windows are popups/dialogs, not standalone editor windows.
        if (NativeMethods.GetWindow(windowHandle, NativeMethods.GwOwner) != IntPtr.Zero)
        {
            return false;
        }

        var exStyle = NativeMethods.GetWindowLongPtr(windowHandle, NativeMethods.GwlExStyle).ToInt64();
        if ((exStyle & NativeMethods.WsExToolWindow) != 0)
        {
            return false;
        }

        // Real editor windows always carry a title; hidden helper windows do not.
        return NativeMethods.GetWindowTextLength(windowHandle) > 0;
    }

    public static HashSet<IntPtr> CaptureVisibleProcessWindowHandles(string expectedProcessName)
    {
        var windowHandles = new HashSet<IntPtr>();
        foreach (var window in EnumerateVisibleTopLevelWindows(expectedProcessName))
        {
            windowHandles.Add(window.WindowHandle);
        }

        return windowHandles;
    }

    public static WindowMatch? FindFirstVisibleProcessWindow(string expectedProcessName)
    {
        foreach (var window in EnumerateVisibleTopLevelWindows(expectedProcessName))
        {
            if (NativeMethods.IsWindow(window.WindowHandle))
            {
                return window;
            }
        }

        // Fall back to the process main-window scan if enumeration finds nothing
        // (e.g. a window that transiently reports no title during startup).
        foreach (var process in Process.GetProcessesByName(expectedProcessName))
        {
            try
            {
                process.Refresh();
                if (process.MainWindowHandle != IntPtr.Zero && NativeMethods.IsWindow(process.MainWindowHandle))
                {
                    return new WindowMatch(process.Id, process.MainWindowHandle);
                }
            }
            finally
            {
                process.Dispose();
            }
        }

        return null;
    }

    public static WindowMatch? WaitForNewProcessWindow(string expectedProcessName, IReadOnlySet<IntPtr> existingWindowHandles, int timeoutMs)
    {
        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.ElapsedMilliseconds < timeoutMs)
        {
            foreach (var window in EnumerateVisibleTopLevelWindows(expectedProcessName))
            {
                if (!existingWindowHandles.Contains(window.WindowHandle))
                {
                    return window;
                }
            }

            Thread.Sleep(50);
        }

        return null;
    }

    public static ForegroundWindowInfo? GetForegroundWindowInfo()
    {
        var windowHandle = NativeMethods.GetForegroundWindow();
        if (windowHandle == IntPtr.Zero || !NativeMethods.IsWindow(windowHandle))
        {
            return null;
        }

        NativeMethods.GetWindowThreadProcessId(windowHandle, out var processId);
        if (processId == 0)
        {
            return null;
        }

        try
        {
            using var process = Process.GetProcessById((int)processId);
            return new ForegroundWindowInfo(process.Id, process.ProcessName, windowHandle);
        }
        catch
        {
            return null;
        }
    }

    public static List<int> FindMatchingProcessIds(LaunchMatchSpec spec)
    {
        var matchingProcessIds = new List<int>();

        foreach (var process in Process.GetProcessesByName(spec.ProcessName))
        {
            try
            {
                var commandLine = ProcessCommandLineReader.TryGetCommandLine(process.Id);
                if (!string.IsNullOrWhiteSpace(commandLine) && spec.CommandLineMatcher(commandLine))
                {
                    matchingProcessIds.Add(process.Id);
                }
            }
            finally
            {
                process.Dispose();
            }
        }

        return matchingProcessIds;
    }

    public static List<int> WaitForMatchingProcessIds(LaunchMatchSpec spec, int timeoutMs)
    {
        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.ElapsedMilliseconds < timeoutMs)
        {
            var matched = FindMatchingProcessIds(spec);
            if (matched.Count > 0)
            {
                return matched;
            }

            Thread.Sleep(50);
        }

        return new List<int>();
    }

    public static WindowMatch? WaitForWindowForMatchingProcessIds(LaunchMatchSpec spec, int timeoutMs)
    {
        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.ElapsedMilliseconds < timeoutMs)
        {
            var window = FindWindowForMatchingProcesses(spec);
            if (window != null)
            {
                return window;
            }

            Thread.Sleep(50);
        }

        return null;
    }

    public static WindowMatch? FindWindowForMatchingProcesses(LaunchMatchSpec spec)
    {
        foreach (var process in Process.GetProcessesByName(spec.ProcessName))
        {
            try
            {
                var commandLine = ProcessCommandLineReader.TryGetCommandLine(process.Id);
                if (string.IsNullOrWhiteSpace(commandLine) || !spec.CommandLineMatcher(commandLine))
                {
                    continue;
                }

                process.Refresh();
                if (process.MainWindowHandle != IntPtr.Zero)
                {
                    return new WindowMatch(process.Id, process.MainWindowHandle);
                }
            }
            finally
            {
                process.Dispose();
            }
        }

        return null;
    }

    public static WindowMatch? WaitForWindowForProcessIds(string expectedProcessName, IReadOnlyCollection<int> matchingProcessIds, int timeoutMs)
    {
        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.ElapsedMilliseconds < timeoutMs)
        {
            var window = FindWindowForProcessIds(expectedProcessName, matchingProcessIds);
            if (window != null)
            {
                return window;
            }

            Thread.Sleep(50);
        }

        return null;
    }

    public static WindowMatch? FindWindowForProcessIds(string expectedProcessName, IReadOnlyCollection<int> matchingProcessIds)
    {
        if (matchingProcessIds.Count == 0)
        {
            return null;
        }

        foreach (var process in Process.GetProcessesByName(expectedProcessName))
        {
            try
            {
                process.Refresh();
                if (process.MainWindowHandle == IntPtr.Zero)
                {
                    continue;
                }

                if (matchingProcessIds.Contains(process.Id))
                {
                    return new WindowMatch(process.Id, process.MainWindowHandle);
                }
            }
            finally
            {
                process.Dispose();
            }
        }

        return null;
    }

    public static WindowMatch? WaitForForegroundProcessWindow(string expectedProcessName, ForegroundWindowInfo? initialForeground, int timeoutMs)
    {
        var stopwatch = Stopwatch.StartNew();
        var acceptSameWindow = initialForeground == null || !string.Equals(initialForeground.ProcessName, expectedProcessName, StringComparison.OrdinalIgnoreCase);

        while (stopwatch.ElapsedMilliseconds < timeoutMs)
        {
            var foreground = GetForegroundWindowInfo();
            if (foreground != null && string.Equals(foreground.ProcessName, expectedProcessName, StringComparison.OrdinalIgnoreCase))
            {
                if (acceptSameWindow ||
                    foreground.ProcessId != initialForeground?.ProcessId ||
                    foreground.WindowHandle != initialForeground.WindowHandle)
                {
                    return new WindowMatch(foreground.ProcessId, foreground.WindowHandle);
                }
            }

            Thread.Sleep(50);
        }

        return null;
    }

    public static string FormatProcessIds(IReadOnlyList<int> processIds)
    {
        return processIds.Count == 0
            ? string.Empty
            : string.Join(",", processIds.OrderBy(processId => processId));
    }
}
