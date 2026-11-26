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

// GET /api/v1/diagnostics: the Windows runtime logs plus the WSL runtime
// log, parsed into one list of entries.
internal sealed partial class RuntimeWebServer
{
    private object ReadDiagnostics(IQueryCollection query)
    {
        var requestedLimit = 80;
        if (int.TryParse(query["limit"].ToString(), out var parsedLimit))
        {
            requestedLimit = parsedLimit;
        }
        var limit = Math.Clamp(requestedLimit, 1, 200);
        var category = query["category"].ToString();
        var level = query["level"].ToString();
        var source = query["source"].ToString();
        var trace = query["trace"].ToString();
        var search = query["q"].ToString();
        var sources = new List<DiagnosticEntry>();
        foreach (var file in DiagnosticLogFiles())
        {
            if (!File.Exists(file.Path))
            {
                continue;
            }
            sources.AddRange(File.ReadLines(file.Path).TakeLast(500)
                .Select(line => ParseDiagnosticLine(line, file.Name)));
        }
        sources.AddRange(ReadWslRuntimeLog());
        var lines = sources
            .Where(entry => string.IsNullOrWhiteSpace(category) ||
                            string.Equals(entry.Category, category, StringComparison.OrdinalIgnoreCase))
            .Where(entry => string.IsNullOrWhiteSpace(level) ||
                            string.Equals(entry.Level, level, StringComparison.OrdinalIgnoreCase))
            .Where(entry => string.IsNullOrWhiteSpace(source) ||
                            string.Equals(entry.Stream, source, StringComparison.OrdinalIgnoreCase))
            .Where(entry => string.IsNullOrWhiteSpace(trace) ||
                            entry.TraceId.Contains(trace, StringComparison.OrdinalIgnoreCase))
            .Where(entry => string.IsNullOrWhiteSpace(search) ||
                            entry.Raw.Contains(search, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(entry => entry.Ts, StringComparer.Ordinal)
            .ToArray();
        var entries = lines.Take(limit).ToArray();
        var counts = lines.GroupBy(entry => entry.Category, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(group => group.Key, group => group.Count(), StringComparer.OrdinalIgnoreCase);
        return new
        {
            available = true,
            sources = DiagnosticLogFiles().Select(file => file.Name).Concat(new[] { "wsl:runtime.log" }),
            entries,
            counts,
        };
    }

    private IEnumerable<(string Name, string Path)> DiagnosticLogFiles()
    {
        var helperPath = config.Diagnostics.FilePath;
        if (string.IsNullOrWhiteSpace(helperPath))
        {
            helperPath = Path.Combine(config.RuntimeDir, "logs", "helper.log");
        }
        var logDir = Path.GetDirectoryName(helperPath) ?? Path.Combine(config.RuntimeDir, "logs");
        return new[]
        {
            ("windows:helper.log", helperPath),
            ("windows:wezterm.log", Path.Combine(logDir, "wezterm.log")),
            ("windows:manager-bootstrap.log", Path.Combine(logDir, "manager-bootstrap.log")),
            ("windows:web-client.log", Path.Combine(config.RuntimeDir, "logs", "web-client.log")),
        };
    }

    private IEnumerable<DiagnosticEntry> ReadWslRuntimeLog()
    {
        var distro = ResolveWslDistro();
        var user = ResolveWslUser();
        if (!string.IsNullOrWhiteSpace(distro) && !string.IsNullOrWhiteSpace(user))
        {
            foreach (var prefix in new[] { "\\\\wsl.localhost\\", "\\\\wsl$\\" })
            {
                var uncPath = prefix + distro + "\\home\\" + user + "\\.local\\state\\wezterm-runtime\\logs\\runtime.log";
                if (File.Exists(uncPath))
                {
                    return File.ReadLines(uncPath).TakeLast(500)
                        .Select(line => ParseDiagnosticLine(line, "wsl:runtime.log"));
                }
            }
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = "wsl.exe",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        if (!string.IsNullOrWhiteSpace(distro))
        {
            startInfo.ArgumentList.Add("-d");
            startInfo.ArgumentList.Add(distro);
        }
        var wslUser = ResolveWslUser();
        if (!string.IsNullOrWhiteSpace(wslUser))
        {
            startInfo.ArgumentList.Add("--user");
            startInfo.ArgumentList.Add(wslUser);
        }
        startInfo.ArgumentList.Add("--");
        startInfo.ArgumentList.Add("bash");
        startInfo.ArgumentList.Add("-lc");
        startInfo.ArgumentList.Add("tail -n 500 \"$HOME/.local/state/wezterm-runtime/logs/runtime.log\"");

        using var process = Process.Start(startInfo);
        if (process == null || !process.WaitForExit(5000))
        {
            try { process?.Kill(entireProcessTree: true); } catch { }
            return Array.Empty<DiagnosticEntry>();
        }
        var output = process.StandardOutput.ReadToEnd().Replace("\0", string.Empty, StringComparison.Ordinal);
        return output.Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => ParseDiagnosticLine(line.TrimEnd('\r'), "wsl:runtime.log"));
    }

    private string ResolveWslDistro()
    {
        if (!string.IsNullOrWhiteSpace(config.ClipboardWslDistro))
        {
            return config.ClipboardWslDistro;
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = "wsl.exe",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        startInfo.ArgumentList.Add("--list");
        startInfo.ArgumentList.Add("--quiet");
        using var process = Process.Start(startInfo);
        if (process == null || !process.WaitForExit(2000))
        {
            try { process?.Kill(entireProcessTree: true); } catch { }
            return string.Empty;
        }

        return process.StandardOutput.ReadToEnd().Replace("\0", string.Empty, StringComparison.Ordinal)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(item => item.Trim().Trim('\0'))
            .FirstOrDefault(item => item.Length > 0) ?? string.Empty;
    }

    private string ResolveWslUser()
    {
        var repoRootPath = Path.Combine(config.RuntimeDir, "repo-root.txt");
        var repoRoot = File.Exists(repoRootPath) ? File.ReadAllText(repoRootPath).Trim() : string.Empty;
        if (!repoRoot.StartsWith("/home/", StringComparison.Ordinal))
        {
            return string.Empty;
        }

        var remainder = repoRoot[6..];
        var slash = remainder.IndexOf('/');
        return slash > 0 ? remainder[..slash] : string.Empty;
    }

    private static DiagnosticEntry ParseDiagnosticLine(string line, string stream)
    {
        return new DiagnosticEntry(
            ReadDiagnosticField(line, "ts"),
            ReadDiagnosticField(line, "level"),
            ReadDiagnosticField(line, "source"),
            ReadDiagnosticField(line, "category"),
            ReadDiagnosticField(line, "trace_id"),
            ReadDiagnosticField(line, "message"),
            stream,
            line);
    }

    private static string ReadDiagnosticField(string line, string key)
    {
        var marker = key + "=";
        var start = line.IndexOf(marker, StringComparison.Ordinal);
        if (start < 0)
        {
            return string.Empty;
        }

        start += marker.Length;
        if (start < line.Length && line[start] == '"')
        {
            start += 1;
            var builder = new StringBuilder();
            var escaped = false;
            for (var index = start; index < line.Length; index += 1)
            {
                var character = line[index];
                if (escaped)
                {
                    builder.Append(character switch
                    {
                        'n' => '\n',
                        'r' => '\r',
                        't' => '\t',
                        _ => character,
                    });
                    escaped = false;
                    continue;
                }
                if (character == '\\')
                {
                    escaped = true;
                    continue;
                }
                if (character == '"')
                {
                    break;
                }
                builder.Append(character);
            }
            return builder.ToString();
        }

        var end = line.IndexOf(' ', start);
        return line[start..(end < 0 ? line.Length : end)];
    }

    private sealed record DiagnosticEntry(
        [property: JsonPropertyName("ts")]
        string Ts,
        [property: JsonPropertyName("level")]
        string Level,
        [property: JsonPropertyName("source")]
        string Source,
        [property: JsonPropertyName("category")]
        string Category,
        [property: JsonPropertyName("trace_id")]
        string TraceId,
        [property: JsonPropertyName("message")]
        string Message,
        [property: JsonPropertyName("stream")]
        string Stream,
        [property: JsonPropertyName("raw")]
        string Raw);
}
