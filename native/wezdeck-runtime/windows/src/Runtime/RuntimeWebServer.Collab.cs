using Microsoft.AspNetCore.Http;

namespace WezDeck.Runtime;

// Read-only `delegate api` passthrough (docs/cross-repo-collab.md): GET
// /api/v1/collab/<command> → WSL bridge `collab.<command>`. The allowlist
// mirrors native/wezdeck-wsl/collab.go collabFlags; never a generic bridge proxy.
internal sealed partial class RuntimeWebServer
{
    private const string CollabPrefix = "/api/v1/collab/";

    private static readonly Dictionary<string, string[]> CollabQueryKeys = new(StringComparer.Ordinal)
    {
        ["health"] = Array.Empty<string>(),
        ["list"] = new[] { "status", "repo", "parent", "since", "limit" },
        ["show"] = new[] { "id" },
        ["events"] = new[] { "after", "ticket", "limit" },
        ["run"] = new[] { "run" },
        ["prompt"] = new[] { "sha" },
        ["transcript"] = new[] { "run", "tail" },
        ["metrics"] = new[] { "window", "ticket", "parent" },
    };

    private async Task<bool> TryHandleCollabAsync(HttpContext context)
    {
        var requestPath = context.Request.Path.Value?.ToLowerInvariant() ?? string.Empty;
        if (!requestPath.StartsWith(CollabPrefix, StringComparison.Ordinal))
        {
            return false;
        }

        var collabAction = requestPath.Substring(CollabPrefix.Length);
        if (!CollabQueryKeys.TryGetValue(collabAction, out var allowedKeys))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            await WriteJsonAsync(context, new Dictionary<string, object?> { ["error"] = "not_found" });
            return true;
        }

        var collabPayload = new Dictionary<string, string>();
        foreach (var key in allowedKeys)
        {
            var value = context.Request.Query[key].ToString();
            if (!string.IsNullOrEmpty(value))
            {
                collabPayload[key] = value;
            }
        }

        await WriteJsonAsync(context, ReadBridge("collab", collabAction, collabPayload));
        return true;
    }
}
