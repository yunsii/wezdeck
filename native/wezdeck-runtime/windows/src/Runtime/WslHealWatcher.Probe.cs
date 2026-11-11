using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Text;
using System.Text.Json;

namespace WezDeck.Runtime;

// WSL probe, Event Log evidence, WezTerm path resolution.
internal sealed partial class WslHealWatcher
{
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

}
