using System.Text;
using System.Text.Json;

namespace WezTerm.WindowsHostHelper;

internal static class HelperCtlProgram
{
    private static int Main(string[] args)
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

            WriteResponseEnv(response);
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
            if (string.Equals(arg, "request", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

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
            error = "usage: helperctl.exe request --pipe <endpoint> --payload-base64 <payload> [--timeout-ms 5000]";
            return false;
        }

        return true;
    }

    private static void WriteResponseEnv(HelperResponse? response)
    {
        if (response == null)
        {
            return;
        }

        var lines = new List<string>
        {
            "version=1",
            $"ok={(response.Ok ? "1" : "0")}",
            $"trace_id={Sanitize(response.TraceId)}",
            $"status={Sanitize(response.Status)}",
            $"decision_path={Sanitize(response.DecisionPath)}",
        };

        if (response.Result?.Pid is int pid)
        {
            lines.Add($"pid={pid}");
        }

        if (response.Result?.Hwnd is long hwnd)
        {
            lines.Add($"hwnd={hwnd}");
        }

        if (!string.IsNullOrWhiteSpace(response.Result?.Kind))
        {
            lines.Add($"kind={Sanitize(response.Result.Kind)}");
        }

        if (!string.IsNullOrWhiteSpace(response.Result?.Sequence))
        {
            lines.Add($"sequence={Sanitize(response.Result.Sequence)}");
        }

        if (!string.IsNullOrWhiteSpace(response.Result?.Formats))
        {
            lines.Add($"formats={Sanitize(response.Result.Formats)}");
        }

        if (!string.IsNullOrWhiteSpace(response.Result?.Text))
        {
            lines.Add($"text={Sanitize(response.Result.Text)}");
        }

        if (!string.IsNullOrWhiteSpace(response.Result?.WindowsPath))
        {
            lines.Add($"windows_path={Sanitize(response.Result.WindowsPath)}");
        }

        if (!string.IsNullOrWhiteSpace(response.Result?.WslPath))
        {
            lines.Add($"wsl_path={Sanitize(response.Result.WslPath)}");
        }

        if (!string.IsNullOrWhiteSpace(response.Result?.Distro))
        {
            lines.Add($"distro={Sanitize(response.Result.Distro)}");
        }

        if (!string.IsNullOrWhiteSpace(response.Result?.LastError))
        {
            lines.Add($"last_error={Sanitize(response.Result.LastError)}");
        }

        if (!string.IsNullOrWhiteSpace(response.Error?.Code))
        {
            lines.Add($"error_code={Sanitize(response.Error.Code)}");
        }

        if (!string.IsNullOrWhiteSpace(response.Error?.Message))
        {
            lines.Add($"error_message={Sanitize(response.Error.Message)}");
        }

        Console.Out.Write(string.Join(Environment.NewLine, lines));
        Console.Out.Write(Environment.NewLine);
    }

    private static string Sanitize(string? value)
    {
        return (value ?? string.Empty).Replace("\r", " ").Replace("\n", " ").Trim();
    }

    private static int ExitWithError(string? message)
    {
        try
        {
            var text = string.IsNullOrWhiteSpace(message) ? "helperctl failed" : message;
            File.AppendAllText(
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "wezterm-runtime-helper", "helperctl-bootstrap.log"),
                $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {text}{Environment.NewLine}",
                new UTF8Encoding(false));
        }
        catch
        {
        }

        return 1;
    }
}
