using System.Collections.Concurrent;
using System.Globalization;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
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
    private readonly long startedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private readonly ConcurrentDictionary<Guid, WebSocket> sockets = new();
    private readonly CancellationTokenSource stopSource = new();
    private IWebHost? host;
    private Task? heartbeatTask;

    public RuntimeWebServer(RuntimeConfig config, Func<RuntimeImeStateResult> imeProvider, StructuredLogger logger)
    {
        this.config = config;
        this.imeProvider = imeProvider;
        this.logger = logger;
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
            context.Response.Headers.AccessControlAllowMethods = "GET, OPTIONS";
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

        var body = context.Request.Path.Value?.ToLowerInvariant() switch
        {
            "/api/v1/health" => new Dictionary<string, object?>
            {
                ["api_version"] = "v1",
                ["instance_id"] = $"wezdeck-runtime-{Environment.ProcessId}",
                ["ready"] = IsReady,
                ["uptime_ms"] = Math.Max(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - startedAtMs, 0),
                ["capabilities"] = new[] { "rime.stats", "ime.state", "chrome.state", "events" },
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
