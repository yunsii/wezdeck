using System.Drawing;
using System.Drawing.Imaging;
using System.Text;
using System.Windows.Forms;

namespace WezTerm.WindowsHostHelper;

internal sealed class ClipboardService : IDisposable
{
    private readonly HelperConfig config;
    private readonly StructuredLogger logger;
    private readonly object stateLock = new();
    private ClipboardState currentState;
    private Thread? thread;
    private HiddenClipboardForm? form;
    private System.Windows.Forms.Timer? heartbeatTimer;
    private bool disposed;

    public ClipboardService(HelperConfig config, StructuredLogger logger)
    {
        this.config = config;
        this.logger = logger;
        currentState = ClipboardState.Starting();
    }

    public void Start()
    {
        thread = new Thread(RunClipboardThread)
        {
            IsBackground = true,
            Name = "wezterm-clipboard-helper",
        };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }

        disposed = true;
        if (form != null && form.IsHandleCreated)
        {
            try
            {
                form.BeginInvoke(new Action(() => form.Close()));
            }
            catch
            {
            }
        }
    }

    private void RunClipboardThread()
    {
        try
        {
            LogListener("listener bootstrap");
            SetState(ClipboardState.Starting());

            form = new HiddenClipboardForm(this);
            heartbeatTimer = new System.Windows.Forms.Timer
            {
                Interval = Math.Max(config.ClipboardHeartbeatIntervalSeconds, 1) * 1000,
            };
            heartbeatTimer.Tick += (_, _) => WriteStateFile();
            heartbeatTimer.Start();

            RefreshClipboardState();
            Application.Run(form);
        }
        catch (Exception ex)
        {
            LogListener($"listener crashed error={ex.Message}");
            logger.Error("clipboard", "clipboard service crashed", new Dictionary<string, string?>
            {
                ["error"] = ex.Message,
                ["state_path"] = config.ClipboardStatePath,
            });
            SetState(ClipboardState.Unknown(ex.Message));
        }
        finally
        {
            heartbeatTimer?.Stop();
            heartbeatTimer?.Dispose();
            form?.Dispose();
            LogListener("listener shutting down");
        }
    }

    public void RefreshClipboardState()
    {
        try
        {
            var sequence = NativeMethods.GetClipboardSequenceNumber().ToString();
            if (!Clipboard.ContainsImage())
            {
                LogListener($"clipboard kind=text sequence={sequence}");
                SetState(ClipboardState.Text(sequence));
                return;
            }

            EnsureDirectory(config.ClipboardOutputDir);
            using var image = GetClipboardImageWithRetry();
            if (image == null)
            {
                var message = "Clipboard reported an image, but no bitmap data was available.";
                LogListener($"clipboard image unavailable sequence={sequence}");
                SetState(ClipboardState.Unknown(message, sequence));
                return;
            }

            var fileName = $"clipboard-{DateTime.Now:yyyyMMdd-HHmmss}-{Guid.NewGuid():N}"[..34] + ".png";
            var windowsPath = Path.Combine(config.ClipboardOutputDir!, fileName);
            image.Save(windowsPath, ImageFormat.Png);
            var wslPath = ConvertWindowsPathToWsl(windowsPath);
            RemoveStaleExports();
            LogListener($"clipboard kind=image sequence={sequence} windows_path={windowsPath} wsl_path={wslPath}");
            SetState(ClipboardState.Image(sequence, windowsPath, wslPath, config.ClipboardWslDistro));
        }
        catch (Exception ex)
        {
            LogListener($"refresh failed error={ex.Message}");
            SetState(ClipboardState.Unknown(ex.Message));
        }
    }

    private Image? GetClipboardImageWithRetry()
    {
        var attemptCount = Math.Max(config.ClipboardImageReadRetryCount, 1);
        var delayMs = Math.Max(config.ClipboardImageReadRetryDelayMs, 1);

        for (var attempt = 1; attempt <= attemptCount; attempt += 1)
        {
            try
            {
                var image = Clipboard.GetImage();
                if (image != null)
                {
                    return image;
                }
            }
            catch when (attempt < attemptCount)
            {
            }

            if (attempt < attemptCount)
            {
                Thread.Sleep(delayMs);
            }
        }

        return null;
    }

    private void RemoveStaleExports()
    {
        if (string.IsNullOrWhiteSpace(config.ClipboardOutputDir) || !Directory.Exists(config.ClipboardOutputDir))
        {
            return;
        }

        var cutoff = DateTime.UtcNow.AddHours(-1 * Math.Max(config.ClipboardCleanupMaxAgeHours, 1));
        var files = new DirectoryInfo(config.ClipboardOutputDir)
            .EnumerateFiles("clipboard-*.png")
            .OrderByDescending(file => file.LastWriteTimeUtc)
            .ToArray();

        var keepCount = Math.Max(config.ClipboardCleanupMaxFiles, 1);
        for (var index = 0; index < files.Length; index += 1)
        {
            var file = files[index];
            if (file.LastWriteTimeUtc < cutoff || index >= keepCount)
            {
                try
                {
                    file.Delete();
                }
                catch
                {
                }
            }
        }
    }

    private void SetState(ClipboardState state)
    {
        lock (stateLock)
        {
            currentState = state with
            {
                ListenerPid = Environment.ProcessId.ToString(),
                ListenerStartedAtMs = currentState.ListenerStartedAtMs == string.Empty
                    ? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString()
                    : currentState.ListenerStartedAtMs,
            };
            WriteStateFile();
        }
    }

    private void WriteStateFile()
    {
        if (string.IsNullOrWhiteSpace(config.ClipboardStatePath))
        {
            return;
        }

        ClipboardState snapshot;
        lock (stateLock)
        {
            snapshot = currentState with
            {
                HeartbeatAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(),
                UpdatedAtMs = string.IsNullOrWhiteSpace(currentState.UpdatedAtMs)
                    ? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString()
                    : currentState.UpdatedAtMs,
            };
            currentState = snapshot;
        }

        EnsureDirectory(Path.GetDirectoryName(config.ClipboardStatePath));
        var lines = new[]
        {
            "version=1",
            $"kind={Sanitize(snapshot.Kind)}",
            $"sequence={Sanitize(snapshot.Sequence)}",
            $"updated_at_ms={Sanitize(snapshot.UpdatedAtMs)}",
            $"heartbeat_at_ms={Sanitize(snapshot.HeartbeatAtMs)}",
            $"listener_pid={Sanitize(snapshot.ListenerPid)}",
            $"listener_started_at_ms={Sanitize(snapshot.ListenerStartedAtMs)}",
            $"distro={Sanitize(snapshot.Distro)}",
            $"windows_path={Sanitize(snapshot.WindowsPath)}",
            $"wsl_path={Sanitize(snapshot.WslPath)}",
            $"last_error={Sanitize(snapshot.LastError)}",
        };

        HostHelperManager.WriteAtomicTextFile(config.ClipboardStatePath, string.Join("\r\n", lines) + "\r\n");
    }

    private static string ConvertWindowsPathToWsl(string windowsPath)
    {
        var normalized = windowsPath.Replace('\\', '/');
        if (normalized.Length >= 3 && char.IsLetter(normalized[0]) && normalized[1] == ':' && normalized[2] == '/')
        {
            return $"/mnt/{char.ToLowerInvariant(normalized[0])}/{normalized[3..]}";
        }

        return normalized;
    }

    private void LogListener(string message)
    {
        if (string.IsNullOrWhiteSpace(config.ClipboardLogPath))
        {
            return;
        }

        try
        {
            EnsureDirectory(Path.GetDirectoryName(config.ClipboardLogPath));
            File.AppendAllText(config.ClipboardLogPath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {message}{Environment.NewLine}", new UTF8Encoding(false));
        }
        catch
        {
        }
    }

    private static void EnsureDirectory(string? path)
    {
        if (!string.IsNullOrWhiteSpace(path))
        {
            Directory.CreateDirectory(path);
        }
    }

    private static string Sanitize(string? value)
    {
        return (value ?? string.Empty).Replace("\r", " ").Replace("\n", " ").Trim();
    }
}

internal sealed class HiddenClipboardForm : Form
{
    private readonly ClipboardService service;

    public HiddenClipboardForm(ClipboardService service)
    {
        this.service = service;
        ShowInTaskbar = false;
        FormBorderStyle = FormBorderStyle.FixedToolWindow;
        StartPosition = FormStartPosition.Manual;
        Size = new Size(1, 1);
        Location = new Point(-32000, -32000);
        Opacity = 0;
    }

    protected override void SetVisibleCore(bool value)
    {
        base.SetVisibleCore(false);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        NativeMethods.AddClipboardFormatListener(Handle);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && IsHandleCreated)
        {
            NativeMethods.RemoveClipboardFormatListener(Handle);
        }

        base.Dispose(disposing);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == NativeMethods.WmClipboardUpdate)
        {
            service.RefreshClipboardState();
        }

        base.WndProc(ref m);
    }
}
