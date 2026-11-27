using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace WezDeck.Runtime;

internal sealed class SessionRequestHandler
{
    private readonly RuntimeConfig config;
    private readonly StructuredLogger logger;

    public SessionRequestHandler(RuntimeConfig config, StructuredLogger logger)
    {
        this.config = config;
        this.logger = logger;
    }

    public RequestOutcome Focus(JsonElement payload, string traceId)
    {
        var sessionId = RequestPayloadReader.RequireString(payload, "session_id");
        var recent = RequestPayloadReader.GetOptionalBool(payload, "recent");
        var archivedTs = RequestPayloadReader.GetOptionalPositiveLong(payload, "archived_ts");
        var entry = ReadSessionEntry(sessionId, recent, archivedTs);
        if (config.UseTerminalClient)
        {
            OpenTerminalClient(entry);
            logger.Info("attention", "web terminal client dispatched", new Dictionary<string, string?>
            {
                ["trace_id"] = traceId,
                ["session_id"] = sessionId,
            });
            return new RequestOutcome(
                Domain: "sessions",
                Action: "focus",
                Status: "dispatched",
                DecisionPath: "terminal_client",
                ResultType: "session_ref",
                Result: new { session_id = sessionId, recent });
        }
        var jumpPayload = BuildJumpPayload(sessionId, entry, recent, archivedTs, traceId);
        WriteAttentionJumpEvent(jumpPayload);

        logger.Info("attention", "web session focus dispatched", new Dictionary<string, string?>
        {
            ["trace_id"] = traceId,
            ["session_id"] = sessionId,
            ["recent"] = recent ? "1" : "0",
            ["archived_ts"] = archivedTs?.ToString(),
            ["decision_path"] = recent ? "attention_event_recent" : "attention_event_live",
        });

        return new RequestOutcome(
            Domain: "sessions",
            Action: "focus",
            Status: "dispatched",
            DecisionPath: recent ? "attention_event_recent" : "attention_event_live",
            ResultType: "session_ref",
            Result: new { session_id = sessionId, recent });
    }

    private void OpenTerminalClient(JsonElement entry)
    {
        var root = File.ReadAllText(Path.Combine(config.RuntimeDir, "repo-root.txt")).Trim().TrimEnd('/');
        var pane = GetString(entry, "tmux_pane");
        var socket = GetString(entry, "tmux_socket");
        if (!root.StartsWith('/') || pane.Length < 2 || pane[0] != '%' ||
            pane.AsSpan(1).ContainsAnyExceptInRange('0', '9') ||
            (socket.Length != 0 && !socket.StartsWith('/')))
        {
            throw new InvalidOperationException("terminal client target is unavailable");
        }
        var start = new ProcessStartInfo("wsl.exe")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
        };
        if (!string.IsNullOrWhiteSpace(config.ClipboardWslDistro))
        {
            start.ArgumentList.Add("--distribution");
            start.ArgumentList.Add(config.ClipboardWslDistro);
        }
        foreach (var arg in new[] { "--exec", root + "/scripts/runtime/cli/wezdeck-terminal", "--describe-launch", pane, socket })
        {
            start.ArgumentList.Add(arg);
        }
        using var process = Process.Start(start) ?? throw new InvalidOperationException("terminal launcher did not start");
        var output = process.StandardOutput.ReadToEndAsync();
        if (!output.Wait(4000) || !process.WaitForExit(500))
        {
            try { process.Kill(entireProcessTree: true); }
            catch (InvalidOperationException) when (process.HasExited) { }
            throw new InvalidOperationException("terminal launcher did not respond");
        }
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException("terminal launcher could not open the tmux pane");
        }
        using var launch = JsonDocument.Parse(output.Result);
        var terminalStart = new ProcessStartInfo(launch.RootElement.GetProperty("exe").GetString()!)
        {
            UseShellExecute = false,
        };
        foreach (var arg in launch.RootElement.GetProperty("args").EnumerateArray())
        {
            terminalStart.ArgumentList.Add(arg.GetString()!);
        }
        using var terminal = Process.Start(terminalStart) ?? throw new InvalidOperationException("terminal did not start");
    }

    private JsonElement ReadSessionEntry(string sessionId, bool recent, long? archivedTs)
    {
        var stateDir = Path.GetDirectoryName(config.StatePath) ?? string.Empty;
        var statePath = Path.GetFullPath(Path.Combine(stateDir, "..", "agent-attention", "attention.json"));
        if (!File.Exists(statePath))
        {
            throw new InvalidOperationException("agent session state is unavailable");
        }

        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(statePath));
            var root = document.RootElement;
            if (recent)
            {
                if (root.TryGetProperty("recent", out var recentEntries) &&
                    recentEntries.ValueKind == JsonValueKind.Array)
                {
                    foreach (var entry in recentEntries.EnumerateArray())
                    {
                        if (GetString(entry, "session_id") != sessionId)
                        {
                            continue;
                        }
                        if (archivedTs.HasValue && GetLong(entry, "archived_ts") != archivedTs.Value)
                        {
                            continue;
                        }
                        return entry.Clone();
                    }
                }
            }
            else if (root.TryGetProperty("entries", out var entries) &&
                     entries.ValueKind == JsonValueKind.Object &&
                     entries.TryGetProperty(sessionId, out var active))
            {
                return active.Clone();
            }

            throw new InvalidOperationException("agent session was not found");
        }
        catch (JsonException)
        {
            throw new InvalidOperationException("agent session state is invalid");
        }
    }

    private static string BuildJumpPayload(
        string sessionId,
        JsonElement entry,
        bool recent,
        long? archivedTs,
        string traceId)
    {
        var weztermPane = GetString(entry, "wezterm_pane_id");
        var socket = GetString(entry, "tmux_socket");
        var window = GetString(entry, "tmux_window");
        var pane = GetString(entry, "tmux_pane");
        var tmuxSession = GetString(entry, "tmux_session");
        if (recent)
        {
            var archive = archivedTs?.ToString() ?? GetString(entry, "archived_ts");
            return string.Join("|", "v1", "recent", sessionId, archive, weztermPane, socket, window, pane, tmuxSession, traceId);
        }

        return string.Join("|", "v1", "jump", sessionId, weztermPane, socket, window, pane, tmuxSession, traceId);
    }

    private void WriteAttentionJumpEvent(string payload)
    {
        var stateDir = Path.GetDirectoryName(config.StatePath) ?? string.Empty;
        var eventDir = Path.GetFullPath(Path.Combine(stateDir, "..", "wezterm-events"));
        Directory.CreateDirectory(eventDir);
        var target = Path.Combine(eventDir, "attention.jump.json");
        var temp = target + $".tmp.{Environment.ProcessId}.{Guid.NewGuid():N}";
        var envelope = JsonSerializer.Serialize(new
        {
            version = 1,
            name = "attention.jump",
            payload,
            ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        });
        File.WriteAllText(temp, envelope, new UTF8Encoding(false));
        File.Move(temp, target, true);
    }

    private static string GetString(JsonElement element, string propertyName)
    {
        return element.TryGetProperty(propertyName, out var value) &&
               value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : string.Empty;
    }

    private static long? GetLong(JsonElement element, string propertyName)
    {
        return element.TryGetProperty(propertyName, out var value) &&
               value.TryGetInt64(out var number)
            ? number
            : null;
    }
}
