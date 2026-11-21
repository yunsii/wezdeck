using System.Text;

namespace WezDeck.Runtime;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (!TryParseServerArgs(args, out var configPath, out var parseError))
        {
            return ExitWithError(parseError);
        }

        RuntimeConfig config;
        try
        {
            config = RuntimeConfig.Load(configPath!);
        }
        catch (Exception ex)
        {
            return ExitWithError($"failed to load config: {ex.Message}");
        }

        using var mutex = new Mutex(initiallyOwned: true, name: SingleInstanceMutexName(config.IpcEndpoint), createdNew: out var createdNew);
        if (!createdNew)
        {
            return 0;
        }

        var manager = new RuntimeManager(config);
        AppDomain.CurrentDomain.UnhandledException += (_, eventArgs) =>
        {
            var ex = eventArgs.ExceptionObject as Exception;
            manager.ReportFatalError(ex?.ToString() ?? "unknown unhandled exception");
        };

        try
        {
            manager.Run();
            return 0;
        }
        catch (Exception ex)
        {
            manager.ReportFatalError(ex.ToString());
            return ExitWithError(ex.Message);
        }
    }

    private const string LiveIpcEndpoint = @"\\.\pipe\wezdeck-runtime-v1";

    // One helper per IPC endpoint, not one per machine. The live endpoint keeps
    // the historical mutex name so an older running helper still excludes a
    // newer one; any other endpoint (the sync canary uses `…-v1-canary`) gets
    // its own name, so starting it never needs to evict the live helper.
    internal static string SingleInstanceMutexName(string ipcEndpoint)
    {
        if (string.Equals(ipcEndpoint, LiveIpcEndpoint, StringComparison.OrdinalIgnoreCase))
        {
            return @"Local\WezDeckRuntime";
        }

        var tail = ipcEndpoint;
        var slash = tail.LastIndexOf('\\');
        if (slash >= 0)
        {
            tail = tail[(slash + 1)..];
        }

        var safe = new StringBuilder(tail.Length);
        foreach (var ch in tail)
        {
            safe.Append(char.IsLetterOrDigit(ch) || ch == '-' ? ch : '_');
        }

        return @"Local\WezDeckRuntime-" + safe;
    }

    private static bool TryParseServerArgs(string[] args, out string? configPath, out string? error)
    {
        configPath = null;
        error = null;

        for (var index = 0; index < args.Length; index += 1)
        {
            if (!string.Equals(args[index], "--config", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (index + 1 >= args.Length)
            {
                error = "missing value for --config";
                return false;
            }

            configPath = args[index + 1];
            index += 1;
        }

        if (string.IsNullOrWhiteSpace(configPath))
        {
            error = "usage: wezdeck-runtime.exe --config <path>";
            return false;
        }

        return true;
    }

    private static int ExitWithError(string? message)
    {
        try
        {
            var text = string.IsNullOrWhiteSpace(message) ? "wezdeck-runtime failed" : message;
            var logDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "wezterm-runtime", "logs");
            FileSystemUtil.EnsureDirectory(logDir);
            File.AppendAllText(
                Path.Combine(logDir, "manager-bootstrap.log"),
                $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {text}{Environment.NewLine}",
                new UTF8Encoding(false));
        }
        catch
        {
        }

        return 1;
    }
}
