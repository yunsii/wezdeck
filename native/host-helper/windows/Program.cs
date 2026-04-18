using System.Text;
using System.Text.Json;

namespace WezTerm.WindowsHostHelper;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length > 0 && string.Equals(args[0], "request", StringComparison.OrdinalIgnoreCase))
        {
            return RunRequestMode(args[1..]);
        }

        if (!TryParseServerArgs(args, out var configPath, out var parseError))
        {
            return ExitWithError(parseError);
        }

        HelperConfig config;
        try
        {
            config = HelperConfig.Load(configPath!);
        }
        catch (Exception ex)
        {
            return ExitWithError($"failed to load config: {ex.Message}");
        }

        using var mutex = new Mutex(initiallyOwned: true, name: @"Local\WezTermRuntimeHelperManager", createdNew: out var createdNew);
        if (!createdNew)
        {
            return 0;
        }

        var manager = new HostHelperManager(config);
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
            error = "usage: helper-manager.exe --config <path>";
            return false;
        }

        return true;
    }

    private static int RunRequestMode(string[] args)
    {
        if (!TryParseRequestArgs(args, out var pipeEndpoint, out var payloadBase64, out var timeoutMs, out var parseError))
        {
            return ExitWithError(parseError);
        }

        try
        {
            var payloadJson = Encoding.UTF8.GetString(Convert.FromBase64String(payloadBase64!));
            using var client = NamedPipeTransport.Connect(pipeEndpoint!, timeoutMs);
            NamedPipeTransport.WriteMessage(client, payloadJson);
            var responseJson = NamedPipeTransport.ReadMessage(client);

            var response = JsonSerializer.Deserialize<HelperResponse>(responseJson, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true,
            });

            return response?.Ok == true ? 0 : 1;
        }
        catch (Exception ex)
        {
            return ExitWithError($"request failed: {ex.Message}");
        }
    }

    private static bool TryParseRequestArgs(string[] args, out string? pipeEndpoint, out string? payloadBase64, out int timeoutMs, out string? error)
    {
        pipeEndpoint = null;
        payloadBase64 = null;
        timeoutMs = 5000;
        error = null;

        for (var index = 0; index < args.Length; index += 1)
        {
            var arg = args[index];
            if (string.Equals(arg, "--pipe", StringComparison.OrdinalIgnoreCase))
            {
                if (index + 1 >= args.Length)
                {
                    error = "missing value for --pipe";
                    return false;
                }

                pipeEndpoint = args[index + 1];
                index += 1;
                continue;
            }

            if (string.Equals(arg, "--payload-base64", StringComparison.OrdinalIgnoreCase))
            {
                if (index + 1 >= args.Length)
                {
                    error = "missing value for --payload-base64";
                    return false;
                }

                payloadBase64 = args[index + 1];
                index += 1;
                continue;
            }

            if (string.Equals(arg, "--timeout-ms", StringComparison.OrdinalIgnoreCase))
            {
                if (index + 1 >= args.Length || !int.TryParse(args[index + 1], out timeoutMs) || timeoutMs <= 0)
                {
                    error = "missing or invalid value for --timeout-ms";
                    return false;
                }

                index += 1;
            }
        }

        if (string.IsNullOrWhiteSpace(pipeEndpoint) || string.IsNullOrWhiteSpace(payloadBase64))
        {
            error = "usage: helper-manager.exe request --pipe <endpoint> --payload-base64 <payload> [--timeout-ms 5000]";
            return false;
        }

        return true;
    }

    private static int ExitWithError(string? message)
    {
        try
        {
            var text = string.IsNullOrWhiteSpace(message) ? "helper-manager failed" : message;
            File.AppendAllText(
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "wezterm-runtime-helper", "manager-bootstrap.log"),
                $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {text}{Environment.NewLine}",
                new UTF8Encoding(false));
        }
        catch
        {
        }

        return 1;
    }
}
