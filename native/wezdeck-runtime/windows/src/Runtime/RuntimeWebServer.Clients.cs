using System.Collections.Concurrent;
using System.Globalization;
using Microsoft.AspNetCore.Http;

namespace WezDeck.Runtime;

// Who is using this Runtime from the host (docs/remote-sessions.md "Local
// reads and writes"): each browser (or script) is one Origin + User-Agent;
// the console's 设备授权 lists them so the owner sees every local source,
// not only this tab. In memory: a Runtime restart starts the list afresh.
// GET /api/v1/clients.
internal sealed partial class RuntimeWebServer
{
    private const int ClientsMax = 50;
    private const int ClientUaMax = 300;

    private sealed class ClientRecord
    {
        public required string Origin { get; init; }
        public required string UserAgent { get; init; }
        public long FirstSeenMs { get; init; }
        public long LastSeenMs;
        public long Requests;
        public long Writes;
        public int Live;
    }

    private readonly ConcurrentDictionary<string, ClientRecord> clients = new();

    private const string ClientItem = "wezdeck.client";

    // a write that passed the origin / body checks (a refused one is not counted)
    private static void CountWrite(HttpContext context)
    {
        if (context.Items[ClientItem] is ClientRecord record) Interlocked.Increment(ref record.Writes);
    }

    private ClientRecord TrackClient(HttpContext context)
    {
        var origin = context.Request.Headers.Origin.ToString();
        var ua = context.Request.Headers.UserAgent.ToString();
        if (ua.Length > ClientUaMax) ua = ua[..ClientUaMax];
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var record = clients.GetOrAdd(origin + "\n" + ua, _ => new ClientRecord
        {
            Origin = origin,
            UserAgent = ua,
            FirstSeenMs = now,
        });
        Interlocked.Exchange(ref record.LastSeenMs, now);
        Interlocked.Increment(ref record.Requests);
        if (clients.Count > ClientsMax)
        {
            // the longest unseen one goes (never one with a live socket)
            var oldest = clients
                .Where(entry => Volatile.Read(ref entry.Value.Live) == 0)
                .OrderBy(entry => Interlocked.Read(ref entry.Value.LastSeenMs))
                .FirstOrDefault();
            if (oldest.Key is not null) clients.TryRemove(oldest.Key, out _);
        }
        return record;
    }

    private object ReadClients() => new Dictionary<string, object?>
    {
        ["since_ms"] = startedAtMs,
        ["clients"] = clients.Values
            .OrderByDescending(record => Interlocked.Read(ref record.LastSeenMs))
            .Select(record => new Dictionary<string, object?>
            {
                ["origin"] = record.Origin,
                ["user_agent"] = record.UserAgent,
                ["first_seen"] = Iso(record.FirstSeenMs),
                ["last_seen"] = Iso(Interlocked.Read(ref record.LastSeenMs)),
                ["requests"] = Interlocked.Read(ref record.Requests),
                ["writes"] = Interlocked.Read(ref record.Writes),
                ["live"] = Volatile.Read(ref record.Live),
            })
            .ToArray(),
    };

    private static string Iso(long ms) =>
        DateTimeOffset.FromUnixTimeMilliseconds(ms).ToString("O", CultureInfo.InvariantCulture);
}
