using System.Buffers.Binary;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace WezDeck.Runtime;

internal sealed class WslBridge : IDisposable
{
    private readonly Func<string> distro;
    private readonly Func<string> user;
    private readonly Func<string> windowsHome;
    private readonly Func<string> repoRoot;
    private readonly object gate = new();
    private Process? process;

    public WslBridge(Func<string> distro, Func<string> user, Func<string> windowsHome, Func<string> repoRoot)
    {
        this.distro = distro;
        this.user = user;
        this.windowsHome = windowsHome;
        this.repoRoot = repoRoot;
    }

    public JsonElement Call(string domain, string action, object payload, int timeoutMs)
    {
        var request = JsonSerializer.Serialize(new
        {
            version = 2,
            trace_id = Guid.NewGuid().ToString("N"),
            domain,
            action,
            payload,
        });
        var frame = Encode(request);
        lock (gate)
        {
            Ensure();
            var stdout = process!.StandardOutput.BaseStream;
            var stdin = process.StandardInput.BaseStream;
            stdin.Write(frame);
            stdin.Flush();
            if (!TryRead(stdout, timeoutMs, out var body))
            {
                Stop();
                throw new IOException("wsl bridge timed out");
            }
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            if (!root.TryGetProperty("ok", out var ok) || !ok.GetBoolean())
            {
                var error = root.TryGetProperty("error", out var message) ? message.GetString() : "wsl bridge error";
                throw new InvalidOperationException(error);
            }
            return root.TryGetProperty("result", out var result)
                ? result.Clone()
                : JsonSerializer.SerializeToElement(new { });
        }
    }

    public void Dispose() => Stop();

    private void Ensure()
    {
        if (process is { HasExited: false })
        {
            return;
        }
        var home = WindowsPathToWsl(windowsHome());
        var start = new ProcessStartInfo
        {
            FileName = "wsl.exe",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        var distroName = distro();
        if (!string.IsNullOrWhiteSpace(distroName))
        {
            start.ArgumentList.Add("-d");
            start.ArgumentList.Add(distroName);
        }
        var userName = user();
        if (!string.IsNullOrWhiteSpace(userName))
        {
            start.ArgumentList.Add("--user");
            start.ArgumentList.Add(userName);
        }
        start.ArgumentList.Add("--");
        start.ArgumentList.Add("bash");
        start.ArgumentList.Add("-lc");
        start.ArgumentList.Add("WEZDECK_WINDOWS_HOME=" + Shell(home) + " " + Shell(BridgeBinary()) + " attach; echo wezdeck-wsl-attach-exit:$? >&2");
        process = Process.Start(start) ?? throw new IOException("wsl bridge did not start");
    }

    private string BridgeBinary()
    {
        var root = repoRoot().Trim().TrimEnd('/');
        return string.IsNullOrWhiteSpace(root)
            ? "wezdeck-wsl"
            : root + "/native/wezdeck-wsl/bin/wezdeck-wsl";
    }

    private void Stop()
    {
        if (process == null) return;
        try { process.Kill(entireProcessTree: true); } catch { }
        process.Dispose();
        process = null;
    }

    private static byte[] Encode(string json)
    {
        var body = Encoding.UTF8.GetBytes(json);
        var frame = new byte[4 + body.Length];
        BinaryPrimitives.WriteInt32LittleEndian(frame, body.Length);
        body.CopyTo(frame, 4);
        return frame;
    }

    private static bool TryRead(Stream stream, int timeoutMs, out byte[] body)
    {
        body = Array.Empty<byte>();
        var head = ReadExact(stream, 4, timeoutMs);
        if (head == null) return false;
        var size = BinaryPrimitives.ReadInt32LittleEndian(head);
        if (size < 0 || size > 8 * 1024 * 1024) return false;
        var payload = ReadExact(stream, size, timeoutMs);
        if (payload == null) return false;
        body = payload;
        return true;
    }

    private static byte[]? ReadExact(Stream stream, int size, int timeoutMs)
    {
        var buffer = new byte[size];
        var offset = 0;
        var deadline = Environment.TickCount64 + timeoutMs;
        while (offset < size)
        {
            if (Environment.TickCount64 > deadline) return null;
            var read = stream.Read(buffer, offset, size - offset);
            if (read == 0) return null;
            offset += read;
        }
        return buffer;
    }

    private static string WindowsPathToWsl(string windowsPath)
    {
        var full = Path.GetFullPath(windowsPath).Replace('\\', '/');
        if (full.Length >= 3 && full[1] == ':' && full[2] == '/')
        {
            return "/mnt/" + char.ToLowerInvariant(full[0]) + full[2..];
        }
        return string.Empty;
    }

    private static string Shell(string value) => "'" + value.Replace("'", "'\\''") + "'";
}
