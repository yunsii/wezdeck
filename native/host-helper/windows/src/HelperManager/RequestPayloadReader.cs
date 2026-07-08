using System.Text.Json;

namespace WezTerm.WindowsHostHelper;

internal static class RequestPayloadReader
{
    public static string RequireString(JsonElement payload, string propertyName)
    {
        var value = GetOptionalString(payload, propertyName);
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new InvalidOperationException($"missing {propertyName}");
        }

        return value;
    }

    public static int RequireInt(JsonElement payload, string propertyName)
    {
        if (!payload.TryGetProperty(propertyName, out var property) || !property.TryGetInt32(out var value))
        {
            throw new InvalidOperationException($"missing {propertyName}");
        }

        return value;
    }

    public static int? GetOptionalPositiveInt(JsonElement payload, string propertyName)
    {
        if (!payload.TryGetProperty(propertyName, out var property))
        {
            return null;
        }

        int value;
        if (property.ValueKind == JsonValueKind.Number)
        {
            if (!property.TryGetInt32(out value))
            {
                return null;
            }
        }
        else if (property.ValueKind == JsonValueKind.String)
        {
            var raw = property.GetString();
            if (string.IsNullOrWhiteSpace(raw) || !int.TryParse(raw, out value))
            {
                return null;
            }
        }
        else
        {
            return null;
        }

        return value > 0 ? value : null;
    }

    public static bool GetOptionalBool(JsonElement payload, string propertyName, bool defaultValue = false)
    {
        if (!payload.TryGetProperty(propertyName, out var property))
        {
            return defaultValue;
        }

        return property.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => defaultValue,
        };
    }

    public static IEnumerable<string> GetStringArray(JsonElement payload, string propertyName)
    {
        if (!payload.TryGetProperty(propertyName, out var property) || property.ValueKind != JsonValueKind.Array)
        {
            yield break;
        }

        foreach (var item in property.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(item.GetString()))
            {
                yield return item.GetString()!;
            }
        }
    }

    public static string? GetOptionalString(JsonElement payload, string propertyName)
    {
        if (!payload.TryGetProperty(propertyName, out var property))
        {
            return null;
        }

        return property.ValueKind switch
        {
            JsonValueKind.String => property.GetString(),
            JsonValueKind.Number => property.GetRawText(),
            _ => null,
        };
    }
}
