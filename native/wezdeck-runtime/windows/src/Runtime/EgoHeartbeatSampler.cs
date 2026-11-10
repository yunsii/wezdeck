using System.Diagnostics;
using System.Text.Json;

namespace WezDeck.Runtime;

/// <summary>
/// Keeps <c>state/browser-agent/status.json</c> fresh while <c>backend=ego</c>
/// so the WezTerm right-status badge does not flip to <c>Ego·?</c> after the
/// Lua <c>ego_heartbeat_timeout_ms</c> (default 120s) with ego still running.
/// Event writers (apply / Alt+b / ego-browser CLI) remain authoritative for
/// backend switches; this sampler only refreshes <c>ego.alive</c> + timestamps
/// when the file already says <c>backend=ego</c>.
/// </summary>
internal static class EgoHeartbeatSampler
{
    // Well under Lua's 120s stale threshold; avoid rewriting every 1s helper tick.
    private const int RefreshIntervalMs = 30_000;

    private static readonly object Gate = new();
    private static long lastWriteAtMs;
    private static bool? lastAlive;
    private static bool loggedMissingPath;
    private static bool loggedMalformed;

    public static void Tick(StructuredLogger logger, string? statusFile)
    {
        if (string.IsNullOrWhiteSpace(statusFile))
        {
            return;
        }

        if (!File.Exists(statusFile))
        {
            if (!loggedMissingPath)
            {
                logger.Info("browser_agent", "ego heartbeat skipped: status file missing", new Dictionary<string, string?>
                {
                    ["status_file"] = statusFile,
                });
                loggedMissingPath = true;
            }
            return;
        }

        loggedMissingPath = false;

        string json;
        try
        {
            json = File.ReadAllText(statusFile);
        }
        catch (Exception ex)
        {
            logger.Warn("browser_agent", "ego heartbeat failed to read status", new Dictionary<string, string?>
            {
                ["status_file"] = statusFile,
                ["error"] = ex.Message,
            });
            return;
        }

        string backend;
        string exe;
        try
        {
            using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
            var root = doc.RootElement;
            backend = root.TryGetProperty("backend", out var b) && b.ValueKind == JsonValueKind.String
                ? (b.GetString() ?? string.Empty)
                : string.Empty;
            exe = string.Empty;
            if (root.TryGetProperty("ego", out var egoEl) &&
                egoEl.ValueKind == JsonValueKind.Object &&
                egoEl.TryGetProperty("exe", out var exeEl) &&
                exeEl.ValueKind == JsonValueKind.String)
            {
                exe = exeEl.GetString() ?? string.Empty;
            }
        }
        catch (Exception ex)
        {
            if (!loggedMalformed)
            {
                logger.Warn("browser_agent", "ego heartbeat skipped: malformed status json", new Dictionary<string, string?>
                {
                    ["status_file"] = statusFile,
                    ["error"] = ex.Message,
                });
                loggedMalformed = true;
            }
            return;
        }

        loggedMalformed = false;

        if (!string.Equals(backend, "ego", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        var alive = IsEgoAlive();
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var force = lastAlive is null || lastAlive.Value != alive;
        var due = now - Volatile.Read(ref lastWriteAtMs) >= RefreshIntervalMs;
        if (!force && !due)
        {
            return;
        }

        if (string.IsNullOrWhiteSpace(exe))
        {
            exe = @"C:\Program Files\Citro Labs\ego lite\Application\ego.exe";
        }

        lock (Gate)
        {
            // Re-check under lock so concurrent ticks do not double-write.
            now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            force = lastAlive is null || lastAlive.Value != alive;
            due = now - lastWriteAtMs >= RefreshIntervalMs;
            if (!force && !due)
            {
                return;
            }

            try
            {
                WriteStatus(statusFile, alive, exe, now);
                lastWriteAtMs = now;
                var prev = lastAlive;
                lastAlive = alive;
                if (force)
                {
                    logger.Info("browser_agent", "ego heartbeat wrote status", new Dictionary<string, string?>
                    {
                        ["status_file"] = statusFile,
                        ["alive"] = alive ? "1" : "0",
                        ["prev_alive"] = prev is null ? "unset" : (prev.Value ? "1" : "0"),
                        ["reason"] = "alive_changed",
                    });
                }
            }
            catch (Exception ex)
            {
                logger.Warn("browser_agent", "ego heartbeat failed to write status", new Dictionary<string, string?>
                {
                    ["status_file"] = statusFile,
                    ["error"] = ex.Message,
                });
            }
        }
    }

    private static bool IsEgoAlive()
    {
        try
        {
            var procs = Process.GetProcessesByName("ego");
            try
            {
                return procs.Length > 0;
            }
            finally
            {
                foreach (var p in procs)
                {
                    p.Dispose();
                }
            }
        }
        catch
        {
            return false;
        }
    }

    private static void WriteStatus(string statusFile, bool alive, string exe, long nowMs)
    {
        // Match scripts/runtime/browser-agent-status-lib.sh schema.
        var escapedExe = JsonSerializer.Serialize(exe);
        var body =
            "{\n" +
            "  \"backend\": \"ego\",\n" +
            $"  \"updated_at_ms\": {nowMs},\n" +
            "  \"ego\": {\n" +
            $"    \"alive\": {(alive ? "true" : "false")},\n" +
            $"    \"updated_at_ms\": {nowMs},\n" +
            $"    \"exe\": {escapedExe}\n" +
            "  }\n" +
            "}\n";
        FileSystemUtil.EnsureDirectory(Path.GetDirectoryName(statusFile));
        FileSystemUtil.WriteAtomicTextFile(statusFile, body);
    }
}
