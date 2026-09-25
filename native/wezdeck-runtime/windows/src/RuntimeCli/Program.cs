using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace WezDeck.Runtime;

internal static class RuntimeCliProgram
{
    private static int Main(string[] args)
    {
        var stopwatch = Stopwatch.StartNew();
        var stage = "parse_args";
        if (!RuntimeCliArguments.TryParseRequest(args, out var request, out var parseError))
        {
            return RuntimeCliBootstrapLog.ExitWithError(parseError, stage, stopwatch.ElapsedMilliseconds);
        }

        try
        {
            stage = "decode_payload";
            var payloadJson = Encoding.UTF8.GetString(Convert.FromBase64String(request!.PayloadBase64));

            stage = "connect_pipe";
            using var client = NamedPipeTransport.Connect(request.PipeEndpoint, request.TimeoutMs);

            stage = "write_request";
            NamedPipeTransport.WriteMessage(client, payloadJson);

            stage = "read_response";
            var responseJson = NamedPipeTransport.ReadMessage(client);

            stage = "parse_response";
            var response = JsonSerializer.Deserialize<RuntimeResponse>(responseJson, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true,
            });

            stage = "write_env";
            RuntimeCliResponseWriter.WriteEnv(response, stopwatch.ElapsedMilliseconds);
            return response?.Ok == true ? 0 : 1;
        }
        catch (Exception ex)
        {
            return RuntimeCliBootstrapLog.ExitWithError(ex, stage, stopwatch.ElapsedMilliseconds);
        }
    }
}
