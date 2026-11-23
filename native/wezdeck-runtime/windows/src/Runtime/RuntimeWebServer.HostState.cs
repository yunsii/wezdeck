using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace WezDeck.Runtime;

// Host state reads for the console: Rime commit stats and the Chrome debug
// instance.
internal sealed partial class RuntimeWebServer
{
    private Dictionary<string, object?> ReadRimeStats()
    {
        var runtimeStateDir = Path.GetDirectoryName(config.StatePath) ?? string.Empty;
        var path = Path.GetFullPath(Path.Combine(runtimeStateDir, "..", "rime-commits.jsonl"));
        var today = DateTime.UtcNow.Date;
        var events = 0;
        var chars = 0;
        var todayEvents = 0;
        var todayChars = 0;
        string? first = null;
        string? last = null;
        if (File.Exists(path))
        {
            foreach (var line in File.ReadLines(path))
            {
                try
                {
                    using var document = JsonDocument.Parse(line);
                    var root = document.RootElement;
                    var count = root.TryGetProperty("chars", out var charsValue) && charsValue.ValueKind == JsonValueKind.Number
                        ? charsValue.GetInt32()
                        : 0;
                    var timestamp = root.TryGetProperty("ts", out var tsValue) && tsValue.ValueKind == JsonValueKind.String
                        ? tsValue.GetString()
                        : null;
                    events += 1;
                    chars += Math.Max(count, 0);
                    if (timestamp is not null && DateTimeOffset.TryParse(timestamp, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed))
                    {
                        if (parsed.UtcDateTime.Date == today)
                        {
                            todayEvents += 1;
                            todayChars += Math.Max(count, 0);
                        }
                        first ??= timestamp;
                        last = timestamp;
                    }
                }
                catch (JsonException)
                {
                    // Ignore a partial line while the Lua writer is appending.
                }
            }
        }
        return new Dictionary<string, object?>
        {
            ["events"] = events,
            ["chars"] = chars,
            ["today_events"] = todayEvents,
            ["today_chars"] = todayChars,
            ["first_ts"] = first,
            ["last_ts"] = last,
        };
    }

    private Dictionary<string, object?> ReadChromeState()
    {
        var state = ChromeStateSnapshot.LoadFromFile(config.ChromeDebugStatePath ?? string.Empty);
        return new Dictionary<string, object?>
        {
            ["mode"] = state?.Mode ?? "none",
            ["alive"] = state?.Alive ?? false,
            ["port"] = state?.Port ?? 0,
            ["pid"] = state?.Pid,
        };
    }

    /// <summary>
    /// The browser slot (docs/browser-debug.md): which backend holds it and,
    /// for ego, whether it was last seen alive — from the status file
    /// apply-browser-backend / the ego wrapper write. The console band shows
    /// it instead of a CDP line that is off on purpose under ego.
    /// </summary>
    private Dictionary<string, object?> ReadBrowserSlot()
    {
        var runtimeStateDir = Path.GetDirectoryName(config.StatePath) ?? string.Empty;
        var path = Path.GetFullPath(Path.Combine(runtimeStateDir, "..", "browser-agent", "status.json"));
        var result = new Dictionary<string, object?> { ["backend"] = null };
        try
        {
            if (!File.Exists(path)) return result;
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            var root = document.RootElement;
            if (root.TryGetProperty("backend", out var backend) && backend.ValueKind == JsonValueKind.String)
                result["backend"] = backend.GetString();
            if (root.TryGetProperty("ego", out var ego) && ego.ValueKind == JsonValueKind.Object)
            {
                if (ego.TryGetProperty("alive", out var alive) && (alive.ValueKind == JsonValueKind.True || alive.ValueKind == JsonValueKind.False))
                    result["ego_alive"] = alive.GetBoolean();
                if (ego.TryGetProperty("updated_at_ms", out var at) && at.TryGetInt64(out var ms))
                    result["ego_updated_at_ms"] = ms;
            }
        }
        catch (Exception)
        {
            // unreadable status: the band falls back to the CDP line
        }
        return result;
    }
}
