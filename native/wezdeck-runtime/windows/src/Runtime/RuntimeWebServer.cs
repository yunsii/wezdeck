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
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace WezDeck.Runtime;

internal sealed partial class RuntimeWebServer : IDisposable
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
    // writes on their own connection: a ticket.new running its CLI for up
    // to 60 s held the one bridge lock, and every read (session polls,
    // worktree, workspaces) waited behind it
    private readonly WslBridge writeBridge;

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
        writeBridge = new WslBridge(ResolveWslDistro, ResolveWslUser, () => Path.GetDirectoryName(config.RuntimeDir) ?? config.RuntimeDir, ReadRepoRoot);
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
        writeBridge.Dispose();
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
        // DNS rebinding: a page on evil.example rebound to 127.0.0.1 is
        // same-origin to itself, so its GETs carry no Origin header and the
        // origin check below never runs. The Host it sends is its own name,
        // though: only this listener's loopback names get an answer.
        if (!IsLoopbackHost(context.Request.Host))
        {
            context.Response.StatusCode = StatusCodes.Status421MisdirectedRequest;
            return;
        }
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

        // every source that got past the host / origin checks (设备授权 › 本机来源)
        var client = TrackClient(context);
        context.Items[ClientItem] = client;

        if (context.Request.Path.Equals("/events", StringComparison.OrdinalIgnoreCase))
        {
            Interlocked.Increment(ref client.Live);
            try
            {
                await HandleWebSocketAsync(context);
            }
            finally
            {
                Interlocked.Decrement(ref client.Live);
            }
            return;
        }

        var stopwatch = Stopwatch.StartNew();
        try
        {
            await HandleApiHttpAsync(context);
        }
        finally
        {
            var elapsedMs = stopwatch.ElapsedMilliseconds;
            var statusCode = context.Response.StatusCode;
            if (elapsedMs >= SlowHttpRequestMs || statusCode >= StatusCodes.Status500InternalServerError)
            {
                logger.Warn("wezdeck_runtime", "slow http request", new Dictionary<string, string?>
                {
                    ["method"] = context.Request.Method,
                    ["path"] = context.Request.Path.Value ?? string.Empty,
                    ["status"] = statusCode.ToString(CultureInfo.InvariantCulture),
                    ["elapsed_ms"] = elapsedMs.ToString(CultureInfo.InvariantCulture),
                    ["threshold_ms"] = SlowHttpRequestMs.ToString(CultureInfo.InvariantCulture),
                });
            }
        }
    }

    private const int SlowHttpRequestMs = 500;
    private const int SlowBridgeReadMs = 300;
    private const int SlowBridgeWriteMs = 1000;

    private async Task HandleApiHttpAsync(HttpContext context)
    {
        if (HttpMethods.IsPost(context.Request.Method) && await TryHandleRemoteWriteAsync(context))
        {
            return;
        }

        if (HttpMethods.IsPost(context.Request.Method) && await TryHandleWebEventsAsync(context))
        {
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

        if (await TryHandleCollabAsync(context)) return;
        if (await TryHandleRemoteAsync(context)) return;
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
                    "vscode.windows", "vscode.focus_or_open",
                    "workspaces.read", "worktree.status", "wakatime.read", "wsl.status", "events", "collab.read", "remote.read", "remote.write", "browser.slot", "clients.read", "web.events",
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
            "/api/v1/browser" => ReadBrowserSlot(),
            "/api/v1/vscode" => vscodeProvider(),
            "/api/v1/sessions" => ReadSessions(),
            "/api/v1/workspaces" => ReadWorkspaces(),
            "/api/v1/worktree/status" => ReadBridge("git", "status", new { path = context.Request.Query["path"].ToString() }),
            "/api/v1/wakatime" => ReadBridge("status", "wakatime", new { }),
            "/api/v1/wsl" => ReadBridge("bridge", "status", new { }),
            "/api/v1/diagnostics" => ReadDiagnostics(context.Request.Query),
            "/api/v1/clients" => ReadClients(),
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

    private const int ActionMaxBytes = 64 * 1024;

    // Only actions the web console actually calls may cross HTTP; clipboard,
    // Chrome process control, and window close stay named-pipe-only for WezTerm.
    private static readonly HashSet<string> HttpAllowedActions = new(StringComparer.OrdinalIgnoreCase)
    {
        "sessions/focus",
        "vscode/focus_or_open",
    };

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

        var domain = segments[3].ToLowerInvariant();
        var action = segments[4].ToLowerInvariant();
        var route = $"{domain}/{action}";
        if (!HttpAllowedActions.Contains(route))
        {
            logger.Warn("wezdeck_runtime", "http action denied", new Dictionary<string, string?>
            {
                ["route"] = route,
                ["reason"] = "not_allowed_over_http",
            });
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            await WriteJsonAsync(context, new Dictionary<string, object?> { ["error"] = "not_found" });
            return;
        }

        var origin = context.Request.Headers.Origin.ToString();
        if (!IsWriteOriginAllowed(origin))
        {
            logger.Warn("wezdeck_runtime", "http action denied", new Dictionary<string, string?>
            {
                ["route"] = route,
                ["origin"] = origin,
                ["reason"] = "origin_not_allowed",
            });
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            await WriteJsonAsync(context, new Dictionary<string, object?> { ["error"] = "actions are not allowed from this origin" });
            return;
        }

        if (!(context.Request.ContentType ?? string.Empty).StartsWith("application/json", StringComparison.OrdinalIgnoreCase))
        {
            context.Response.StatusCode = StatusCodes.Status415UnsupportedMediaType;
            await WriteJsonAsync(context, new Dictionary<string, object?> { ["error"] = "json body required" });
            return;
        }

        if (context.Request.ContentLength > ActionMaxBytes)
        {
            context.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
            await WriteJsonAsync(context, new Dictionary<string, object?> { ["error"] = "body too large" });
            return;
        }

        JsonElement payloadRoot;
        try
        {
            var limit = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
            if (limit is { IsReadOnly: false }) limit.MaxRequestBodySize = ActionMaxBytes;
            using var document = await JsonDocument.ParseAsync(context.Request.Body, cancellationToken: context.RequestAborted);
            if (document.RootElement.ValueKind != JsonValueKind.Object) throw new JsonException("body must be an object");
            payloadRoot = document.RootElement.Clone();
        }
        catch (BadHttpRequestException)
        {
            context.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
            await WriteJsonAsync(context, new Dictionary<string, object?> { ["error"] = "body too large" });
            return;
        }
        catch (JsonException exception)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            await WriteJsonAsync(context, new Dictionary<string, object?> { ["error"] = exception.Message });
            return;
        }

        // Never let an HTTP caller override the executable launched by vscode/focus_or_open.
        if (string.Equals(route, "vscode/focus_or_open", StringComparison.Ordinal))
        {
            foreach (var property in payloadRoot.EnumerateObject())
            {
                if (string.Equals(property.Name, "code_command", StringComparison.OrdinalIgnoreCase))
                {
                    logger.Warn("wezdeck_runtime", "http action denied", new Dictionary<string, string?>
                    {
                        ["route"] = route,
                        ["origin"] = origin,
                        ["reason"] = "code_command_forbidden",
                    });
                    context.Response.StatusCode = StatusCodes.Status400BadRequest;
                    await WriteJsonAsync(context, new Dictionary<string, object?> { ["error"] = "code_command is not allowed over http" });
                    return;
                }
            }
        }

        CountWrite(context);
        var requestJson = JsonSerializer.Serialize(new RuntimeRequest
        {
            TraceId = $"http-{Guid.NewGuid():N}",
            Domain = domain,
            Action = action,
            Payload = payloadRoot,
        });
        var responseJson = actionDispatcher(requestJson);
        await WriteRawJsonAsync(context, responseJson);
    }

    private object ReadBridge(string domain, string action, object payload, bool write = false)
    {
        var stopwatch = Stopwatch.StartNew();
        var slowThresholdMs = write ? SlowBridgeWriteMs : SlowBridgeReadMs;
        try
        {
            // writes: longer than the slowest one (the ticket CLI, 60 s), so
            // a still-running write is not reported failed and sent again
            var result = write
                ? writeBridge.Call(domain, action, payload, 75_000)
                : wslBridge.Call(domain, action, payload, 8_000);
            var elapsedMs = stopwatch.ElapsedMilliseconds;
            if (elapsedMs >= slowThresholdMs)
            {
                logger.Warn("wezdeck_runtime", "slow wsl bridge call", new Dictionary<string, string?>
                {
                    ["domain"] = domain,
                    ["action"] = action,
                    ["write"] = write ? "1" : "0",
                    ["elapsed_ms"] = elapsedMs.ToString(CultureInfo.InvariantCulture),
                    ["threshold_ms"] = slowThresholdMs.ToString(CultureInfo.InvariantCulture),
                });
            }
            return result;
        }
        catch (Exception exception)
        {
            logger.Warn("wezdeck_runtime", "wsl bridge call failed", new Dictionary<string, string?>
            {
                ["domain"] = domain,
                ["action"] = action,
                ["write"] = write ? "1" : "0",
                ["elapsed_ms"] = stopwatch.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture),
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

    private bool IsLoopbackHost(HostString host)
    {
        if (!host.HasValue || host.Port != config.HttpPort)
        {
            return false;
        }
        return host.Host is "127.0.0.1" or "[::1]" ||
            string.Equals(host.Host, "localhost", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Writes into agent panes: an allowlisted origin that is not this
    /// computer's own http://localhost / 127.0.0.1 — any dev server on those
    /// ports (another project's Next.js, a bad dependency, an XSS) could
    /// otherwise type into an agent. Local development reads only.
    /// </summary>
    private bool IsWriteOriginAllowed(string origin)
    {
        if (string.IsNullOrWhiteSpace(origin) || !IsOriginAllowed(origin))
        {
            return false;
        }
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri))
        {
            return false;
        }
        return !(uri.IsLoopback || string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase));
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
}
