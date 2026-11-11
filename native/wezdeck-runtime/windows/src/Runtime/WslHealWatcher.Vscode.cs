using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Text;
using System.Text.Json;

namespace WezDeck.Runtime;

// VS Code Remote-WSL reconnect after package upgrade.
internal sealed partial class WslHealWatcher
{
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

}
