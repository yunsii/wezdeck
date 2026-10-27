using System.Diagnostics;

namespace WezDeck.Runtime;

internal static class WindowActivator
{
    public static bool TryCloseWindow(WindowMatch window)
    {
        if (window.WindowHandle == IntPtr.Zero || !NativeMethods.IsWindow(window.WindowHandle))
        {
            return false;
        }

        return NativeMethods.PostMessage(window.WindowHandle, NativeMethods.WmClose, IntPtr.Zero, IntPtr.Zero);
    }

    public static void LaunchDetachedProcess(string executable, IReadOnlyList<string> arguments)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            UseShellExecute = true,
            WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        };

        foreach (var item in arguments)
        {
            startInfo.ArgumentList.Add(item);
        }

        using var process = Process.Start(startInfo) ?? throw new InvalidOperationException($"failed to launch {executable}");
    }

    public static bool TryActivateWindow(WindowMatch window)
    {
        if (window.WindowHandle == IntPtr.Zero || !NativeMethods.IsWindow(window.WindowHandle))
        {
            return false;
        }

        // Sync ShowWindow first so a minimized / not-yet-shown window is
        // restored before we fight the foreground lock. Async alone left the
        // taskbar flashing while the window stayed in the background.
        var showCode = NativeMethods.IsIconic(window.WindowHandle) ? 9 : 5;
        NativeMethods.ShowWindow(window.WindowHandle, showCode);
        NativeMethods.ShowWindowAsync(window.WindowHandle, showCode);

        var foregroundWindow = NativeMethods.GetForegroundWindow();
        var foregroundThreadId = foregroundWindow == IntPtr.Zero
            ? 0
            : NativeMethods.GetWindowThreadProcessId(foregroundWindow, out _);
        var targetThreadId = NativeMethods.GetWindowThreadProcessId(window.WindowHandle, out _);
        var currentThreadId = NativeMethods.GetCurrentThreadId();

        var attachedToForeground = false;
        var attachedToTarget = false;
        try
        {
            if (foregroundThreadId != 0 && foregroundThreadId != currentThreadId)
            {
                attachedToForeground = NativeMethods.AttachThreadInput(currentThreadId, foregroundThreadId, true);
            }

            if (targetThreadId != 0 && targetThreadId != currentThreadId)
            {
                attachedToTarget = NativeMethods.AttachThreadInput(currentThreadId, targetThreadId, true);
            }

            // Unlock + synthetic Alt + SwitchToThisWindow: the helper is almost
            // never the foreground process (WezTerm owns the hotkey), so plain
            // SetForegroundWindow only flashes the taskbar. These three together
            // are the durable workaround on current Windows.
            NativeMethods.LockSetForegroundWindow(NativeMethods.LsfwUnlock);
            NativeMethods.AllowSetForegroundWindow(NativeMethods.AsfwAny);
            NativeMethods.BringWindowToTop(window.WindowHandle);
            NativeMethods.SetActiveWindow(window.WindowHandle);
            NativeMethods.SetFocus(window.WindowHandle);
            NativeMethods.SendAltKeyTap();
            NativeMethods.SwitchToThisWindow(window.WindowHandle, true);
            if (NativeMethods.SetForegroundWindow(window.WindowHandle)
                && WaitForWindowForeground(window.WindowHandle, 200))
            {
                return true;
            }

            // SetForeground often returns false under the lock; still give
            // SwitchToThisWindow a short settle before declaring failure.
            if (WaitForWindowForeground(window.WindowHandle, 150))
            {
                return true;
            }
        }
        finally
        {
            if (attachedToTarget)
            {
                NativeMethods.AttachThreadInput(currentThreadId, targetThreadId, false);
            }

            if (attachedToForeground)
            {
                NativeMethods.AttachThreadInput(currentThreadId, foregroundThreadId, false);
            }
        }

        // Electron (VS Code) MainWindowHandle is one arbitrary window among
        // many. Only fall back to it when it is a different hwnd — and only as
        // a last resort after the aimed hwnd refused activation.
        var processMainWindow = NativeMethods.TryGetProcessMainWindow(window.ProcessId);
        if (processMainWindow != IntPtr.Zero
            && processMainWindow != window.WindowHandle
            && TryActivateWindowOnce(new WindowMatch(window.ProcessId, processMainWindow)))
        {
            return true;
        }

        return TryActivateWindowOnce(window);
    }

    // Single-pass activate without the MainWindowHandle recursion, used by the
    // fallback above so we cannot recurse forever on a stubborn process.
    private static bool TryActivateWindowOnce(WindowMatch window)
    {
        if (window.WindowHandle == IntPtr.Zero || !NativeMethods.IsWindow(window.WindowHandle))
        {
            return false;
        }

        var showCode = NativeMethods.IsIconic(window.WindowHandle) ? 9 : 5;
        NativeMethods.ShowWindow(window.WindowHandle, showCode);
        NativeMethods.LockSetForegroundWindow(NativeMethods.LsfwUnlock);
        NativeMethods.BringWindowToTop(window.WindowHandle);
        NativeMethods.SetActiveWindow(window.WindowHandle);
        NativeMethods.SetFocus(window.WindowHandle);
        NativeMethods.SendAltKeyTap();
        NativeMethods.SwitchToThisWindow(window.WindowHandle, true);
        if (!NativeMethods.SetForegroundWindow(window.WindowHandle))
        {
            // Do not burn 500ms when the OS already refused — the taskbar is
            // already flashing; a long wait only makes Alt+v feel stuck.
            return WaitForWindowForeground(window.WindowHandle, 100);
        }

        return WaitForWindowForeground(window.WindowHandle, 250);
    }

    private static bool WaitForWindowForeground(IntPtr windowHandle, int timeoutMs)
    {
        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.ElapsedMilliseconds < timeoutMs)
        {
            if (NativeMethods.GetForegroundWindow() == windowHandle)
            {
                return true;
            }

            Thread.Sleep(15);
        }

        return NativeMethods.GetForegroundWindow() == windowHandle;
    }
}
