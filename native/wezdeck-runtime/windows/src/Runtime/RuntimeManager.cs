namespace WezDeck.Runtime;

internal sealed class RuntimeManager : IDisposable
{
    private readonly RuntimeConfig config;
    private readonly StructuredLogger logger;
    private readonly ManualResetEventSlim stopSignal = new(initialState: false);
    private readonly object stateFileWriteLock = new();
    private readonly long startedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private readonly ClipboardService? clipboardService;
    private readonly VscodeRequestHandler vscodeHandler;
    private readonly System.Threading.Timer heartbeatTimer;
    private readonly RequestRouter requestRouter;
    private readonly RuntimeWebServer runtimeWebServer;
    private readonly ForegroundChangeTracker foregroundChangeTracker;
    private readonly WslHealWatcher? wslHealWatcher;
    private string lastError = string.Empty;
    private int heartbeatTickActive;
    private bool disposed;
    private ImeStateSample currentImeSample = new("unknown", null, "uninitialized", "uninitialized");
    private string? lastImeHoldDecisionPath;

    public RuntimeManager(RuntimeConfig config)
    {
        this.config = config;
        logger = new StructuredLogger(config.Diagnostics);

        var instanceRegistry = new InstanceRegistry(config.WindowCachePath ?? Path.Combine(config.RuntimeDir, "window-cache.json"));
        var windowReuseService = new WindowReuseService(instanceRegistry);
        clipboardService = new ClipboardService(config, logger);
        vscodeHandler = new VscodeRequestHandler(logger, windowReuseService);
        var sessionHandler = new SessionRequestHandler(config, logger);
        requestRouter = new RequestRouter(
            logger,
            new ClipboardRequestHandler(clipboardService, logger),
            vscodeHandler,
            sessionHandler,
            new ChromeRequestHandler(logger, windowReuseService),
            new ImeRequestHandler(logger));
        runtimeWebServer = new RuntimeWebServer(config, () => new RuntimeImeStateResult
        {
            Mode = currentImeSample.Mode,
            Lang = currentImeSample.Lang,
            Reason = currentImeSample.Reason,
        }, logger, requestJson => HandleWebRequest(requestJson), vscodeHandler.ReadWindows);
        foregroundChangeTracker = new ForegroundChangeTracker(logger, config.ForegroundSampling);
        if (config.WslHeal is not null)
        {
            wslHealWatcher = new WslHealWatcher(logger, config.WslHeal, ResolveHealWslDistro, instanceRegistry);
        }

        heartbeatTimer = new System.Threading.Timer(_ => RunHeartbeatTick(), null, Timeout.Infinite, Timeout.Infinite);
    }

    public void Run()
    {
        FileSystemUtil.EnsureDirectory(Path.GetDirectoryName(config.StatePath));
        logger.Info("wezdeck_runtime", "starting runtime web server", new Dictionary<string, string?>
        {
            ["http_endpoint"] = runtimeWebServer.Endpoint,
        });
        runtimeWebServer.Start();
        logger.Info("wezdeck_runtime", "runtime web server started", new Dictionary<string, string?>
        {
            ["http_endpoint"] = runtimeWebServer.Endpoint,
        });

        WriteHelperState("1", string.Empty);
        logger.Info("wezdeck_runtime", "helper manager started", new Dictionary<string, string?>
        {
            ["ipc_endpoint"] = config.IpcEndpoint,
            ["http_endpoint"] = runtimeWebServer.Endpoint,
            ["runtime_dir"] = config.RuntimeDir,
            ["state_path"] = config.StatePath,
        });

        clipboardService?.Start();
        heartbeatTimer.Change(config.HeartbeatIntervalMs, config.HeartbeatIntervalMs);

        // Immediate ego badge refresh on helper start (then every ~30s via tick).
        try
        {
            EgoHeartbeatSampler.Tick(logger, config.BrowserAgentStatusPath);
        }
        catch (Exception egoEx)
        {
            logger.Warn("browser_agent", "ego heartbeat startup tick failed", new Dictionary<string, string?>
            {
                ["error"] = egoEx.Message,
                ["status_file"] = config.BrowserAgentStatusPath,
            });
        }

        // Reconcile chrome state file before serving requests so a helper
        // restart does not leave the right-status segment lying about a
        // process that died with the previous helper.
        if (!string.IsNullOrWhiteSpace(config.ChromeDebugStatePath))
        {
            // Pass chromePath / userDataDir into reconcile so the re-subscribed
            // process can also have respawn-watch metadata -- otherwise a
            // helper restart would lose the auto-respawn detection capability
            // for the in-flight chrome until the user next pressed Alt+b.
            var autoStart = config.ChromeDebugAutoStart;
            ChromeLivenessWatcher.ReconcileOnStartup(
                logger,
                config.ChromeDebugStatePath,
                autoStart?.ChromePath,
                autoStart?.UserDataDir);

            // Auto-start headless chrome so 9222 always has a CDP endpoint
            // for MCP / agent tools, without requiring the user to press
            // Alt+b first. Mode-agnostic: if any chrome on this port +
            // user-data-dir is already running (visible or headless), adopt
            // it; otherwise launch with the configured default mode. Never
            // throws -- a missing chrome.exe just logs a warning and skips.
            if (autoStart is { Enabled: true })
            {
                try
                {
                    ChromeRequestHandler.AutoStart(
                        logger,
                        autoStart.ChromePath ?? string.Empty,
                        autoStart.RemoteDebuggingPort,
                        autoStart.UserDataDir ?? string.Empty,
                        config.ChromeDebugStatePath);
                }
                catch (Exception ex)
                {
                    logger.Warn("chrome", "auto-start threw, helper continues", new Dictionary<string, string?>
                    {
                        ["error"] = ex.Message,
                    });
                }
            }
        }

        StartRequestServer();

        stopSignal.Wait();
    }

    public void ReportFatalError(string message)
    {
        lastError = message ?? string.Empty;
        WriteHelperState("0", lastError);
        logger.Error("wezdeck_runtime", "helper manager crashed", new Dictionary<string, string?>
        {
            ["error"] = lastError,
            ["runtime_dir"] = config.RuntimeDir,
        });
    }

    private string HandleWebRequest(string requestJson)
    {
        return requestRouter.HandleRequestJson(requestJson, "http", message =>
        {
            lastError = message;
            WriteHelperState("1", lastError);
        });
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }

        disposed = true;
        heartbeatTimer.Dispose();
        runtimeWebServer.Dispose();
        clipboardService?.Dispose();
        stopSignal.Dispose();
    }

    private void StartRequestServer()
    {
        var serverThread = new Thread(RequestServerLoop)
        {
            IsBackground = true,
            Name = "wezterm-wezdeck-runtime-ipc",
        };
        serverThread.Start();
    }

    private void RunHeartbeatTick()
    {
        if (Interlocked.Exchange(ref heartbeatTickActive, 1) == 1)
        {
            return;
        }

        try
        {
            var imeSample = ImeStateSampler.Sample();
            if (imeSample.DecisionPath is "foreground_not_wezterm" or "no_foreground")
            {
                if (!string.Equals(lastImeHoldDecisionPath, imeSample.DecisionPath, StringComparison.Ordinal))
                {
                    logger.Info("ime", "ime sample held for non-WezTerm foreground", new Dictionary<string, string?>
                    {
                        ["decision_path"] = imeSample.DecisionPath,
                        ["foreground_process"] = "other",
                    });
                    lastImeHoldDecisionPath = imeSample.DecisionPath;
                }
            }
            else
            {
                lastImeHoldDecisionPath = null;
                currentImeSample = imeSample;
            }
            try
            {
                foregroundChangeTracker.Sample();
            }
            catch (Exception fgEx)
            {
                logger.Warn("foreground", "foreground sample failed", new Dictionary<string, string?>
                {
                    ["error"] = fgEx.Message,
                });
            }

            try
            {
                EgoHeartbeatSampler.Tick(logger, config.BrowserAgentStatusPath);
            }
            catch (Exception egoEx)
            {
                logger.Warn("browser_agent", "ego heartbeat tick failed", new Dictionary<string, string?>
                {
                    ["error"] = egoEx.Message,
                    ["status_file"] = config.BrowserAgentStatusPath,
                });
            }

            try
            {
                wslHealWatcher?.Tick();
            }
            catch (Exception healEx)
            {
                logger.Warn("wsl_heal", "heal tick failed", new Dictionary<string, string?>
                {
                    ["error"] = healEx.Message,
                });
            }

            WriteHelperState("1", lastError);
        }
        catch (Exception ex)
        {
            logger.Warn("wezdeck_runtime", "failed to refresh helper heartbeat", new Dictionary<string, string?>
            {
                ["error"] = ex.Message,
                ["state_path"] = config.StatePath,
                ["runtime_dir"] = config.RuntimeDir,
            });
        }
        finally
        {
            Interlocked.Exchange(ref heartbeatTickActive, 0);
        }
    }

    private void RequestServerLoop()
    {
        while (!stopSignal.IsSet)
        {
            try
            {
                using var server = NamedPipeTransport.CreateServer(config.IpcEndpoint);
                server.WaitForConnection();

                var requestJson = NamedPipeTransport.ReadMessage(server);
                var responseJson = requestRouter.HandleRequestJson(requestJson, $"pipe:{config.IpcEndpoint}", message =>
                {
                    lastError = message;
                    WriteHelperState("1", lastError);
                });
                NamedPipeTransport.WriteMessage(server, responseJson);
            }
            catch (Exception ex)
            {
                if (stopSignal.IsSet)
                {
                    return;
                }

                logger.Error("wezdeck_runtime", "helper ipc server loop failed", new Dictionary<string, string?>
                {
                    ["error"] = ex.Message,
                    ["ipc_endpoint"] = config.IpcEndpoint,
                });
                Thread.Sleep(100);
            }
        }
    }

    private void WriteHelperState(string ready, string lastErrorValue)
    {
        lock (stateFileWriteLock)
        {
            FileSystemUtil.EnsureDirectory(Path.GetDirectoryName(config.StatePath));

            var sample = currentImeSample;
            var lines = new[]
            {
                "version=3",
                $"ready={FileSystemUtil.Sanitize(lastErrorValue == string.Empty ? ready : ready)}",
                $"pid={Environment.ProcessId}",
                $"started_at_ms={startedAtMs}",
                $"heartbeat_at_ms={DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}",
                $"ipc_endpoint={FileSystemUtil.Sanitize(config.IpcEndpoint)}",
                $"http_endpoint={FileSystemUtil.Sanitize(runtimeWebServer.Endpoint)}",
                $"http_ready={FileSystemUtil.Sanitize(runtimeWebServer.IsReady ? "1" : "0")}",
                $"config_hash={FileSystemUtil.Sanitize(config.ConfigHash)}",
                $"runtime_dir={FileSystemUtil.Sanitize(config.RuntimeDir)}",
                $"last_error={FileSystemUtil.Sanitize(lastErrorValue)}",
                $"ime_mode={FileSystemUtil.Sanitize(sample.Mode)}",
                $"ime_lang={FileSystemUtil.Sanitize(sample.Lang ?? string.Empty)}",
                $"ime_reason={FileSystemUtil.Sanitize(sample.Reason ?? string.Empty)}",
                $"ime_decision_path={FileSystemUtil.Sanitize(sample.DecisionPath)}",
            };

            FileSystemUtil.WriteAtomicTextFile(config.StatePath, string.Join("\r\n", lines) + "\r\n");
        }
    }

    private string ResolveHealWslDistro()
    {
        if (!string.IsNullOrWhiteSpace(config.ClipboardWslDistro))
        {
            return config.ClipboardWslDistro!;
        }

        try
        {
            var startInfo = new System.Diagnostics.ProcessStartInfo
            {
                FileName = "wsl.exe",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            startInfo.ArgumentList.Add("--list");
            startInfo.ArgumentList.Add("--quiet");
            using var process = System.Diagnostics.Process.Start(startInfo);
            if (process is null)
            {
                return string.Empty;
            }

            // wsl.exe --list writes UTF-16LE; StreamReader default UTF-8 turns
            // "Ubuntu-24.04" into garbage with NULs and -d then exits -1.
            using var ms = new System.IO.MemoryStream();
            process.StandardOutput.BaseStream.CopyTo(ms);
            process.WaitForExit(5_000);
            var bytes = ms.ToArray();
            var output = bytes.Length >= 2 && bytes[1] == 0
                ? System.Text.Encoding.Unicode.GetString(bytes)
                : System.Text.Encoding.UTF8.GetString(bytes);
            foreach (var raw in output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var name = raw.Trim().TrimStart('\uFEFF').Replace("\0", string.Empty);
                if (!string.IsNullOrWhiteSpace(name))
                {
                    return name;
                }
            }
        }
        catch
        {
            // Fall through to default distro (no -d).
        }

        return string.Empty;
    }
}
