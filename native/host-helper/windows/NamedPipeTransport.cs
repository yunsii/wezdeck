using System.IO.Pipes;
using System.Text;

namespace WezTerm.WindowsHostHelper;

internal static class NamedPipeTransport
{
    private const string WindowsPipePrefix = @"\\.\pipe\";
    private const int MaxMessageBytes = 1024 * 1024;

    public static NamedPipeServerStream CreateServer(string endpoint)
    {
        return new NamedPipeServerStream(
            NormalizePipeName(endpoint),
            PipeDirection.InOut,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.None);
    }

    public static NamedPipeClientStream Connect(string endpoint, int timeoutMs)
    {
        var client = new NamedPipeClientStream(
            ".",
            NormalizePipeName(endpoint),
            PipeDirection.InOut,
            PipeOptions.None);

        client.Connect(timeoutMs);
        return client;
    }

    public static void WriteMessage(Stream stream, string message)
    {
        var payload = Encoding.UTF8.GetBytes(message);
        if (payload.Length > MaxMessageBytes)
        {
            throw new InvalidOperationException($"message exceeded {MaxMessageBytes} bytes");
        }

        var lengthBytes = BitConverter.GetBytes(payload.Length);
        stream.Write(lengthBytes, 0, lengthBytes.Length);
        stream.Write(payload, 0, payload.Length);
        stream.Flush();
    }

    public static string ReadMessage(Stream stream)
    {
        var lengthBytes = ReadExact(stream, sizeof(int));
        var length = BitConverter.ToInt32(lengthBytes, 0);
        if (length < 0 || length > MaxMessageBytes)
        {
            throw new InvalidOperationException($"invalid message length: {length}");
        }

        var payload = ReadExact(stream, length);
        return Encoding.UTF8.GetString(payload);
    }

    private static byte[] ReadExact(Stream stream, int length)
    {
        var buffer = new byte[length];
        var offset = 0;
        while (offset < length)
        {
            var read = stream.Read(buffer, offset, length - offset);
            if (read <= 0)
            {
                throw new EndOfStreamException("unexpected end of stream");
            }

            offset += read;
        }

        return buffer;
    }

    private static string NormalizePipeName(string endpoint)
    {
        if (string.IsNullOrWhiteSpace(endpoint))
        {
            throw new InvalidOperationException("pipe endpoint was empty");
        }

        return endpoint.StartsWith(WindowsPipePrefix, StringComparison.OrdinalIgnoreCase)
            ? endpoint[WindowsPipePrefix.Length..]
            : endpoint;
    }
}
