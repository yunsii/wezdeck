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
internal sealed class WslHealWatcher
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

    private sealed record VscodeReconnectResult(bool Attempted, int Reconnected, int Skipped);

    private VscodeReconnectResult ReconnectVscodeWindows(long nowMs, UpdateEvidence evidence, string probeDetail)
    {
        if (instanceRegistry is null)
        {
            Decide(nowMs, "skip_vscode_no_registry", "instance registry unavailable", true, IsWezTermRunning(), evidence,
                extra: new Dictionary<string, string?> { ["probe_detail"] = probeDetail });
            return new VscodeReconnectResult(false, 0, 0);
        }

        var codeExe = ResolveVscodeCommand();
        if (string.IsNullOrWhiteSpace(codeExe))
        {
            Decide(nowMs, "error_vscode_path", "could not resolve VS Code CLI (code)", true, IsWezTermRunning(), evidence,
                extra: new Dictionary<string, string?> { ["probe_detail"] = probeDetail });
            return new VscodeReconnectResult(false, 0, 0);
        }

        // Prefer Code.exe process name; cache entries from Alt+v use "Code".
        var live = instanceRegistry.ListLiveWindows("vscode", "Code");
        if (live.Count == 0)
        {
            // Insiders / alternate process name.
            live = instanceRegistry.ListLiveWindows("vscode", "Code - Insiders");
        }

        if (live.Count == 0)
        {
            Decide(nowMs, "skip_vscode_no_live_windows",
                "no live VS Code windows in helper window-cache — nothing to reconnect",
                true, IsWezTermRunning(), evidence,
                extra: new Dictionary<string, string?> { ["probe_detail"] = probeDetail });
            return new VscodeReconnectResult(false, 0, 0);
        }

        var max = Math.Max(1, config.VscodeMaxWindows);
        var reconnected = 0;
        var skipped = 0;
        var keys = new List<string>();
        foreach (var item in live)
        {
            if (reconnected >= max)
            {
                skipped += 1;
                continue;
            }

            if (!TryParseVscodeCacheKey(item.Key, out var distro, out var path))
            {
                skipped += 1;
                LogInfo("vscode cache key unparseable", new Dictionary<string, string?>
                {
                    ["decision"] = "skip_vscode_bad_key",
                    ["launch_key"] = item.Key,
                });
                continue;
            }

            var folderUri = PathResolvers.BuildVscodeFolderUri(distro, path);
            try
            {
                // --reuse-window retargets the existing hwnd onto a fresh
                // Remote-WSL session for the same folder (forces reconnect).
                WindowActivator.LaunchDetachedProcess(
                    codeExe,
                    new[] { "--reuse-window", "--folder-uri", folderUri });
                // Activate so the user sees the reconnect, not a buried window.
                WindowActivator.TryActivateWindow(item.Window);
                reconnected += 1;
                keys.Add(item.Key);
                LogInfo("reconnected vscode remote window", new Dictionary<string, string?>
                {
                    ["decision"] = "reconnect_vscode_window",
                    ["launch_key"] = item.Key,
                    ["folder_uri"] = folderUri,
                    ["pid"] = item.Window.ProcessId.ToString(),
                    ["hwnd"] = item.Window.WindowHandle.ToInt64().ToString(),
                    ["evidence_at"] = evidence.AtIso,
                });
            }
            catch (Exception ex)
            {
                skipped += 1;
                logger.Warn("wsl_heal", "failed to reconnect vscode window", new Dictionary<string, string?>
                {
                    ["decision"] = "error_vscode_reconnect",
                    ["launch_key"] = item.Key,
                    ["folder_uri"] = folderUri,
                    ["error"] = ex.Message,
                });
            }
        }

        Decide(nowMs, reconnected > 0 ? "reconnect_vscode" : "skip_vscode_all_failed",
            reconnected > 0
                ? $"reconnected {reconnected} VS Code Remote-WSL window(s) after WSL package update"
                : "had live VS Code windows but none reconnected",
            true, IsWezTermRunning(), evidence,
            extra: new Dictionary<string, string?>
            {
                ["vscode_reconnected"] = reconnected.ToString(),
                ["vscode_skipped"] = skipped.ToString(),
                ["vscode_live"] = live.Count.ToString(),
                ["vscode_keys"] = string.Join(",", keys),
                ["vscode_command"] = codeExe,
                ["probe_detail"] = probeDetail,
                ["evidence_at"] = evidence.AtIso,
                ["evidence_summary"] = evidence.Summary,
            });

        return new VscodeReconnectResult(reconnected > 0, reconnected, skipped);
    }

    private static bool TryParseVscodeCacheKey(string key, out string distro, out string path)
    {
        distro = string.Empty;
        path = string.Empty;
        var split = key.IndexOf('|');
        if (split <= 0 || split >= key.Length - 1)
        {
            return false;
        }

        distro = key[..split].Trim();
        path = key[(split + 1)..].Trim();
        return !string.IsNullOrWhiteSpace(distro) && !string.IsNullOrWhiteSpace(path);
    }

    private string? ResolveVscodeCommand()
    {
        var configured = config.VscodeCommand?.Trim();
        if (!string.IsNullOrWhiteSpace(configured))
        {
            if (File.Exists(configured))
            {
                return configured;
            }

            // Bare "code" / "code.cmd" — let CreateProcess search PATH via shell.
            if (!configured.Contains('\\') && !configured.Contains('/'))
            {
                return configured;
            }
        }

        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        foreach (var candidate in new[]
                 {
                     Path.Combine(local, "Programs", "Microsoft VS Code", "bin", "code.cmd"),
                     Path.Combine(local, "Programs", "Microsoft VS Code", "Code.exe"),
                     Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft VS Code", "bin", "code.cmd"),
                 })
        {
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        return "code";
    }

    private bool ProbeWslOk(out string detail)
    {
        try
        {
            var start = new ProcessStartInfo
            {
                FileName = "wsl.exe",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            var distro = resolveDistro();
            if (!string.IsNullOrWhiteSpace(distro))
            {
                start.ArgumentList.Add("-d");
                start.ArgumentList.Add(distro);
            }
            start.ArgumentList.Add("--");
            start.ArgumentList.Add("echo");
            start.ArgumentList.Add("wezdeck-wsl-heal-ok");

            using var process = Process.Start(start);
            if (process is null)
            {
                detail = "wsl_start_null";
                return false;
            }

            if (!process.WaitForExit(config.ProbeTimeoutMs))
            {
                try { process.Kill(entireProcessTree: true); } catch { /* ignore */ }
                detail = "wsl_probe_timeout";
                return false;
            }

            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            if (process.ExitCode != 0)
            {
                detail = "wsl_exit_" + process.ExitCode + (string.IsNullOrWhiteSpace(stderr) ? "" : ":" + TrimOneLine(stderr));
                return false;
            }

            if (stdout.IndexOf("wezdeck-wsl-heal-ok", StringComparison.Ordinal) < 0)
            {
                detail = "wsl_unexpected_output:" + TrimOneLine(stdout);
                return false;
            }

            detail = "ok";
            return true;
        }
        catch (Exception ex)
        {
            detail = "wsl_probe_exception:" + TrimOneLine(ex.Message);
            return false;
        }
    }

    private UpdateEvidence? RefreshEvidenceIfNeeded(long nowMs, bool force)
    {
        var minGap = Math.Max(10_000, config.EvidenceQueryIntervalMs);
        if (!force && nowMs - lastEvidenceQueryAtMs < minGap && lastEvidence is not null)
        {
            return lastEvidence;
        }

        lastEvidenceQueryAtMs = nowMs;
        lastEvidence = QueryUpdateEvidence(nowMs);
        return lastEvidence;
    }

    private UpdateEvidence QueryUpdateEvidence(long nowMs)
    {
        var windowMs = Math.Max(60_000, config.UpdateEvidenceWindowMs);
        var since = DateTime.Now.AddMilliseconds(-windowMs);
        // Prefer System/WindowsUpdateClient (matches this host's 3.0.5 install).
        var fromWu = QueryWuEvidence(since);
        if (fromWu.Found)
        {
            return fromWu;
        }

        var fromMsi = QueryMsiEvidence(since);
        if (fromMsi.Found)
        {
            return fromMsi;
        }

        return new UpdateEvidence(false, null, null, "no WSL package update in window");
    }

    private static UpdateEvidence QueryWuEvidence(DateTime since)
    {
        // Filter time in-process: Event Log XPath SystemTime formatting is
        // brittle across locales; WU volume is low enough to scan recent rows.
        try
        {
            var query = new EventLogQuery(
                "System",
                PathType.LogName,
                "*[System[Provider[@Name='Microsoft-Windows-WindowsUpdateClient'] and (EventID=19 or EventID=43)]]")
            {
                ReverseDirection = true,
            };
            using var reader = new EventLogReader(query);
            var scanned = 0;
            for (var record = reader.ReadEvent(); record is not null && scanned < 80; record = reader.ReadEvent(), scanned++)
            {
                using (record)
                {
                    if (record.TimeCreated is DateTime created && created < since)
                    {
                        break;
                    }

                    string? message = null;
                    try { message = record.FormatDescription(); } catch { /* ignore */ }
                    if (string.IsNullOrWhiteSpace(message))
                    {
                        continue;
                    }

                    if (message.IndexOf("Windows Subsystem for Linux", StringComparison.OrdinalIgnoreCase) < 0
                        && message.IndexOf("wsl.", StringComparison.OrdinalIgnoreCase) < 0)
                    {
                        continue;
                    }

                    return new UpdateEvidence(
                        true,
                        record.TimeCreated?.ToLocalTime().ToString("yyyy-MM-ddTHH:mm:sszzz"),
                        "wu:" + record.Id,
                        TrimOneLine(message));
                }
            }
        }
        catch (Exception ex)
        {
            return new UpdateEvidence(false, null, null, "wu_query_error:" + TrimOneLine(ex.Message));
        }

        return new UpdateEvidence(false, null, null, "wu_none");
    }

    private static UpdateEvidence QueryMsiEvidence(DateTime since)
    {
        try
        {
            var query = new EventLogQuery(
                "Application",
                PathType.LogName,
                "*[System[Provider[@Name='MsiInstaller']]]")
            {
                ReverseDirection = true,
            };
            using var reader = new EventLogReader(query);
            var scanned = 0;
            for (var record = reader.ReadEvent(); record is not null && scanned < 120; record = reader.ReadEvent(), scanned++)
            {
                using (record)
                {
                    if (record.TimeCreated is DateTime created && created < since)
                    {
                        break;
                    }

                    string? message = null;
                    try { message = record.FormatDescription(); } catch { /* ignore */ }
                    if (string.IsNullOrWhiteSpace(message))
                    {
                        continue;
                    }

                    if (message.IndexOf("Windows Subsystem for Linux", StringComparison.OrdinalIgnoreCase) < 0)
                    {
                        continue;
                    }

                    return new UpdateEvidence(
                        true,
                        record.TimeCreated?.ToLocalTime().ToString("yyyy-MM-ddTHH:mm:sszzz"),
                        "msi:" + record.Id,
                        TrimOneLine(message));
                }
            }
        }
        catch (Exception ex)
        {
            return new UpdateEvidence(false, null, null, "msi_query_error:" + TrimOneLine(ex.Message));
        }

        return new UpdateEvidence(false, null, null, "msi_none");
    }

    private bool IsSuppressed(long nowMs, out long suppressUntilMs)
    {
        suppressUntilMs = 0;
        var path = config.SuppressUntilPath;
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return false;
        }

        try
        {
            var text = File.ReadAllText(path).Trim();
            if (long.TryParse(text, out var until) && until > nowMs)
            {
                suppressUntilMs = until;
                return true;
            }

            // ISO timestamp fallback
            if (DateTimeOffset.TryParse(text, out var dto) && dto.ToUnixTimeMilliseconds() > nowMs)
            {
                suppressUntilMs = dto.ToUnixTimeMilliseconds();
                return true;
            }
        }
        catch
        {
            // ignore malformed suppress file
        }

        return false;
    }

    private static bool IsWezTermRunning()
    {
        try
        {
            if (Process.GetProcessesByName("wezterm-gui").Length > 0)
            {
                return true;
            }

            return Process.GetProcessesByName("wezterm").Length > 0;
        }
        catch
        {
            return false;
        }
    }

    private string? ResolveWezTermGuiPath()
    {
        if (!string.IsNullOrWhiteSpace(config.WezTermPath) && File.Exists(config.WezTermPath))
        {
            return config.WezTermPath;
        }

        var candidates = new List<string>();
        var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        foreach (var root in new[] { pf, pf86, local })
        {
            if (string.IsNullOrWhiteSpace(root))
            {
                continue;
            }

            candidates.Add(Path.Combine(root, "WezTerm", "wezterm-gui.exe"));
            candidates.Add(Path.Combine(root, "Programs", "WezTerm", "wezterm-gui.exe"));
        }

        // This machine keeps WezTerm on E:\Program Files\WezTerm.
        foreach (var drive in Environment.GetLogicalDrives())
        {
            candidates.Add(Path.Combine(drive, "Program Files", "WezTerm", "wezterm-gui.exe"));
        }

        foreach (var path in candidates)
        {
            if (File.Exists(path))
            {
                return path;
            }
        }

        return null;
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
