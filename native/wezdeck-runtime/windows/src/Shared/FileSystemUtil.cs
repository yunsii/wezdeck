using System.Text;

namespace WezDeck.Runtime;

internal static class FileSystemUtil
{
    public static void EnsureDirectory(string? path)
    {
        if (!string.IsNullOrWhiteSpace(path))
        {
            Directory.CreateDirectory(path);
        }
    }

    public static void WriteAtomicTextFile(string path, string content)
    {
        var tempPath = $"{path}.tmp.{Environment.ProcessId}";
        File.WriteAllText(tempPath, content, new UTF8Encoding(false));
        // WezTerm / AV may briefly lock state.env; retry then fall back to
        // in-place overwrite so a stuck lock cannot take down the helper.
        for (var attempt = 1; attempt <= 5; attempt += 1)
        {
            try
            {
                File.Move(tempPath, path, overwrite: true);
                return;
            }
            catch (IOException) when (attempt < 5)
            {
                Thread.Sleep(40 * attempt);
            }
            catch (UnauthorizedAccessException) when (attempt < 5)
            {
                Thread.Sleep(40 * attempt);
            }
        }

        try
        {
            File.WriteAllText(path, content, new UTF8Encoding(false));
        }
        finally
        {
            try { File.Delete(tempPath); } catch { /* ignore */ }
        }
    }

    public static string Sanitize(string? value)
    {
        return (value ?? string.Empty).Replace("\r", " ").Replace("\n", " ").Trim();
    }
}
