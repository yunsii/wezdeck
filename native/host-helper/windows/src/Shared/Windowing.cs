namespace WezTerm.WindowsHostHelper;

internal sealed record WindowCacheEntry(int ProcessId, IntPtr WindowHandle, DateTime? ProcessStartTimeUtc, DateTime? LastUsedAtUtc);
internal sealed record WindowMatch(int ProcessId, IntPtr WindowHandle);
internal sealed record WindowReuseCandidate(string LaunchKey, WindowMatch Window, DateTime LastUsedAtUtc);
internal sealed record ForegroundWindowInfo(int ProcessId, string ProcessName, IntPtr WindowHandle);
internal sealed record PersistentWindowCacheEntry(int ProcessId, long WindowHandle, DateTime? ProcessStartTimeUtc, DateTime? LastUsedAtUtc = null);
internal sealed record LaunchMatchSpec(
    string InstanceType,
    string LaunchKey,
    string ProcessName,
    Func<string, bool> CommandLineMatcher,
    ReuseMode ReuseMode);
internal sealed record ReuseDecision(
    WindowMatch? Window,
    string Path,
    bool RegistryHit,
    int MatchedProcessCount,
    bool MatchedWindowFound,
    IReadOnlyList<int> MatchedProcessIds);

internal enum ReuseMode
{
    Strict,
    PreferReuse,
}
