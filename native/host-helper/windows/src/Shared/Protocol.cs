using System.Text.Json;
using System.Text.Json.Serialization;

namespace WezTerm.WindowsHostHelper;

internal sealed class HelperRequest
{
    [JsonPropertyName("version")]
    public int Version { get; init; } = 1;

    [JsonPropertyName("trace_id")]
    public string? TraceId { get; init; }

    [JsonPropertyName("kind")]
    public string? Kind { get; init; }

    [JsonPropertyName("payload")]
    public JsonElement Payload { get; init; }
}

internal sealed class HelperResponse
{
    [JsonPropertyName("version")]
    public int Version { get; init; } = 1;

    [JsonPropertyName("trace_id")]
    public string TraceId { get; init; } = string.Empty;

    [JsonPropertyName("ok")]
    public bool Ok { get; init; }

    [JsonPropertyName("status")]
    public string Status { get; init; } = string.Empty;

    [JsonPropertyName("decision_path")]
    public string DecisionPath { get; init; } = string.Empty;

    [JsonPropertyName("result")]
    public HelperResponseResult? Result { get; init; }

    [JsonPropertyName("error")]
    public HelperError? Error { get; init; }

    public static HelperResponse Success(string traceId, RequestOutcome outcome)
    {
        return new HelperResponse
        {
            TraceId = traceId,
            Ok = true,
            Status = outcome.Status,
            DecisionPath = outcome.DecisionPath,
            Result = new HelperResponseResult
            {
                Pid = outcome.ProcessId,
                Hwnd = outcome.WindowHandle,
                Kind = outcome.ClipboardKind,
                Sequence = outcome.ClipboardSequence,
                Formats = outcome.ClipboardFormats,
                Text = outcome.ClipboardText,
                WindowsPath = outcome.ClipboardWindowsPath,
                WslPath = outcome.ClipboardWslPath,
                Distro = outcome.ClipboardDistro,
                LastError = outcome.ClipboardLastError,
            },
        };
    }

    public static HelperResponse Failure(string traceId, string code, string message)
    {
        return new HelperResponse
        {
            TraceId = traceId,
            Ok = false,
            Status = "failed",
            DecisionPath = "error",
            Error = new HelperError
            {
                Code = code,
                Message = message,
            },
        };
    }
}

internal sealed class HelperResponseResult
{
    [JsonPropertyName("pid")]
    public int? Pid { get; init; }

    [JsonPropertyName("hwnd")]
    public long? Hwnd { get; init; }

    [JsonPropertyName("kind")]
    public string? Kind { get; init; }

    [JsonPropertyName("sequence")]
    public string? Sequence { get; init; }

    [JsonPropertyName("formats")]
    public string? Formats { get; init; }

    [JsonPropertyName("text")]
    public string? Text { get; init; }

    [JsonPropertyName("windows_path")]
    public string? WindowsPath { get; init; }

    [JsonPropertyName("wsl_path")]
    public string? WslPath { get; init; }

    [JsonPropertyName("distro")]
    public string? Distro { get; init; }

    [JsonPropertyName("last_error")]
    public string? LastError { get; init; }
}

internal sealed class HelperError
{
    [JsonPropertyName("code")]
    public string Code { get; init; } = string.Empty;

    [JsonPropertyName("message")]
    public string Message { get; init; } = string.Empty;
}

internal sealed record RequestOutcome(
    string Status,
    string DecisionPath,
    int? ProcessId = null,
    long? WindowHandle = null,
    string? ClipboardKind = null,
    string? ClipboardSequence = null,
    string? ClipboardFormats = null,
    string? ClipboardText = null,
    string? ClipboardWindowsPath = null,
    string? ClipboardWslPath = null,
    string? ClipboardDistro = null,
    string? ClipboardLastError = null);
