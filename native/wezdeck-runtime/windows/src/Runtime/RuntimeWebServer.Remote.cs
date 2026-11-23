using System.Text.Json;
using Microsoft.AspNetCore.Http;

namespace WezDeck.Runtime;

// Read-only session passthrough for a browser on this computer
// (docs/remote-sessions.md "Local reads"): GET /api/v1/remote/<action>?args=<json>
// → WSL bridge `remote.<action>`, the relay's read set (wezdeck-wsl readRPC).
// Writes are never proxied here; they need an approved device's signature
// and go over the paired remote link.
internal sealed partial class RuntimeWebServer
{
    private const string RemotePrefix = "/api/v1/remote/";
    private const int RemoteArgsMaxChars = 4096;

    private static readonly HashSet<string> RemoteReadActions = new(StringComparer.Ordinal)
    {
        "sessions", "session", "upload.get", "todos", "repos", "ticket.targets",
        "session.new.job", "session.image",
    };

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
