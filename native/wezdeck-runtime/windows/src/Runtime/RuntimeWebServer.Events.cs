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

// /events: the WebSocket the console listens on, and the heartbeat broadcast
// to every connected socket.
internal sealed partial class RuntimeWebServer
{
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
}
