using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace WezTerm.WindowsHostHelper;

internal sealed record ClipboardState(
    string Kind,
    string Sequence,
    string UpdatedAtMs,
    string HeartbeatAtMs,
    string ListenerPid,
    string ListenerStartedAtMs,
    string Distro,
    string WindowsPath,
    string WslPath,
    string LastError)
{
    public static ClipboardState Starting() => new(
        Kind: "starting",
        Sequence: string.Empty,
        UpdatedAtMs: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(),
        HeartbeatAtMs: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(),
        ListenerPid: Environment.ProcessId.ToString(),
        ListenerStartedAtMs: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(),
        Distro: string.Empty,
        WindowsPath: string.Empty,
        WslPath: string.Empty,
        LastError: string.Empty);

    public static ClipboardState Text(string sequence) => Starting() with
    {
        Kind = "text",
        Sequence = sequence,
        UpdatedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(),
    };

    public static ClipboardState Image(string sequence, string windowsPath, string wslPath, string? distro) => Starting() with
    {
        Kind = "image",
        Sequence = sequence,
        UpdatedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(),
        Distro = distro ?? string.Empty,
        WindowsPath = windowsPath,
        WslPath = wslPath,
    };

    public static ClipboardState Unknown(string error, string sequence = "") => Starting() with
    {
        Kind = "unknown",
        Sequence = sequence,
        UpdatedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(),
        LastError = error,
    };
}

internal sealed record WindowCacheEntry(int ProcessId, IntPtr WindowHandle, DateTime? ProcessStartTimeUtc);
internal sealed record WindowMatch(int ProcessId, IntPtr WindowHandle);
internal sealed record ForegroundWindowInfo(int ProcessId, string ProcessName, IntPtr WindowHandle);
internal sealed record PersistentWindowCacheEntry(int ProcessId, long WindowHandle, DateTime? ProcessStartTimeUtc);
internal sealed record LaunchMatchSpec(
    string InstanceType,
    string LaunchKey,
    string ProcessName,
    Func<string, bool> CommandLineMatcher,
    ReuseMode ReuseMode);
internal sealed record ReuseDecision(
    WindowMatch? Window,
    string Path,
    bool RegistryHit,
    int MatchedProcessCount,
    bool MatchedWindowFound,
    IReadOnlyList<int> MatchedProcessIds);

internal enum ReuseMode
{
    Strict,
    PreferReuse,
}

internal static class ProcessCommandLineReader
{
    private const uint ProcessQueryInformation = 0x0400;
    private const uint ProcessVmRead = 0x0010;

    public static string? TryGetCommandLine(int processId)
    {
        IntPtr processHandle = IntPtr.Zero;
        try
        {
            processHandle = NativeMethods.OpenProcess(ProcessQueryInformation | ProcessVmRead, false, (uint)processId);
            if (processHandle == IntPtr.Zero)
            {
                return null;
            }

            var processInformation = NativeMethods.QueryBasicInformation(processHandle);
            var peb = NativeMethods.ReadStruct<ProcessEnvironmentBlock>(processHandle, processInformation.PebBaseAddress);
            if (peb.ProcessParameters == IntPtr.Zero)
            {
                return null;
            }

            var parameters = NativeMethods.ReadStruct<ProcessParameters>(processHandle, peb.ProcessParameters);
            if (parameters.CommandLine.Buffer == IntPtr.Zero || parameters.CommandLine.Length <= 0)
            {
                return null;
            }

            return NativeMethods.ReadUnicodeString(processHandle, parameters.CommandLine);
        }
        catch
        {
            return null;
        }
        finally
        {
            if (processHandle != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(processHandle);
            }
        }
    }
}

internal sealed class StructuredLogger
{
    private readonly DiagnosticConfig config;
    private readonly object writeLock = new();

    public StructuredLogger(DiagnosticConfig config)
    {
        this.config = config;
    }

    public void Info(string category, string message, IDictionary<string, string?>? fields = null) => Write("info", category, message, fields);
    public void Warn(string category, string message, IDictionary<string, string?>? fields = null) => Write("warn", category, message, fields);
    public void Error(string category, string message, IDictionary<string, string?>? fields = null) => Write("error", category, message, fields);

    private void Write(string level, string category, string message, IDictionary<string, string?>? fields)
    {
        if (!config.Enabled || !config.CategoryEnabled || string.IsNullOrWhiteSpace(config.FilePath))
        {
            return;
        }

        if (LevelRank(level) > LevelRank(config.Level))
        {
            return;
        }

        lock (writeLock)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(config.FilePath!)!);
                RotateIfNeeded();

                var line = new StringBuilder();
                line.Append("ts=").Append(Escape(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff")));
                line.Append(" level=").Append(Escape(level));
                line.Append(" source=").Append(Escape("windows-helper-manager"));
                line.Append(" category=").Append(Escape(category));
                line.Append(" message=").Append(Escape(message));

                if (fields != null)
                {
                    foreach (var item in fields.OrderBy(item => item.Key, StringComparer.Ordinal))
                    {
                        line.Append(' ').Append(item.Key).Append('=').Append(Escape(item.Value));
                    }
                }

                File.AppendAllText(config.FilePath!, line + Environment.NewLine, new UTF8Encoding(false));
            }
            catch
            {
            }
        }
    }

    private void RotateIfNeeded()
    {
        if (config.MaxBytes <= 0 || config.MaxFiles <= 0 || string.IsNullOrWhiteSpace(config.FilePath) || !File.Exists(config.FilePath))
        {
            return;
        }

        var fileInfo = new FileInfo(config.FilePath);
        if (fileInfo.Length < config.MaxBytes)
        {
            return;
        }

        var lastPath = $"{config.FilePath}.{config.MaxFiles}";
        if (File.Exists(lastPath))
        {
            File.Delete(lastPath);
        }

        for (var index = config.MaxFiles - 1; index >= 1; index -= 1)
        {
            var source = $"{config.FilePath}.{index}";
            var destination = $"{config.FilePath}.{index + 1}";
            if (File.Exists(source))
            {
                File.Move(source, destination, overwrite: true);
            }
        }

        File.Move(config.FilePath, $"{config.FilePath}.1", overwrite: true);
    }

    private static int LevelRank(string level) => level switch
    {
        "error" => 1,
        "warn" => 2,
        "info" => 3,
        "debug" => 4,
        _ => 3,
    };

    private static string Escape(string? value)
    {
        var text = (value ?? "nil")
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("\"", "\\\"", StringComparison.Ordinal)
            .Replace("\n", "\\n", StringComparison.Ordinal)
            .Replace("\r", "\\r", StringComparison.Ordinal)
            .Replace("\t", "\\t", StringComparison.Ordinal);
        return $"\"{text}\"";
    }
}

internal sealed class HelperConfig
{
    public required string RuntimeDir { get; init; }
    public required string ScriptsDir { get; init; }
    public required string StatePath { get; init; }
    public required string RequestDir { get; init; }
    public required string PowerShellExe { get; init; }
    public required DiagnosticConfig Diagnostics { get; init; }
    public string? ClipboardStatePath { get; init; }
    public string? ClipboardLogPath { get; init; }
    public string? ClipboardOutputDir { get; init; }
    public string? ClipboardWslDistro { get; init; }
    public int ClipboardHeartbeatIntervalSeconds { get; init; }
    public int ClipboardImageReadRetryCount { get; init; }
    public int ClipboardImageReadRetryDelayMs { get; init; }
    public int ClipboardCleanupMaxAgeHours { get; init; }
    public int ClipboardCleanupMaxFiles { get; init; }
    public int HeartbeatIntervalMs { get; init; }
    public int PollIntervalMs { get; init; }

    public static HelperConfig Load(string path)
    {
        var json = File.ReadAllText(path, new UTF8Encoding(false));
        var config = JsonSerializer.Deserialize<HelperConfig>(json, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        }) ?? throw new InvalidOperationException("config file was empty");

        if (string.IsNullOrWhiteSpace(config.RuntimeDir) ||
            string.IsNullOrWhiteSpace(config.ScriptsDir) ||
            string.IsNullOrWhiteSpace(config.StatePath) ||
            string.IsNullOrWhiteSpace(config.RequestDir))
        {
            throw new InvalidOperationException("config file is missing required paths");
        }

        return config;
    }
}

internal sealed class DiagnosticConfig
{
    public bool Enabled { get; init; }
    public bool CategoryEnabled { get; init; }
    public string Level { get; init; } = "info";
    public string? FilePath { get; init; }
    public int MaxBytes { get; init; }
    public int MaxFiles { get; init; }
}

internal static class NativeMethods
{
    public const int WmClipboardUpdate = 0x031D;

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AddClipboardFormatListener(IntPtr hwnd);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool RemoveClipboardFormatListener(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern uint GetClipboardSequenceNumber();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr SetActiveWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr SetFocus(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint processAccess, bool bInheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ReadProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, byte[] lpBuffer, int dwSize, out IntPtr lpNumberOfBytesRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr processHandle,
        int processInformationClass,
        ref ProcessBasicInformation processInformation,
        int processInformationLength,
        out int returnLength);

    public static ProcessBasicInformation QueryBasicInformation(IntPtr processHandle)
    {
        var info = new ProcessBasicInformation();
        var status = NtQueryInformationProcess(
            processHandle,
            0,
            ref info,
            Marshal.SizeOf<ProcessBasicInformation>(),
            out _);
        if (status != 0)
        {
            throw new InvalidOperationException($"NtQueryInformationProcess failed with status {status}");
        }

        return info;
    }

    public static T ReadStruct<T>(IntPtr processHandle, IntPtr address) where T : struct
    {
        var size = Marshal.SizeOf<T>();
        var buffer = new byte[size];
        if (!ReadProcessMemory(processHandle, address, buffer, size, out var bytesRead) || bytesRead.ToInt64() < size)
        {
            throw new InvalidOperationException("ReadProcessMemory failed");
        }

        var handle = GCHandle.Alloc(buffer, GCHandleType.Pinned);
        try
        {
            return Marshal.PtrToStructure<T>(handle.AddrOfPinnedObject());
        }
        finally
        {
            handle.Free();
        }
    }

    public static string ReadUnicodeString(IntPtr processHandle, RemoteUnicodeString unicodeString)
    {
        var buffer = new byte[unicodeString.Length];
        if (!ReadProcessMemory(processHandle, unicodeString.Buffer, buffer, buffer.Length, out var bytesRead) || bytesRead.ToInt64() < buffer.Length)
        {
            throw new InvalidOperationException("ReadProcessMemory for command line failed");
        }

        return Encoding.Unicode.GetString(buffer);
    }

    public static void SendAltKeyTap()
    {
        var inputs = new[]
        {
            new Input
            {
                Type = 1,
                Union = new InputUnion
                {
                    Keyboard = new KeyboardInput
                    {
                        VirtualKey = 0x12,
                    }
                }
            },
            new Input
            {
                Type = 1,
                Union = new InputUnion
                {
                    Keyboard = new KeyboardInput
                    {
                        VirtualKey = 0x12,
                        Flags = 0x0002,
                    }
                }
            }
        };

        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>());
    }

    public static bool AppActivate(int processId)
    {
        try
        {
            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null)
            {
                return false;
            }

            var shell = Activator.CreateInstance(shellType);
            if (shell == null)
            {
                return false;
            }

            try
            {
                shellType.InvokeMember("SendKeys", BindingFlags.InvokeMethod, null, shell, new object[] { "%" });
                var result = shellType.InvokeMember("AppActivate", BindingFlags.InvokeMethod, null, shell, new object[] { processId });
                return result is bool ok && ok;
            }
            finally
            {
                Marshal.FinalReleaseComObject(shell);
            }
        }
        catch
        {
            return false;
        }
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, Input[] pInputs, int cbSize);

}

[StructLayout(LayoutKind.Sequential)]
internal struct ProcessBasicInformation
{
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public IntPtr UniqueProcessId;
    public IntPtr Reserved3;
}

[StructLayout(LayoutKind.Sequential)]
internal struct ProcessEnvironmentBlock
{
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 2)]
    public byte[] Reserved1;
    public byte BeingDebugged;
    public byte Reserved2;
    public IntPtr Reserved3_0;
    public IntPtr Reserved3_1;
    public IntPtr Ldr;
    public IntPtr ProcessParameters;
}

[StructLayout(LayoutKind.Sequential)]
internal struct ProcessParameters
{
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
    public byte[] Reserved1;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 10)]
    public IntPtr[] Reserved2;
    public RemoteUnicodeString ImagePathName;
    public RemoteUnicodeString CommandLine;
}

[StructLayout(LayoutKind.Sequential)]
internal struct RemoteUnicodeString
{
    public ushort Length;
    public ushort MaximumLength;
    public IntPtr Buffer;
}

[StructLayout(LayoutKind.Sequential)]
internal struct Input
{
    public uint Type;
    public InputUnion Union;
}

[StructLayout(LayoutKind.Explicit)]
internal struct InputUnion
{
    [FieldOffset(0)]
    public KeyboardInput Keyboard;
}

[StructLayout(LayoutKind.Sequential)]
internal struct KeyboardInput
{
    public ushort VirtualKey;
    public ushort ScanCode;
    public uint Flags;
    public uint Time;
    public IntPtr ExtraInfo;
}
