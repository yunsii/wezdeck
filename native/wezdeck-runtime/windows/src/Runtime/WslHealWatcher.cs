using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Text;
using System.Text.Json;

namespace WezDeck.Runtime;

/// <summary>
/// Detects WSL package upgrades that tear down the guest, then conditionally
/// relaunches WezTerm. Distinguishes upgrade from user-initiated stop by
/// requiring Windows Update / MSI evidence in a recent time window.
///
/// Durable audit trail (always written, even when helper diagnostics are off):
///   state/wsl-heal/status.json     current phase + last decision
///   state/wsl-heal/history.ndjson  one row per decision / phase change
/// Structured rows also go to helper.log under category <c>wsl_heal</c> when
/// diagnostics are enabled.
///
/// Docs: docs/development-environment-troubleshooting.md#wsl-upgrade-heal
/// </summary>
internal sealed partial class WslHealWatcher
{
    private readonly StructuredLogger logger;
    private readonly WslHealConfig config;
    private readonly Func<string> resolveDistro;
    private readonly InstanceRegistry? instanceRegistry;
    private readonly object gate = new();

    private long lastProbeAtMs;
    private long lastEvidenceQueryAtMs;
    private long lastHealAtMs;
    private long lastDecisionAtMs;
    private bool? lastWslOk;
    private bool wezTermSeenRunning;
    private bool wslDownLatched;
    private string phase = "idle";
    private string lastDecision = "boot";
    private string lastDecisionDetail = string.Empty;
    private UpdateEvidence? lastEvidence;
    private bool loggedDisabled;

    public WslHealWatcher(
        StructuredLogger logger,
        WslHealConfig config,
        Func<string> resolveDistro,
        InstanceRegistry? instanceRegistry = null)
    {
        this.logger = logger;
        this.config = config;
        this.resolveDistro = resolveDistro;
        this.instanceRegistry = instanceRegistry;
    }

    public void Tick()
    {
        if (!config.Enabled)
        {
            if (!loggedDisabled)
            {
                LogInfo("wsl heal disabled", new Dictionary<string, string?>
                {
                    ["decision"] = "disabled",
                });
                loggedDisabled = true;
            }
            return;
        }

        loggedDisabled = false;
        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (nowMs - lastProbeAtMs < Math.Max(3_000, config.ProbeIntervalMs))
        {
            return;
        }

        lastProbeAtMs = nowMs;

        lock (gate)
        {
            TickLocked(nowMs);
        }
    }

    private void TickLocked(long nowMs)
    {
        if (IsSuppressed(nowMs, out var suppressUntilMs))
        {
            Decide(nowMs, "suppressed", "suppress-until active",
                wslOk: lastWslOk, wezTermRunning: IsWezTermRunning(),
                evidence: lastEvidence, phaseOverride: "suppressed",
                extra: new Dictionary<string, string?>
                {
                    ["suppress_until_ms"] = suppressUntilMs.ToString(),
                });
            WriteStatus(nowMs);
            return;
        }

        var wezTermRunning = IsWezTermRunning();
        if (wezTermRunning)
        {
            wezTermSeenRunning = true;
        }

        var wslOk = ProbeWslOk(out var probeDetail);
        var evidence = RefreshEvidenceIfNeeded(nowMs, force: wslDownLatched || wslOk == false);

        if (wslOk == false && lastWslOk != false)
        {
            // First unhealthy sample (including helper boot) or true→false flip.
            wslDownLatched = true;
            phase = "down";
            var downDecision = lastWslOk is null ? "probe_down_initial" : "latch_down";
            lastDecision = downDecision;
            lastDecisionDetail = probeDetail;
            lastDecisionAtMs = nowMs;
            LogInfo("wsl probe unhealthy", new Dictionary<string, string?>
            {
                ["decision"] = downDecision,
                ["probe_detail"] = probeDetail,
                ["wezterm_running"] = wezTermRunning ? "1" : "0",
                ["wezterm_seen"] = wezTermSeenRunning ? "1" : "0",
                ["update_evidence"] = evidence?.Found == true ? "1" : "0",
                ["evidence_summary"] = evidence?.Summary,
            });
            AppendHistory(nowMs, downDecision, probeDetail, wslOk, wezTermRunning, evidence);
        }

        if (wslOk == true && lastWslOk != true)
        {
            var okDecision = lastWslOk is null ? "probe_ok_initial" : "probe_recovered";
            lastDecision = okDecision;
            lastDecisionDetail = probeDetail;
            lastDecisionAtMs = nowMs;
            LogInfo("wsl probe healthy", new Dictionary<string, string?>
            {
                ["decision"] = okDecision,
                ["probe_detail"] = probeDetail,
                ["wezterm_running"] = wezTermRunning ? "1" : "0",
                ["wezterm_seen"] = wezTermSeenRunning ? "1" : "0",
                ["wsl_down_latched"] = wslDownLatched ? "1" : "0",
                ["update_evidence"] = evidence?.Found == true ? "1" : "0",
            });
            AppendHistory(nowMs, okDecision, probeDetail, wslOk, wezTermRunning, evidence);
        }

        if (wslDownLatched && wslOk == true)
        {
            TryRecover(nowMs, wezTermRunning, evidence, probeDetail);
            wslDownLatched = false;
        }
        else if (wslOk == true)
        {
            phase = wezTermRunning || !wezTermSeenRunning ? "idle" : phase;
        }
        else if (wslOk == false)
        {
            phase = "down";
        }

        lastWslOk = wslOk;
        WriteStatus(nowMs, wslOk, wezTermRunning, probeDetail);
    }

    private void TryRecover(long nowMs, bool wezTermRunning, UpdateEvidence? evidence, string probeDetail)
    {
        phase = "recovering";

        if (nowMs - lastHealAtMs < Math.Max(60_000, config.CooldownMs))
        {
            Decide(nowMs, "skip_cooldown", "heal cooldown active", true, wezTermRunning, evidence,
                extra: new Dictionary<string, string?>
                {
                    ["cooldown_ms"] = config.CooldownMs.ToString(),
                    ["last_heal_at_ms"] = lastHealAtMs > 0 ? lastHealAtMs.ToString() : null,
                    ["probe_detail"] = probeDetail,
                });
            return;
        }

        if (evidence?.Found != true)
        {
            Decide(nowMs, "skip_no_update_evidence",
                "WSL recovered but no recent WSL package update evidence — treating as user/manual stop",
                true, wezTermRunning, evidence,
                extra: new Dictionary<string, string?>
                {
                    ["evidence_window_ms"] = config.UpdateEvidenceWindowMs.ToString(),
                    ["probe_detail"] = probeDetail,
                    ["wezterm_running"] = wezTermRunning ? "1" : "0",
                });
            phase = "idle";
            return;
        }

        var didSomething = false;

        // VS Code often survives the upgrade with a dead Remote-WSL session —
        // reconnect even when WezTerm is still up.
        if (config.ReconnectVscode)
        {
            var vscodeResult = ReconnectVscodeWindows(nowMs, evidence, probeDetail);
            if (vscodeResult.Attempted)
            {
                didSomething = true;
            }
        }
        else
        {
            Decide(nowMs, "skip_vscode_disabled", "reconnectVscode=false", true, wezTermRunning, evidence,
                extra: new Dictionary<string, string?> { ["probe_detail"] = probeDetail });
        }

        if (config.RelaunchWezTerm)
        {
            if (!wezTermSeenRunning)
            {
                Decide(nowMs, "skip_wezterm_never_seen",
                    "WezTerm was never observed running in this helper lifetime",
                    true, wezTermRunning, evidence,
                    extra: new Dictionary<string, string?> { ["probe_detail"] = probeDetail });
            }
            else if (wezTermRunning)
            {
                Decide(nowMs, "skip_wezterm_still_alive",
                    "WezTerm still running after WSL recovery — no relaunch",
                    true, wezTermRunning, evidence,
                    extra: new Dictionary<string, string?> { ["probe_detail"] = probeDetail });
            }
            else if (RelaunchWezTerm(nowMs, evidence, probeDetail))
            {
                didSomething = true;
            }
        }
        else
        {
            Decide(nowMs, "skip_relaunch_disabled", "relaunchWezTerm=false", true, wezTermRunning, evidence,
                extra: new Dictionary<string, string?> { ["probe_detail"] = probeDetail });
        }

        if (didSomething)
        {
            lastHealAtMs = nowMs;
            phase = "healed";
        }
        else
        {
            phase = "idle";
        }
    }

    private bool RelaunchWezTerm(long nowMs, UpdateEvidence evidence, string probeDetail)
    {
        var exe = ResolveWezTermGuiPath();
        if (string.IsNullOrWhiteSpace(exe) || !File.Exists(exe))
        {
            Decide(nowMs, "error_wezterm_path",
                "update evidence present but wezterm-gui.exe was not found",
                true, wezTermRunning: false, evidence,
                extra: new Dictionary<string, string?>
                {
                    ["wezterm_path"] = exe,
                    ["probe_detail"] = probeDetail,
                });
            return false;
        }

        try
        {
            WindowActivator.LaunchDetachedProcess(exe, Array.Empty<string>());
            Decide(nowMs, "relaunch_wezterm", "relaunched WezTerm after WSL package update",
                true, wezTermRunning: false, evidence,
                extra: new Dictionary<string, string?>
                {
                    ["wezterm_path"] = exe,
                    ["probe_detail"] = probeDetail,
                    ["evidence_at"] = evidence.AtIso,
                    ["evidence_summary"] = evidence.Summary,
                });
            return true;
        }
        catch (Exception ex)
        {
            Decide(nowMs, "error_relaunch", "failed to relaunch WezTerm",
                true, wezTermRunning: false, evidence,
                extra: new Dictionary<string, string?>
                {
                    ["wezterm_path"] = exe,
                    ["error"] = ex.Message,
                    ["probe_detail"] = probeDetail,
                });
            return false;
        }
    }

    private void Decide(
        long nowMs,
        string decision,
        string detail,
        bool? wslOk,
        bool wezTermRunning,
        UpdateEvidence? evidence,
        string? phaseOverride = null,
        IDictionary<string, string?>? extra = null)
    {
        // Avoid spamming identical skip decisions every probe while idle-healthy.
        if (string.Equals(decision, lastDecision, StringComparison.Ordinal)
            && nowMs - lastDecisionAtMs < Math.Max(30_000, config.ProbeIntervalMs * 2)
            && decision.StartsWith("skip_", StringComparison.Ordinal))
        {
            return;
        }

        lastDecision = decision;
        lastDecisionDetail = detail;
        lastDecisionAtMs = nowMs;
        if (!string.IsNullOrWhiteSpace(phaseOverride))
        {
            phase = phaseOverride!;
        }

        var fields = new Dictionary<string, string?>
        {
            ["decision"] = decision,
            ["detail"] = detail,
            ["phase"] = phase,
            ["wsl_ok"] = wslOk is null ? null : (wslOk.Value ? "1" : "0"),
            ["wezterm_running"] = wezTermRunning ? "1" : "0",
            ["wezterm_seen"] = wezTermSeenRunning ? "1" : "0",
            ["update_evidence"] = evidence?.Found == true ? "1" : "0",
            ["evidence_source"] = evidence?.Source,
            ["evidence_at"] = evidence?.AtIso,
            ["evidence_summary"] = evidence?.Summary,
        };
        if (extra is not null)
        {
            foreach (var kv in extra)
            {
                fields[kv.Key] = kv.Value;
            }
        }

        if (decision.StartsWith("error_", StringComparison.Ordinal))
        {
            logger.Warn("wsl_heal", detail, fields);
        }
        else
        {
            LogInfo(detail, fields);
        }

        AppendHistory(nowMs, decision, detail, wslOk, wezTermRunning, evidence);
    }

    private void LogInfo(string message, IDictionary<string, string?> fields) =>
        logger.Info("wsl_heal", message, fields);

    private void WriteStatus(long nowMs, bool? wslOk = null, bool? wezTermRunning = null, string? probeDetail = null)
    {
        var path = config.StatusPath;
        if (string.IsNullOrWhiteSpace(path))
        {
            return;
        }

        try
        {
            FileSystemUtil.EnsureDirectory(Path.GetDirectoryName(path));
            var payload = new Dictionary<string, object?>
            {
                ["version"] = 1,
                ["phase"] = phase,
                ["wsl_ok"] = wslOk ?? lastWslOk,
                ["wsl_down_latched"] = wslDownLatched,
                ["wezterm_running"] = wezTermRunning ?? IsWezTermRunning(),
                ["wezterm_seen"] = wezTermSeenRunning,
                ["last_decision"] = lastDecision,
                ["last_decision_detail"] = lastDecisionDetail,
                ["last_decision_at_ms"] = lastDecisionAtMs > 0 ? lastDecisionAtMs : null,
                ["last_heal_at_ms"] = lastHealAtMs > 0 ? lastHealAtMs : null,
                ["probe_detail"] = probeDetail,
                ["update_evidence"] = lastEvidence is null ? null : new Dictionary<string, object?>
                {
                    ["found"] = lastEvidence.Found,
                    ["at"] = lastEvidence.AtIso,
                    ["source"] = lastEvidence.Source,
                    ["summary"] = lastEvidence.Summary,
                },
                ["config"] = new Dictionary<string, object?>
                {
                    ["enabled"] = config.Enabled,
                    ["relaunch_wezterm"] = config.RelaunchWezTerm,
                    ["reconnect_vscode"] = config.ReconnectVscode,
                    ["vscode_max_windows"] = config.VscodeMaxWindows,
                    ["evidence_window_ms"] = config.UpdateEvidenceWindowMs,
                    ["cooldown_ms"] = config.CooldownMs,
                    ["probe_interval_ms"] = config.ProbeIntervalMs,
                },
                ["heartbeat_at_ms"] = nowMs,
                ["updated_at"] = DateTimeOffset.Now.ToString("yyyy-MM-ddTHH:mm:sszzz"),
            };
            var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions { WriteIndented = true });
            var tmp = path + ".tmp." + Environment.ProcessId;
            File.WriteAllText(tmp, json, new UTF8Encoding(false));
            File.Move(tmp, path, overwrite: true);
        }
        catch (Exception ex)
        {
            logger.Warn("wsl_heal", "failed to write status", new Dictionary<string, string?>
            {
                ["status_file"] = path,
                ["error"] = ex.Message,
            });
        }
    }

    private void AppendHistory(
        long nowMs,
        string decision,
        string detail,
        bool? wslOk,
        bool wezTermRunning,
        UpdateEvidence? evidence)
    {
        var path = config.HistoryPath;
        if (string.IsNullOrWhiteSpace(path))
        {
            return;
        }

        try
        {
            FileSystemUtil.EnsureDirectory(Path.GetDirectoryName(path));
            var line = JsonSerializer.Serialize(new Dictionary<string, object?>
            {
                ["ts"] = DateTimeOffset.Now.ToString("yyyy-MM-ddTHH:mm:sszzz"),
                ["ts_ms"] = nowMs,
                ["decision"] = decision,
                ["detail"] = detail,
                ["phase"] = phase,
                ["wsl_ok"] = wslOk,
                ["wezterm_running"] = wezTermRunning,
                ["wezterm_seen"] = wezTermSeenRunning,
                ["update_evidence"] = evidence?.Found,
                ["evidence_source"] = evidence?.Source,
                ["evidence_at"] = evidence?.AtIso,
                ["evidence_summary"] = evidence?.Summary,
            });
            File.AppendAllText(path, line + Environment.NewLine, new UTF8Encoding(false));
            TrimHistory(path, config.HistoryMaxLines);
        }
        catch
        {
            // History is best-effort; never break the helper tick.
        }
    }

    private static void TrimHistory(string path, int maxLines)
    {
        if (maxLines <= 0 || !File.Exists(path))
        {
            return;
        }

        var lines = File.ReadAllLines(path);
        if (lines.Length <= maxLines)
        {
            return;
        }

        var keep = lines.Skip(lines.Length - maxLines).ToArray();
        var tmp = path + ".trim." + Environment.ProcessId;
        File.WriteAllLines(tmp, keep, new UTF8Encoding(false));
        File.Move(tmp, path, overwrite: true);
    }

    private static string TrimOneLine(string value)
    {
        var one = value.Replace('\r', ' ').Replace('\n', ' ').Trim();
        return one.Length <= 220 ? one : one[..220];
    }

    private sealed record UpdateEvidence(bool Found, string? AtIso, string? Source, string? Summary);
}
