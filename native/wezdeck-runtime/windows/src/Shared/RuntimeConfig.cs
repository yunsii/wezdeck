using System.Text;
using System.Text.Json;

namespace WezDeck.Runtime;

internal sealed class RuntimeConfig
{
    public required string ConfigHash { get; init; }
    public required string RuntimeDir { get; init; }
    public required string StatePath { get; init; }
    public string? WindowCachePath { get; init; }
    public required string IpcEndpoint { get; init; }
    public int HttpPort { get; init; } = 35791;
    public List<string> HttpAllowedOrigins { get; init; } = new();
    public string? ChromeDebugStatePath { get; init; }
    public ChromeDebugAutoStartConfig? ChromeDebugAutoStart { get; init; }
    /// <summary>
    /// Path to <c>state/browser-agent/status.json</c>. When set, the helper
    /// heartbeat refreshes ego.alive while backend=ego (see EgoHeartbeatSampler).
    /// </summary>
    public string? BrowserAgentStatusPath { get; init; }
    public required DiagnosticConfig Diagnostics { get; init; }
    public string? ClipboardOutputDir { get; init; }
    public string? ClipboardWslDistro { get; init; }
    public int ClipboardImageReadRetryCount { get; init; }
    public int ClipboardImageReadRetryDelayMs { get; init; }
    public int ClipboardCleanupMaxAgeHours { get; init; }
    public int ClipboardCleanupMaxFiles { get; init; }
    public int HeartbeatIntervalMs { get; init; }
    public ForegroundSamplingConfig? ForegroundSampling { get; init; }
    public WslHealConfig? WslHeal { get; init; }

    public static RuntimeConfig Load(string path)
    {
        var json = File.ReadAllText(path, new UTF8Encoding(false));
        var parsed = JsonSerializer.Deserialize<RuntimeConfig>(json, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        }) ?? throw new InvalidOperationException("config file was empty");

        if (string.IsNullOrWhiteSpace(parsed.RuntimeDir) ||
            string.IsNullOrWhiteSpace(parsed.ConfigHash) ||
            string.IsNullOrWhiteSpace(parsed.StatePath) ||
            string.IsNullOrWhiteSpace(parsed.IpcEndpoint))
        {
            throw new InvalidOperationException("config file is missing required paths");
        }

        return new RuntimeConfig
        {
            ConfigHash = parsed.ConfigHash,
            RuntimeDir = parsed.RuntimeDir,
            StatePath = parsed.StatePath,
            WindowCachePath = ResolveWindowCachePath(parsed.WindowCachePath),
            IpcEndpoint = parsed.IpcEndpoint,
            HttpPort = parsed.HttpPort > 0 ? parsed.HttpPort : 35791,
            HttpAllowedOrigins = parsed.HttpAllowedOrigins ?? new List<string>(),
            ChromeDebugStatePath = string.IsNullOrWhiteSpace(parsed.ChromeDebugStatePath) ? null : parsed.ChromeDebugStatePath,
            ChromeDebugAutoStart = parsed.ChromeDebugAutoStart,
            BrowserAgentStatusPath = string.IsNullOrWhiteSpace(parsed.BrowserAgentStatusPath)
                ? null
                : parsed.BrowserAgentStatusPath,
            Diagnostics = parsed.Diagnostics,
            ClipboardOutputDir = ResolveClipboardOutputDir(parsed.ClipboardOutputDir),
            ClipboardWslDistro = parsed.ClipboardWslDistro,
            ClipboardImageReadRetryCount = parsed.ClipboardImageReadRetryCount,
            ClipboardImageReadRetryDelayMs = parsed.ClipboardImageReadRetryDelayMs,
            ClipboardCleanupMaxAgeHours = parsed.ClipboardCleanupMaxAgeHours,
            ClipboardCleanupMaxFiles = parsed.ClipboardCleanupMaxFiles,
            HeartbeatIntervalMs = parsed.HeartbeatIntervalMs,
            ForegroundSampling = parsed.ForegroundSampling,
            WslHeal = NormalizeWslHeal(parsed.WslHeal, parsed.RuntimeDir),
        };
    }

    private static WslHealConfig? NormalizeWslHeal(WslHealConfig? parsed, string runtimeDir)
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var defaultRoot = string.IsNullOrWhiteSpace(localAppData)
            ? Path.Combine(runtimeDir, "state", "wsl-heal")
            : Path.Combine(localAppData, "wezterm-runtime", "state", "wsl-heal");

        // Default-on: upgrade heal is the recovery path users expect after MSI
        // auto-updates. Explicit wslHeal.enabled=false still disables.
        var enabled = parsed?.Enabled ?? true;
        var statusPath = string.IsNullOrWhiteSpace(parsed?.StatusPath)
            ? Path.Combine(defaultRoot, "status.json")
            : parsed!.StatusPath!;
        var historyPath = string.IsNullOrWhiteSpace(parsed?.HistoryPath)
            ? Path.Combine(defaultRoot, "history.ndjson")
            : parsed!.HistoryPath!;
        var suppressPath = string.IsNullOrWhiteSpace(parsed?.SuppressUntilPath)
            ? Path.Combine(defaultRoot, "suppress-until")
            : parsed!.SuppressUntilPath!;

        return new WslHealConfig
        {
            Enabled = enabled,
            StatusPath = statusPath,
            HistoryPath = historyPath,
            SuppressUntilPath = suppressPath,
            WezTermPath = string.IsNullOrWhiteSpace(parsed?.WezTermPath) ? null : parsed!.WezTermPath,
            RelaunchWezTerm = parsed?.RelaunchWezTerm ?? true,
            ProbeIntervalMs = parsed?.ProbeIntervalMs > 0 ? parsed.ProbeIntervalMs : 15_000,
            ProbeTimeoutMs = parsed?.ProbeTimeoutMs > 0 ? parsed.ProbeTimeoutMs : 8_000,
            EvidenceQueryIntervalMs = parsed?.EvidenceQueryIntervalMs > 0 ? parsed.EvidenceQueryIntervalMs : 30_000,
            UpdateEvidenceWindowMs = parsed?.UpdateEvidenceWindowMs > 0 ? parsed.UpdateEvidenceWindowMs : 600_000,
            CooldownMs = parsed?.CooldownMs > 0 ? parsed.CooldownMs : 600_000,
            HistoryMaxLines = parsed?.HistoryMaxLines > 0 ? parsed.HistoryMaxLines : 500,
        };
    }

    private static string ResolveClipboardOutputDir(string? configuredPath)
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(localAppData))
        {
            throw new InvalidOperationException("LocalApplicationData was unavailable for clipboard exports");
        }

        var fallbackPath = Path.Combine(localAppData, "wezterm-runtime", "state", "clipboard", "exports");
        if (string.IsNullOrWhiteSpace(configuredPath))
        {
            return fallbackPath;
        }

        if (!Path.IsPathRooted(configuredPath))
        {
            return fallbackPath;
        }

        return Path.GetFullPath(configuredPath);
    }

    private static string ResolveWindowCachePath(string? configuredPath)
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(localAppData))
        {
            throw new InvalidOperationException("LocalApplicationData was unavailable for helper window cache");
        }

        var fallbackPath = Path.Combine(localAppData, "wezterm-runtime", "cache", "helper", "window-cache.json");
        if (string.IsNullOrWhiteSpace(configuredPath))
        {
            return fallbackPath;
        }

        if (!Path.IsPathRooted(configuredPath))
        {
            return fallbackPath;
        }

        return Path.GetFullPath(configuredPath);
    }
}

internal sealed class ChromeDebugAutoStartConfig
{
    public bool Enabled { get; init; }
    public string? ChromePath { get; init; }
    public int RemoteDebuggingPort { get; init; }
    public string? UserDataDir { get; init; }
}

internal sealed class DiagnosticConfig
{
    public bool Enabled { get; init; }
    public bool CategoryEnabled { get; init; }
    public string Level { get; init; } = "info";
    public string? FilePath { get; init; }
    public int MaxBytes { get; init; }
    public int MaxFiles { get; init; }
}

internal sealed class ForegroundSamplingConfig
{
    /// <summary>off | allowlist | all. Default allowlist when unset.</summary>
    public string? Mode { get; init; }
    public List<string>? Allowlist { get; init; }
}

/// <summary>
/// Auto-heal after WSL package upgrades. See WslHealWatcher and
/// docs/development-environment-troubleshooting.md#wsl-upgrade-heal.
/// </summary>
internal sealed class WslHealConfig
{
    public bool Enabled { get; init; } = true;
    public string? StatusPath { get; init; }
    public string? HistoryPath { get; init; }
    public string? SuppressUntilPath { get; init; }
    public string? WezTermPath { get; init; }
    public bool RelaunchWezTerm { get; init; } = true;
    public int ProbeIntervalMs { get; init; } = 15_000;
    public int ProbeTimeoutMs { get; init; } = 8_000;
    public int EvidenceQueryIntervalMs { get; init; } = 30_000;
    public int UpdateEvidenceWindowMs { get; init; } = 600_000;
    public int CooldownMs { get; init; } = 600_000;
    public int HistoryMaxLines { get; init; } = 500;
}
