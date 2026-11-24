using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;

namespace WezDeck.Runtime;

// Read-only session passthrough for a browser on this computer
// (docs/remote-sessions.md "Local reads and writes"): GET /api/v1/remote/<action>?args=<json>
// → WSL bridge `remote.<action>`, the relay's read set (wezdeck-wsl readRPC).
// Writes from this computer: POST /api/v1/remote/<action> with a JSON object
// body → bridge `remote.<action>` (wezdeck-wsl remote_write.go), no device key:
// this server listens on loopback and refuses origins outside its allowlist
// (HandleHttpAsync), the trust its other host actions already run on. Remote
// devices keep signing their writes over the relay.
internal sealed partial class RuntimeWebServer
{
    private const string RemotePrefix = "/api/v1/remote/";
    private const int RemoteArgsMaxChars = 4096;

    private static readonly HashSet<string> RemoteReadActions = new(StringComparer.Ordinal)
    {
        "sessions", "session", "upload.get", "todos", "repos", "ticket.targets",
        "session.new.job", "session.image", "session.history", "session.git", "devices",
    };

    private const int RemoteWriteMaxBytes = 256 * 1024; // an upload chunk is ≤ 64 KB decoded

    private static readonly HashSet<string> RemoteWriteActions = new(StringComparer.Ordinal)
    {
        "send", "key", "reply", "attach", "upload", "todo", "clear", "session.new", "ticket.new",
        // local only (serve.go): 批准 / 撤销 from the console on the host
        "device.approve", "device.revoke",
    };

    private async Task<bool> TryHandleRemoteWriteAsync(HttpContext context)
    {
        var requestPath = context.Request.Path.Value ?? string.Empty;
        if (!requestPath.StartsWith(RemotePrefix, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var remoteAction = requestPath.Substring(RemotePrefix.Length).ToLowerInvariant();
        if (!RemoteWriteActions.Contains(remoteAction))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            await WriteJsonAsync(context, new Dictionary<string, object?> { ["error"] = "not_found" });
            return true;
        }
        // the production console only: no Origin (curl, a script) or a
        // loopback dev origin cannot write (IsWriteOriginAllowed)
        if (!IsWriteOriginAllowed(context.Request.Headers.Origin.ToString()))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            await WriteJsonAsync(context, new Dictionary<string, object?> { ["error"] = "writes are not allowed from this origin" });
            return true;
        }
        // JSON only: a form post (no CORS preflight) from another page cannot write
        if (!(context.Request.ContentType ?? string.Empty).StartsWith("application/json", StringComparison.OrdinalIgnoreCase))
        {
            context.Response.StatusCode = StatusCodes.Status415UnsupportedMediaType;
            await WriteJsonAsync(context, new Dictionary<string, object?> { ["error"] = "json body required" });
            return true;
        }

        JsonElement remoteArgs;
        try
        {
            // cap the body before reading it (Kestrel's default is 30 MB, and
            // the length check after ReadToEnd counted UTF-16 chars)
            if (context.Request.ContentLength > RemoteWriteMaxBytes) throw new JsonException("body too large");
            var limit = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
            if (limit is { IsReadOnly: false }) limit.MaxRequestBodySize = RemoteWriteMaxBytes;
            using var reader = new StreamReader(context.Request.Body);
            var raw = await reader.ReadToEndAsync();
            using var document = JsonDocument.Parse(string.IsNullOrEmpty(raw) ? "{}" : raw);
            if (document.RootElement.ValueKind != JsonValueKind.Object) throw new JsonException("body must be an object");
            remoteArgs = document.RootElement.Clone();
        }
        catch (BadHttpRequestException)
        {
            context.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
            await WriteJsonAsync(context, new Dictionary<string, object?> { ["error"] = "body too large" });
            return true;
        }
        catch (JsonException exception)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            await WriteJsonAsync(context, new Dictionary<string, object?> { ["error"] = exception.Message });
            return true;
        }

        CountWrite(context);
        await WriteJsonAsync(context, ReadBridge("remote", remoteAction, remoteArgs, write: true));
        return true;
    }

    private async Task<bool> TryHandleRemoteAsync(HttpContext context)
    {
        var requestPath = context.Request.Path.Value ?? string.Empty;
        if (!requestPath.StartsWith(RemotePrefix, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var remoteAction = requestPath.Substring(RemotePrefix.Length).ToLowerInvariant();
        if (!RemoteReadActions.Contains(remoteAction))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            await WriteJsonAsync(context, new Dictionary<string, object?> { ["error"] = "not_found" });
            return true;
        }

        var raw = context.Request.Query["args"].ToString();
        if (string.IsNullOrEmpty(raw)) raw = "{}";
        JsonElement remoteArgs;
        try
        {
            if (raw.Length > RemoteArgsMaxChars) throw new JsonException("args too long");
            using var document = JsonDocument.Parse(raw);
            if (document.RootElement.ValueKind != JsonValueKind.Object) throw new JsonException("args must be an object");
            remoteArgs = document.RootElement.Clone();
        }
        catch (JsonException exception)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            await WriteJsonAsync(context, new Dictionary<string, object?> { ["error"] = exception.Message });
            return true;
        }

        await WriteJsonAsync(context, ReadBridge("remote", remoteAction, remoteArgs));
        return true;
    }
}
