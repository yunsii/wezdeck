namespace WezTerm.WindowsHostHelper;

internal readonly record struct ImeStateSample(string Mode, string? Lang, string? Reason, string DecisionPath);

internal static class ImeStateSampler
{
    public static ImeStateSample Sample()
    {
        var foreground = WindowQuery.GetForegroundWindowInfo();
        if (foreground is null)
        {
            return new ImeStateSample("unknown", null, "no_foreground", "no_foreground");
        }

        // The right-status badge belongs to WezTerm. Sampling another
        // foreground app (for example a Chinese editor) would leak that
        // app's IME mode into every WezTerm window for one heartbeat.
        if (!string.Equals(foreground.ProcessName, "wezterm-gui", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(foreground.ProcessName, "wezterm", StringComparison.OrdinalIgnoreCase))
        {
            return new ImeStateSample("unknown", null, "foreground_not_wezterm", "foreground_not_wezterm");
        }

        var hwnd = foreground.WindowHandle;

        var threadId = NativeMethods.GetWindowThreadProcessId(hwnd, out _);
        var hkl = NativeMethods.GetKeyboardLayout(threadId);
        var langId = (int)(hkl.ToInt64() & 0xFFFF);
        var primaryLang = langId & 0x3FF;
        var langTag = FormatLangTag(langId);

        if (!IsCjkPrimaryLanguage(primaryLang))
        {
            return new ImeStateSample("en", langTag, null, "non_cjk");
        }

        var imeWnd = NativeMethods.ImmGetDefaultIMEWnd(hwnd);
        if (imeWnd == IntPtr.Zero)
        {
            return new ImeStateSample("unknown", langTag, "ime_wnd_null", "ime_wnd_null");
        }

        var openStatus = NativeMethods.SendMessage(imeWnd, NativeMethods.WmImeControl, (IntPtr)NativeMethods.ImcGetOpenStatus, IntPtr.Zero).ToInt64();
        var conversionMode = NativeMethods.SendMessage(imeWnd, NativeMethods.WmImeControl, (IntPtr)NativeMethods.ImcGetConversionMode, IntPtr.Zero).ToInt64();

        string mode;
        if (openStatus == 0)
        {
            mode = "alpha";
        }
        else if ((conversionMode & NativeMethods.ImeCmodeNative) != 0)
        {
            mode = "native";
        }
        else
        {
            mode = "alpha";
        }

        return new ImeStateSample(mode, langTag, null, mode);
    }

    private static bool IsCjkPrimaryLanguage(int primaryLang)
    {
        return primaryLang == 0x04 || primaryLang == 0x11 || primaryLang == 0x12;
    }

    private static string FormatLangTag(int langId)
    {
        return langId switch
        {
            0x0409 => "en-US",
            0x0809 => "en-GB",
            0x0804 => "zh-CN",
            0x0404 => "zh-TW",
            0x0C04 => "zh-HK",
            0x1004 => "zh-SG",
            0x0411 => "ja-JP",
            0x0412 => "ko-KR",
            _ => $"0x{langId:X4}",
        };
    }
}
