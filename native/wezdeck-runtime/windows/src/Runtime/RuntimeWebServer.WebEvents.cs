using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;

namespace WezDeck.Runtime;

internal sealed partial class RuntimeWebServer
{
    private const int WebEventsMaxBytes = 64 * 1024;
    private const int WebEventsMaxBatch = 20;
    private static readonly HashSet<string> WebEventKinds = new(StringComparer.Ordinal)
    {
        "boot", "popstate", "after-back", "visibility", "link", "nav",
        "nav-collapse", "nav-frames", "chat-pin", "chat-catch-up",
        "session-seen-ack", "session-focus", "session-follow", "composer-clear",
        "host-diag", "host-reload",
        "web-write", "session-sync", "chat-render", "error", "rejection",
    };
    private static readonly HashSet<string> WebEventFields = new(StringComparer.Ordinal)
    {
        "id", "op_id", "action", "stage", "outcome", "mode", "state",
        "status", "type", "index", "length", "count", "start", "total",
        "shown", "ms", "pinned", "skipped", "chars", "images", "busy",
        "route", "reason", "deferred",
    };
    private readonly object webEventsLock = new();
    private StructuredLogger? webEventsLogger;

    private string WebEventsLogPath()
    {
        var helperPath = string.IsNullOrWhiteSpace(config.Diagnostics.FilePath)
            ? Path.Combine(config.RuntimeDir, "logs", "helper.log")
            : config.Diagnostics.FilePath;
        return Path.Combine(Path.GetDirectoryName(helperPath) ?? Path.Combine(config.RuntimeDir, "logs"), "web-client.log");
    }

    private async Task<bool> TryHandleWebEventsAsync(HttpContext context)
    {
        if (!context.Request.Path.Equals("/api/v1/web-events", StringComparison.OrdinalIgnoreCase)) return false;
        if (!IsWriteOriginAllowed(context.Request.Headers.Origin.ToString()))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            await WriteJsonAsync(context, new { error = "origin not allowed" });
            return true;
        }
        if (!(context.Request.ContentType ?? "").StartsWith("application/json", StringComparison.OrdinalIgnoreCase))
        {
            context.Response.StatusCode = StatusCodes.Status415UnsupportedMediaType;
            await WriteJsonAsync(context, new { error = "json required" });
            return true;
        }
        try
        {
            if (context.Request.ContentLength > WebEventsMaxBytes) throw new JsonException("body too large");
            var limit = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
            if (limit is { IsReadOnly: false }) limit.MaxRequestBodySize = WebEventsMaxBytes;
            using var body = await JsonDocument.ParseAsync(context.Request.Body, cancellationToken: context.RequestAborted);
            var root = body.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("events", out var events) || events.ValueKind != JsonValueKind.Array ||
                events.GetArrayLength() > WebEventsMaxBatch) throw new JsonException("invalid events batch");
            var accepted = 0;
            lock (webEventsLock)
            {
                webEventsLogger ??= new StructuredLogger(new DiagnosticConfig
                {
                    Enabled = true,
                    CategoryEnabled = true,
                    FilePath = WebEventsLogPath(),
                    MaxBytes = 1 << 20,
                    MaxFiles = 3,
                });
                foreach (var item in events.EnumerateArray())
                {
                    if (!TryReadWebEvent(item, out var fields)) continue;
                    if (!webEventsLogger.TryInfo("web_client", "event", fields))
                        throw new IOException("web event log is unavailable");
                    accepted++;
                }
                var dropped = root.TryGetProperty("dropped", out var lost) && lost.ValueKind == JsonValueKind.Number && lost.TryGetInt32(out var count)
                    ? Math.Clamp(count, 0, 1_000_000) : 0;
                if (dropped > 0 && !webEventsLogger.TryWarn("web_client", "browser queue overflow", new Dictionary<string, string?>
                {
                    ["dropped"] = dropped.ToString(),
                })) throw new IOException("web event log is unavailable");
            }
            await WriteJsonAsync(context, new { accepted });
        }
        catch (Exception exception) when (exception is JsonException or BadHttpRequestException)
        {
            context.Response.StatusCode = exception is BadHttpRequestException ? 413 : 400;
            await WriteJsonAsync(context, new { error = exception.Message });
        }
        catch (IOException)
        {
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            await WriteJsonAsync(context, new { error = "web event log unavailable" });
        }
        return true;
    }

    private static bool TryReadWebEvent(JsonElement item, out Dictionary<string, string?> fields)
    {
        fields = new Dictionary<string, string?>();
        if (item.ValueKind != JsonValueKind.Object ||
            !item.TryGetProperty("kind", out var kind) || kind.ValueKind != JsonValueKind.String ||
            !WebEventKinds.Contains(kind.GetString() ?? "") ||
            !item.TryGetProperty("page", out var page) || page.ValueKind != JsonValueKind.String ||
            !Guid.TryParse(page.GetString(), out _) ||
            !item.TryGetProperty("seq", out var seq) || seq.ValueKind != JsonValueKind.Number ||
            !seq.TryGetInt32(out var number) || number < 1)
            return false;
        fields["kind"] = kind.GetString();
        fields["page"] = page.GetString();
        fields["seq"] = number.ToString();
        if (item.TryGetProperty("at", out var at) && at.ValueKind == JsonValueKind.Number && at.TryGetInt64(out var timestamp))
            fields["client_at_ms"] = timestamp.ToString();
        if (item.TryGetProperty("build", out var build) && build.ValueKind == JsonValueKind.String)
        {
            var value = build.GetString() ?? "";
            if (value.Length <= 80 && value.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '.' or '_' or '-'))
                fields["build"] = value;
        }
        if (item.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object)
        {
            foreach (var field in data.EnumerateObject())
            {
                if (!WebEventFields.Contains(field.Name)) continue;
                var value = field.Value.ValueKind switch
                {
                    JsonValueKind.String => field.Value.GetString(),
                    JsonValueKind.Number => field.Value.GetRawText(),
                    JsonValueKind.True => "true",
                    JsonValueKind.False => "false",
                    _ => null,
                };
                var max = field.Name switch
                {
                    "route" => 160,
                    "reason" => 120,
                    _ => 80,
                };
                if (value is null || value.Length > max) continue;
                // host `--reason` may be Chinese / spaces; still no control chars
                if (field.Name == "reason")
                {
                    if (value.Any(char.IsControl)) continue;
                    fields[field.Name] = value;
                    continue;
                }
                if (!value.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '.' or '_' or '-' or ':' ||
                        (field.Name == "route" && ch == '/'))) continue;
                fields[field.Name] = value;
            }
        }
        fields["trace_id"] = fields.GetValueOrDefault("op_id") ?? fields["page"];
        return true;
    }
}
