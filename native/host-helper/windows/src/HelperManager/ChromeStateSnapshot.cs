using System.Text.Json;

namespace WezTerm.WindowsHostHelper;

internal sealed record ChromeStateSnapshot(int Schema, string Mode, int Port, int? Pid, bool Alive)
{
    public static ChromeStateSnapshot? LoadFromFile(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return null;
        }

        var text = File.ReadAllText(path);
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        using var doc = JsonDocument.Parse(text);
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var schema = root.TryGetProperty("schema", out var schemaProp) && schemaProp.ValueKind == JsonValueKind.Number
            ? schemaProp.GetInt32()
            : 0;
        var mode = root.TryGetProperty("mode", out var modeProp) && modeProp.ValueKind == JsonValueKind.String
            ? modeProp.GetString() ?? string.Empty
            : string.Empty;
        var port = root.TryGetProperty("port", out var portProp) && portProp.ValueKind == JsonValueKind.Number
            ? portProp.GetInt32()
            : 0;
        int? pid = null;
        if (root.TryGetProperty("pid", out var pidProp) && pidProp.ValueKind == JsonValueKind.Number)
        {
            pid = pidProp.GetInt32();
        }
        // Schema v1 has no `alive` field. Treat its presence of mode != none as alive=true,
        // so reconcile still kicks in for stale v1 records left over before upgrade.
        var alive = root.TryGetProperty("alive", out var aliveProp) && aliveProp.ValueKind == JsonValueKind.False
            ? false
            : !string.Equals(mode, "none", StringComparison.OrdinalIgnoreCase);

        return new ChromeStateSnapshot(schema, mode, port, pid, alive);
    }
}
