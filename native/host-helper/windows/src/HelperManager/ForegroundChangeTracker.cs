namespace WezTerm.WindowsHostHelper;

/// <summary>
/// Samples the OS foreground window on the helper heartbeat and logs only
/// when the foreground <see cref="ForegroundWindowInfo.ProcessName"/> changes.
/// No window titles — workflow forensics only.
/// Mode:
///   off       — never sample
///   allowlist — only when from/to process is in the allowlist (personal devices)
///   all       — every process-name change (work devices)
/// </summary>
internal sealed class ForegroundChangeTracker
{
    private static readonly string[] DefaultAllowlist =
    [
        "wezterm-gui",
        "wezterm",
        "Code",
        "chrome",
    ];

    private readonly StructuredLogger logger;
    private readonly string mode;
    private readonly HashSet<string> allowlist;
    private string? lastProcessName;
    private int lastProcessId;
    private long lastChangeAtMs;
    private bool seeded;

    public ForegroundChangeTracker(StructuredLogger logger, ForegroundSamplingConfig? config)
    {
        this.logger = logger;
        mode = NormalizeMode(config?.Mode);
        allowlist = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        IEnumerable<string> source = DefaultAllowlist;
        if (config?.Allowlist is { Count: > 0 } configured)
        {
            source = configured;
        }

        foreach (var name in source)
        {
            if (!string.IsNullOrWhiteSpace(name))
            {
                allowlist.Add(name.Trim());
            }
        }
    }

    public void Sample()
    {
        if (string.Equals(mode, "off", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        var info = WindowQuery.GetForegroundWindowInfo();
        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var processName = info?.ProcessName;
        if (string.IsNullOrWhiteSpace(processName))
        {
            processName = "unknown";
        }

        var processId = info?.ProcessId ?? 0;

        if (!seeded)
        {
            lastProcessName = processName;
            lastProcessId = processId;
            lastChangeAtMs = nowMs;
            seeded = true;
            return;
        }

        // Same app name: ignore pid/hwnd churn (browser multi-process, etc.).
        if (string.Equals(lastProcessName, processName, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        var fromName = lastProcessName ?? "unknown";
        var toName = processName;
        if (string.Equals(mode, "allowlist", StringComparison.OrdinalIgnoreCase)
            && !allowlist.Contains(fromName)
            && !allowlist.Contains(toName))
        {
            // Still advance state so dwell stays meaningful when we re-enter allowlist apps.
            lastProcessName = processName;
            lastProcessId = processId;
            lastChangeAtMs = nowMs;
            return;
        }

        var dwellMs = Math.Max(0, nowMs - lastChangeAtMs);
        logger.Info("foreground", "foreground changed", new Dictionary<string, string?>
        {
            ["from_process"] = fromName,
            ["to_process"] = toName,
            ["from_pid"] = lastProcessId.ToString(),
            ["to_pid"] = processId.ToString(),
            ["dwell_ms"] = dwellMs.ToString(),
            ["mode"] = mode,
        });

        lastProcessName = processName;
        lastProcessId = processId;
        lastChangeAtMs = nowMs;
    }

    private static string NormalizeMode(string? raw)
    {
        if (string.Equals(raw, "all", StringComparison.OrdinalIgnoreCase))
        {
            return "all";
        }

        if (string.Equals(raw, "off", StringComparison.OrdinalIgnoreCase))
        {
            return "off";
        }

        // Default personal-safe: WezTerm + VS Code + Chrome only.
        return "allowlist";
    }
}
