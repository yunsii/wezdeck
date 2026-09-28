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

internal sealed class RuntimeWebServer : IDisposable
{
    private readonly RuntimeConfig config;
    private readonly StructuredLogger logger;
    private readonly Func<RuntimeImeStateResult> imeProvider;
    private readonly Func<string, string> actionDispatcher;
    private readonly Func<object> vscodeProvider;
    private readonly long startedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private readonly ConcurrentDictionary<Guid, WebSocket> sockets = new();
    private readonly CancellationTokenSource stopSource = new();
    private IWebHost? host;
    private Task? heartbeatTask;
    private object? workspaceCatalog;
    private long workspaceCatalogAtMs;
    private readonly WslBridge wslBridge;

    public RuntimeWebServer(
        RuntimeConfig config,
        Func<RuntimeImeStateResult> imeProvider,
        StructuredLogger logger,
        Func<string, string> actionDispatcher,
        Func<object> vscodeProvider)
    {
        this.config = config;
        this.imeProvider = imeProvider;
        this.logger = logger;
        this.actionDispatcher = actionDispatcher;
        this.vscodeProvider = vscodeProvider;
        wslBridge = new WslBridge(ResolveWslDistro, ResolveWslUser, () => Path.GetDirectoryName(config.RuntimeDir) ?? config.RuntimeDir, ReadRepoRoot);
    }

    public bool IsReady { get; private set; }

    public string Endpoint => $"http://127.0.0.1:{config.HttpPort}";

    public void Start()
    {
        logger.Info("wezdeck_runtime", "runtime web builder creating", new Dictionary<string, string?>
        {
            ["http_endpoint"] = Endpoint,
        });

        host = new WebHostBuilder()
            .UseKestrel()
            .UseUrls(Endpoint)
            .ConfigureLogging(logging => logging.ClearProviders())
            .Configure(app =>
            {
                app.UseWebSockets(new WebSocketOptions
                {
                    KeepAliveInterval = TimeSpan.FromSeconds(20),
                    AllowedOrigins = { "*" },
                });
                app.Run(HandleHttpAsync);
            })
            .Build();

        logger.Info("wezdeck_runtime", "runtime web host built");
        host.Start();
        IsReady = true;
        heartbeatTask = Task.Run(BroadcastHeartbeatAsync);
        logger.Info("wezdeck_runtime", "runtime web task started", new Dictionary<string, string?>
        {
            ["http_endpoint"] = Endpoint,
        });
    }

    public void Dispose()
    {
        if (stopSource.IsCancellationRequested)
        {
            return;
        }

        IsReady = false;
        wslBridge.Dispose();
        stopSource.Cancel();
        try
        {
            host?.StopAsync().GetAwaiter().GetResult();
            heartbeatTask?.GetAwaiter().GetResult();
        }
        catch
        {
            // Shutdown must not hide the helper's primary exit path.
        }
        foreach (var socket in sockets.Values)
        {
            socket.Dispose();
        }
        sockets.Clear();
        host?.Dispose();
        stopSource.Dispose();
    }

    private async Task HandleHttpAsync(HttpContext context)
    {
        var origin = context.Request.Headers.Origin.ToString();
        if (!string.IsNullOrWhiteSpace(origin) && !IsOriginAllowed(origin))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }
        if (!string.IsNullOrWhiteSpace(origin))
        {
            context.Response.Headers.AccessControlAllowOrigin = origin;
            context.Response.Headers.Vary = "Origin";
            context.Response.Headers.AccessControlAllowHeaders = "content-type, authorization";
            context.Response.Headers.AccessControlAllowMethods = "GET, POST, OPTIONS";
            // Public HTTPS console (Vercel) → loopback Runtime needs Chrome's
            // Private Network Access preflight grant. Without this header the
            // browser blocks the request and the overview shows Runtime API offline.
            if (string.Equals(
                    context.Request.Headers["Access-Control-Request-Private-Network"].ToString(),
                    "true",
                    StringComparison.OrdinalIgnoreCase))
            {
                context.Response.Headers["Access-Control-Allow-Private-Network"] = "true";
            }
        }
        if (HttpMethods.IsOptions(context.Request.Method))
        {
            context.Response.StatusCode = StatusCodes.Status204NoContent;
            return;
        }

        if (context.Request.Path.Equals("/events", StringComparison.OrdinalIgnoreCase))
        {
            await HandleWebSocketAsync(context);
            return;
        }

        if (HttpMethods.IsPost(context.Request.Method) &&
            context.Request.Path.StartsWithSegments("/api/v1/actions"))
        {
            await HandleActionAsync(context);
            return;
        }

        if (!HttpMethods.IsGet(context.Request.Method))
        {
            context.Response.StatusCode = StatusCodes.Status405MethodNotAllowed;
            return;
        }

        var body = context.Request.Path.Value?.ToLowerInvariant() switch
        {
            "/api/v1/health" => new Dictionary<string, object?>
            {
                ["api_version"] = "v1",
                ["instance_id"] = $"wezdeck-runtime-{Environment.ProcessId}",
                ["ready"] = IsReady,
                ["uptime_ms"] = Math.Max(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - startedAtMs, 0),
                ["capabilities"] = new[]
                {
                    "rime.stats", "ime.state", "chrome.state", "sessions.read", "sessions.focus", "diagnostics.logs",
                    "vscode.windows", "vscode.focus", "vscode.focus_or_open", "vscode.close",
                    "workspaces.read", "worktree.status", "wakatime.read", "wsl.status", "events",
                },
                ["observed_at"] = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture),
            },
            "/api/v1/rime/stats" => ReadRimeStats(),
            "/api/v1/ime" => new Dictionary<string, object?>
            {
                ["mode"] = imeProvider().Mode,
                ["lang"] = imeProvider().Lang,
                ["reason"] = imeProvider().Reason,
            },
            "/api/v1/chrome" => ReadChromeState(),
            "/api/v1/vscode" => vscodeProvider(),
            "/api/v1/sessions" => ReadSessions(),
            "/api/v1/workspaces" => ReadWorkspaces(),
            "/api/v1/worktree/status" => ReadBridge("git", "status", new { path = context.Request.Query["path"].ToString() }),
            "/api/v1/wakatime" => ReadBridge("status", "wakatime", new { }),
            "/api/v1/wsl" => ReadBridge("bridge", "status", new { }),
            "/api/v1/diagnostics" => ReadDiagnostics(context.Request.Query),
            _ => null,
        };

        if (body is null)
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            await WriteJsonAsync(context, new Dictionary<string, object?> { ["error"] = "not_found" });
            return;
        }

        await WriteJsonAsync(context, body);
    }

    private async Task HandleActionAsync(HttpContext context)
    {
        var segments = context.Request.Path.Value?
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            ?? Array.Empty<string>();
        if (segments.Length != 5 || !string.Equals(segments[0], "api", StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(segments[1], "v1", StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(segments[2], "actions", StringComparison.OrdinalIgnoreCase))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            await WriteJsonAsync(context, new Dictionary<string, object?> { ["error"] = "not_found" });
            return;
        }

        var payload = await JsonDocument.ParseAsync(context.Request.Body, cancellationToken: context.RequestAborted);
        var requestJson = JsonSerializer.Serialize(new RuntimeRequest
        {
            TraceId = $"http-{Guid.NewGuid():N}",
            Domain = segments[3],
            Action = segments[4],
            Payload = payload.RootElement.Clone(),
        });
        var responseJson = actionDispatcher(requestJson);
        await WriteRawJsonAsync(context, responseJson);
    }

    private object ReadBridge(string domain, string action, object payload)
    {
        try
        {
            return wslBridge.Call(domain, action, payload, 8_000);
        }
        catch (Exception exception)
        {
            logger.Warn("wezdeck_runtime", "wsl bridge call failed", new Dictionary<string, string?>
            {
                ["domain"] = domain,
                ["action"] = action,
                ["error"] = exception.Message,
            });
            return new Dictionary<string, object?>
            {
                ["available"] = false,
                ["error"] = exception.Message,
            };
        }
    }

    private string ReadRepoRoot() => ReadRuntimeText("repo-root.txt");

    private object ReadWorkspaces()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (workspaceCatalog != null && now - workspaceCatalogAtMs < 30_000)
        {
            return workspaceCatalog;
        }

        var catalog = LoadWorkspaceCatalog();
        workspaceCatalog = catalog;
        workspaceCatalogAtMs = now;
        return catalog;
    }

    private object LoadWorkspaceCatalog()
    {
        Dictionary<string, object?> Unavailable(string reason)
        {
            logger.Warn("wezdeck_runtime", "workspace catalog unavailable", new Dictionary<string, string?>
            {
                ["reason"] = reason,
            });
            return new Dictionary<string, object?>
            {
                ["available"] = false,
                ["reason"] = reason,
                ["workspaces"] = Array.Empty<object>(),
            };
        }

        try
        {
            return wslBridge.Call("workspace", "catalog", new { }, 20_000);
        }
        catch (Exception exception)
        {
            return Unavailable("bridge: " + exception.Message);
        }
    }

    private string ReadRuntimeText(string name)
    {
        var path = Path.Combine(config.RuntimeDir, name);
        return File.Exists(path) ? File.ReadAllText(path).Trim() : string.Empty;
    }

    private static bool TryRunWslRaw(
        IReadOnlyList<string> args,
        int timeoutMs,
        out int exitCode,
        out string stdout,
        out string stderr)
    {
        exitCode = -1;
        stdout = string.Empty;
        stderr = string.Empty;
        var startInfo = new ProcessStartInfo
        {
            FileName = "wsl.exe",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var arg in args)
        {
            startInfo.ArgumentList.Add(arg);
        }

        using var process = Process.Start(startInfo);
        if (process == null)
        {
            return false;
        }

        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(timeoutMs))
        {
            try { process.Kill(entireProcessTree: true); } catch { }
            return false;
        }

        stdout = stdoutTask.GetAwaiter().GetResult().Replace("\0", string.Empty, StringComparison.Ordinal);
        stderr = stderrTask.GetAwaiter().GetResult().Replace("\0", string.Empty, StringComparison.Ordinal);
        exitCode = process.ExitCode;
        return exitCode == 0;
    }

    private object ReadSessions()
    {
        var stateDir = Path.GetDirectoryName(config.StatePath) ?? string.Empty;
        var path = Path.GetFullPath(Path.Combine(stateDir, "..", "agent-attention", "attention.json"));
        if (!File.Exists(path))
        {
            return new Dictionary<string, object?>
            {
                ["available"] = false,
                ["entries"] = new Dictionary<string, object?>(),
                ["recent"] = Array.Empty<object>(),
            };
        }

        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            var root = document.RootElement;
            return new
            {
                available = true,
                entries = root.TryGetProperty("entries", out var entries)
                    ? entries.Clone()
                    : JsonSerializer.SerializeToElement(new Dictionary<string, object?>()),
                recent = root.TryGetProperty("recent", out var recent)
                    ? recent.Clone()
                    : JsonSerializer.SerializeToElement(Array.Empty<object>()),
            };
        }
        catch (JsonException)
        {
            return new Dictionary<string, object?>
            {
                ["available"] = false,
                ["entries"] = new Dictionary<string, object?>(),
                ["recent"] = Array.Empty<object>(),
            };
        }
    }

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

    private async Task HandleWebSocketAsync(HttpContext context)
    {
        var origin = context.Request.Headers.Origin.ToString();
        if (!string.IsNullOrWhiteSpace(origin) && !IsOriginAllowed(origin))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }
        if (!context.WebSockets.IsWebSocketRequest)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        using var socket = await context.WebSockets.AcceptWebSocketAsync();
        var id = Guid.NewGuid();
        sockets[id] = socket;
        try
        {
            var buffer = new byte[128];
            while (!stopSource.IsCancellationRequested && socket.State == WebSocketState.Open)
            {
                var result = await socket.ReceiveAsync(buffer, stopSource.Token);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    break;
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (WebSocketException)
        {
        }
        finally
        {
            sockets.TryRemove(id, out _);
        }
    }

    private async Task BroadcastHeartbeatAsync()
    {
        while (!stopSource.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(2), stopSource.Token);
                var payload = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new
                {
                    name = "runtime.health.changed",
                    ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                }));
                foreach (var entry in sockets.ToArray())
                {
                    if (entry.Value.State != WebSocketState.Open)
                    {
                        sockets.TryRemove(entry.Key, out _);
                        continue;
                    }
                    try
                    {
                        await entry.Value.SendAsync(payload, WebSocketMessageType.Text, true, stopSource.Token);
                    }
                    catch (WebSocketException)
                    {
                        sockets.TryRemove(entry.Key, out _);
                    }
                }
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private static async Task WriteJsonAsync(HttpContext context, object body)
    {
        context.Response.ContentType = "application/json; charset=utf-8";
        await context.Response.WriteAsync(JsonSerializer.Serialize(body));
    }

    private static async Task WriteRawJsonAsync(HttpContext context, string body)
    {
        context.Response.ContentType = "application/json; charset=utf-8";
        await context.Response.WriteAsync(body);
    }

    private bool IsOriginAllowed(string origin)
    {
        foreach (var allowed in config.HttpAllowedOrigins)
        {
            if (string.Equals(allowed, origin, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
            var wildcard = allowed.IndexOf('*');
            if (wildcard >= 0 &&
                origin.StartsWith(allowed[..wildcard], StringComparison.OrdinalIgnoreCase) &&
                origin.EndsWith(allowed[(wildcard + 1)..], StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }

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
}
