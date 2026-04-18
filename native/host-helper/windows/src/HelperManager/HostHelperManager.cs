using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace WezTerm.WindowsHostHelper;

internal sealed class HostHelperManager : IDisposable
{
    private readonly HelperConfig config;
    private readonly StructuredLogger logger;
    private readonly ManualResetEventSlim stopSignal = new(initialState: false);
    private readonly long startedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private readonly ClipboardService? clipboardService;
    private readonly System.Threading.Timer heartbeatTimer;
    private readonly InstanceRegistry instanceRegistry;
    private string lastError = string.Empty;
    private bool disposed;

    public HostHelperManager(HelperConfig config)
    {
        this.config = config;
        logger = new StructuredLogger(config.Diagnostics);
        instanceRegistry = new InstanceRegistry(Path.Combine(Path.GetDirectoryName(config.StatePath) ?? config.RuntimeDir, "window-cache.json"));
        clipboardService = new ClipboardService(config, logger);

        heartbeatTimer = new System.Threading.Timer(_ => WriteHelperState("1", lastError), null, Timeout.Infinite, Timeout.Infinite);
    }

    public void Run()
    {
        EnsureDirectory(Path.GetDirectoryName(config.StatePath));

        WriteHelperState("1", string.Empty);
        logger.Info("alt_o", "helper manager started", new Dictionary<string, string?>
        {
            ["ipc_endpoint"] = config.IpcEndpoint,
            ["runtime_dir"] = config.RuntimeDir,
            ["state_path"] = config.StatePath,
        });

        clipboardService?.Start();
        heartbeatTimer.Change(config.HeartbeatIntervalMs, config.HeartbeatIntervalMs);
        StartRequestServer();

        stopSignal.Wait();
    }

    public void ReportFatalError(string message)
    {
        lastError = message ?? string.Empty;
        WriteHelperState("0", lastError);
        logger.Error("alt_o", "helper manager crashed", new Dictionary<string, string?>
        {
            ["error"] = lastError,
            ["runtime_dir"] = config.RuntimeDir,
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
        clipboardService?.Dispose();
        stopSignal.Dispose();
    }

    private void StartRequestServer()
    {
        var serverThread = new Thread(RequestServerLoop)
        {
            IsBackground = true,
            Name = "wezterm-host-helper-ipc",
        };
        serverThread.Start();
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
                var responseJson = HandleRequestJson(requestJson, $"pipe:{config.IpcEndpoint}");
                NamedPipeTransport.WriteMessage(server, responseJson);
            }
            catch (Exception ex)
            {
                if (stopSignal.IsSet)
                {
                    return;
                }

                logger.Error("alt_o", "helper ipc server loop failed", new Dictionary<string, string?>
                {
                    ["error"] = ex.Message,
                    ["ipc_endpoint"] = config.IpcEndpoint,
                });
                Thread.Sleep(100);
            }
        }
    }

    private string HandleRequestJson(string requestJson, string transport)
    {
        string requestKind = "unknown";
        var requestCategory = "alt_o";
        string traceId = string.Empty;

        try
        {
            var request = JsonSerializer.Deserialize<HelperRequest>(requestJson, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true,
            }) ?? throw new InvalidOperationException("request payload was empty");

            requestKind = string.IsNullOrWhiteSpace(request.Kind) ? "unknown" : request.Kind;
            traceId = string.IsNullOrWhiteSpace(request.TraceId) ? Guid.NewGuid().ToString("N") : request.TraceId;
            requestCategory = requestKind switch
            {
                "chrome_focus_or_start" => "chrome",
                "clipboard_resolve_for_paste" => "clipboard",
                "clipboard_write_text" => "clipboard",
                "clipboard_write_image_file" => "clipboard",
                _ => "alt_o",
            };

            logger.Info(requestCategory, "helper received request", new Dictionary<string, string?>
            {
                ["trace_id"] = traceId,
                ["kind"] = requestKind,
                ["transport"] = transport,
            });

            var outcome = requestKind switch
            {
                "vscode_focus_or_open" => InvokeVscodeRequest(request.Payload, traceId),
                "chrome_focus_or_start" => InvokeChromeRequest(request.Payload, traceId),
                "clipboard_resolve_for_paste" => InvokeClipboardResolveRequest(traceId),
                "clipboard_write_text" => InvokeClipboardWriteTextRequest(request.Payload, traceId),
                "clipboard_write_image_file" => InvokeClipboardWriteImageFileRequest(request.Payload, traceId),
                _ => throw new InvalidOperationException($"unknown request kind: {requestKind}"),
            };

            logger.Info(requestCategory, "helper completed request", new Dictionary<string, string?>
            {
                ["kind"] = requestKind,
                ["trace_id"] = traceId,
                ["status"] = outcome.Status,
                ["decision_path"] = outcome.DecisionPath,
                ["pid"] = outcome.ProcessId?.ToString(),
                ["hwnd"] = outcome.WindowHandle?.ToString(),
                ["transport"] = transport,
            });

            return JsonSerializer.Serialize(HelperResponse.Success(traceId, outcome));
        }
        catch (Exception ex)
        {
            lastError = ex.Message;
            WriteHelperState("1", lastError);
            logger.Error(requestCategory, "helper request failed", new Dictionary<string, string?>
            {
                ["trace_id"] = traceId,
                ["kind"] = requestKind,
                ["error"] = ex.Message,
                ["transport"] = transport,
            });

            return JsonSerializer.Serialize(HelperResponse.Failure(traceId, "request_failed", ex.Message));
        }
    }

    private RequestOutcome InvokeClipboardResolveRequest(string traceId)
    {
        if (clipboardService == null)
        {
            throw new InvalidOperationException("clipboard service is unavailable");
        }

        var state = clipboardService.ResolveForPaste();
        logger.Info("clipboard", "resolved clipboard state for paste", new Dictionary<string, string?>
        {
            ["trace_id"] = traceId,
            ["kind"] = state.Kind,
            ["sequence"] = state.Sequence,
            ["formats"] = state.Formats,
            ["text_length"] = string.IsNullOrEmpty(state.TextValue) ? "0" : state.TextValue.Length.ToString(),
            ["windows_path"] = state.WindowsPath,
            ["wsl_path"] = state.WslPath,
            ["last_error"] = state.LastError,
            ["decision_path"] = "clipboard_service",
        });

        return new RequestOutcome(
            Status: state.Kind == "image" ? "resolved_image" : "resolved_text",
            DecisionPath: "clipboard_service",
            ClipboardKind: state.Kind,
            ClipboardSequence: state.Sequence,
            ClipboardFormats: state.Formats,
            ClipboardText: state.TextValue,
            ClipboardWindowsPath: state.WindowsPath,
            ClipboardWslPath: state.WslPath,
            ClipboardDistro: state.Distro,
            ClipboardLastError: state.LastError);
    }

    private RequestOutcome InvokeClipboardWriteTextRequest(JsonElement payload, string traceId)
    {
        if (clipboardService == null)
        {
            throw new InvalidOperationException("clipboard service is unavailable");
        }

        var text = RequireString(payload, "text");
        var state = clipboardService.WriteText(text);
        logger.Info("clipboard", "wrote text to clipboard", new Dictionary<string, string?>
        {
            ["trace_id"] = traceId,
            ["text_length"] = text.Length.ToString(),
            ["kind"] = state.Kind,
            ["sequence"] = state.Sequence,
            ["formats"] = state.Formats,
            ["decision_path"] = "clipboard_service_write_text",
        });

        return new RequestOutcome(
            Status: "clipboard_written_text",
            DecisionPath: "clipboard_service_write_text",
            ClipboardKind: state.Kind,
            ClipboardSequence: state.Sequence,
            ClipboardFormats: state.Formats,
            ClipboardText: state.TextValue,
            ClipboardWindowsPath: state.WindowsPath,
            ClipboardWslPath: state.WslPath,
            ClipboardDistro: state.Distro,
            ClipboardLastError: state.LastError);
    }

    private RequestOutcome InvokeClipboardWriteImageFileRequest(JsonElement payload, string traceId)
    {
        if (clipboardService == null)
        {
            throw new InvalidOperationException("clipboard service is unavailable");
        }

        var imagePath = RequireString(payload, "image_path");
        var state = clipboardService.WriteImageFromFile(imagePath);
        logger.Info("clipboard", "wrote image file to clipboard", new Dictionary<string, string?>
        {
            ["trace_id"] = traceId,
            ["image_path"] = imagePath,
            ["kind"] = state.Kind,
            ["sequence"] = state.Sequence,
            ["formats"] = state.Formats,
            ["decision_path"] = "clipboard_service_write_image_file",
        });

        return new RequestOutcome(
            Status: "clipboard_written_image",
            DecisionPath: "clipboard_service_write_image_file",
            ClipboardKind: state.Kind,
            ClipboardSequence: state.Sequence,
            ClipboardFormats: state.Formats,
            ClipboardText: state.TextValue,
            ClipboardWindowsPath: state.WindowsPath,
            ClipboardWslPath: state.WslPath,
            ClipboardDistro: state.Distro,
            ClipboardLastError: state.LastError);
    }

    private RequestOutcome InvokeVscodeRequest(JsonElement payload, string traceId)
    {
        var requestedDir = NormalizeWslPath(RequireString(payload, "requested_dir"));
        var distro = RequireString(payload, "distro");
        var targetDir = ResolveWorktreeRoot(requestedDir, distro);
        var command = GetStringArray(payload, "code_command").ToArray();
        if (command.Length == 0)
        {
            command = new[] { "code" };
        }

        var codeExecutable = command[0];
        var codeArguments = command.Skip(1).ToList();
        var processName = GetProcessNameFromExecutable(codeExecutable, "Code");
        var launchKey = BuildWindowCacheKey(distro, targetDir);
        var folderUri = BuildVscodeFolderUri(distro, targetDir);
        var matchSpec = new LaunchMatchSpec(
            InstanceType: "vscode",
            LaunchKey: launchKey,
            ProcessName: processName,
            CommandLineMatcher: commandLine => commandLine.Contains(folderUri, StringComparison.OrdinalIgnoreCase),
            ReuseMode: ReuseMode.Strict);
        var existingVisibleWindowHandles = CaptureVisibleProcessWindowHandles(processName);

        logger.Info("alt_o", "resolved vscode target", new Dictionary<string, string?>
        {
            ["trace_id"] = traceId,
            ["requested_dir"] = requestedDir,
            ["target_dir"] = targetDir,
            ["launch_key"] = launchKey,
        });

        var reuseDecision = EvaluateReuse(matchSpec, GetForegroundWindowInfo(), 1000);
        logger.Info("alt_o", "evaluated vscode reuse candidates", new Dictionary<string, string?>
        {
            ["trace_id"] = traceId,
            ["launch_key"] = launchKey,
            ["reuse_mode"] = matchSpec.ReuseMode.ToString(),
            ["registry_hit"] = reuseDecision.RegistryHit ? "1" : "0",
            ["matched_process_count"] = reuseDecision.MatchedProcessCount.ToString(),
            ["matched_process_ids"] = FormatProcessIds(reuseDecision.MatchedProcessIds),
            ["matched_window_found"] = reuseDecision.MatchedWindowFound ? "1" : "0",
            ["decision_path"] = reuseDecision.Path,
            ["existing_visible_window_count"] = existingVisibleWindowHandles.Count.ToString(),
            ["folder_uri"] = folderUri,
        });
        if (reuseDecision.Window != null)
        {
            logger.Info("alt_o", "focused cached vscode window", new Dictionary<string, string?>
            {
                ["trace_id"] = traceId,
                ["target_dir"] = targetDir,
                ["launch_key"] = launchKey,
                ["pid"] = reuseDecision.Window.ProcessId.ToString(),
                ["hwnd"] = reuseDecision.Window.WindowHandle.ToInt64().ToString(),
                ["decision_path"] = reuseDecision.Path,
            });
            return new RequestOutcome(
                Status: "reused",
                DecisionPath: reuseDecision.Path,
                ProcessId: reuseDecision.Window.ProcessId,
                WindowHandle: reuseDecision.Window.WindowHandle.ToInt64());
        }

        var initialForeground = GetForegroundWindowInfo();
        LaunchDetachedProcess(codeExecutable, codeArguments.Concat(new[] { "--folder-uri", folderUri }).ToArray());
        logger.Info("alt_o", "launched vscode", new Dictionary<string, string?>
        {
            ["trace_id"] = traceId,
            ["target_dir"] = targetDir,
            ["folder_uri"] = folderUri,
            ["code_executable"] = codeExecutable,
            ["decision_path"] = "launch",
        });

        WindowMatch? boundWindow = WaitForForegroundProcessWindow(processName, initialForeground, 4000);
        string decisionPath;
        var focusedWindow = boundWindow;
        if (focusedWindow != null)
        {
            instanceRegistry.RememberWindow("vscode", launchKey, focusedWindow);
            decisionPath = "launch_bind_foreground_window";
            logger.Info("alt_o", "captured vscode window after launch", new Dictionary<string, string?>
            {
                ["trace_id"] = traceId,
                ["target_dir"] = targetDir,
                ["launch_key"] = launchKey,
                ["pid"] = focusedWindow.ProcessId.ToString(),
                ["hwnd"] = focusedWindow.WindowHandle.ToInt64().ToString(),
                ["decision_path"] = decisionPath,
            });
        }
        else
        {
            var launchedWindow = WaitForWindowForMatchingProcessIds(matchSpec, 4000);
            launchedWindow ??= WaitForNewProcessWindow(processName, existingVisibleWindowHandles, 4000);
            if (launchedWindow != null && TryActivateWindow(launchedWindow))
            {
                boundWindow = launchedWindow;
                decisionPath = existingVisibleWindowHandles.Contains(launchedWindow.WindowHandle)
                    ? "launch_bind_existing_visible_window"
                    : "launch_bind_new_visible_window";
                instanceRegistry.RememberWindow("vscode", launchKey, launchedWindow);
                logger.Info("alt_o", "focused vscode window after launch fallback", new Dictionary<string, string?>
                {
                    ["trace_id"] = traceId,
                    ["target_dir"] = targetDir,
                    ["launch_key"] = launchKey,
                    ["pid"] = launchedWindow.ProcessId.ToString(),
                    ["hwnd"] = launchedWindow.WindowHandle.ToInt64().ToString(),
                    ["decision_path"] = decisionPath,
                });
            }
            else
            {
                decisionPath = "launch_unbound";
                logger.Info("alt_o", "no vscode foreground window captured after launch", new Dictionary<string, string?>
                {
                    ["trace_id"] = traceId,
                    ["target_dir"] = targetDir,
                    ["launch_key"] = launchKey,
                    ["decision_path"] = decisionPath,
                });
            }
        }

        return new RequestOutcome(
            Status: "launched",
            DecisionPath: boundWindow != null ? decisionPath : "launch_unbound",
            ProcessId: boundWindow?.ProcessId,
            WindowHandle: boundWindow?.WindowHandle.ToInt64());
    }

    private RequestOutcome InvokeChromeRequest(JsonElement payload, string traceId)
    {
        var chromePath = RequireString(payload, "chrome_path");
        var port = RequireInt(payload, "remote_debugging_port");
        var userDataDir = RequireString(payload, "user_data_dir");
        var chromeProcessName = GetProcessNameFromExecutable(chromePath, "chrome");
        var launchKey = BuildChromeCacheKey(port, userDataDir);
        var normalizedUserDataDir = NormalizeWindowsPath(userDataDir);
        var matchSpec = new LaunchMatchSpec(
            InstanceType: "chrome",
            LaunchKey: launchKey,
            ProcessName: chromeProcessName,
            CommandLineMatcher: commandLine =>
                commandLine.Contains($"--remote-debugging-port={port}", StringComparison.OrdinalIgnoreCase)
                && NormalizeWindowsPath(commandLine).Contains(normalizedUserDataDir, StringComparison.OrdinalIgnoreCase),
            ReuseMode: ReuseMode.PreferReuse);
        var initialForeground = GetForegroundWindowInfo();
        var existingVisibleWindowHandles = CaptureVisibleProcessWindowHandles(chromeProcessName);

        var reuseDecision = EvaluateReuse(matchSpec, initialForeground, 1000);
        logger.Info("chrome", "evaluated chrome reuse candidates", new Dictionary<string, string?>
        {
            ["trace_id"] = traceId,
            ["launch_key"] = launchKey,
            ["reuse_mode"] = matchSpec.ReuseMode.ToString(),
            ["registry_hit"] = reuseDecision.RegistryHit ? "1" : "0",
            ["matched_process_count"] = reuseDecision.MatchedProcessCount.ToString(),
            ["matched_process_ids"] = FormatProcessIds(reuseDecision.MatchedProcessIds),
            ["matched_window_found"] = reuseDecision.MatchedWindowFound ? "1" : "0",
            ["decision_path"] = reuseDecision.Path,
            ["existing_visible_window_count"] = existingVisibleWindowHandles.Count.ToString(),
            ["normalized_user_data_dir"] = normalizedUserDataDir,
            ["port"] = port.ToString(),
        });
        if (reuseDecision.Window != null)
        {
            logger.Info("chrome", "focused cached debug chrome window", new Dictionary<string, string?>
            {
                ["trace_id"] = traceId,
                ["launch_key"] = launchKey,
                ["pid"] = reuseDecision.Window.ProcessId.ToString(),
                ["hwnd"] = reuseDecision.Window.WindowHandle.ToInt64().ToString(),
                ["port"] = port.ToString(),
                ["user_data_dir"] = userDataDir,
                ["decision_path"] = reuseDecision.Path,
            });
            return new RequestOutcome(
                Status: "reused",
                DecisionPath: reuseDecision.Path,
                ProcessId: reuseDecision.Window.ProcessId,
                WindowHandle: reuseDecision.Window.WindowHandle.ToInt64());
        }

        LaunchDetachedProcess(chromePath, new[]
        {
            $"--remote-debugging-port={port}",
            $"--user-data-dir={userDataDir}",
        });
        logger.Info("chrome", "launched debug chrome", new Dictionary<string, string?>
        {
            ["trace_id"] = traceId,
            ["chrome_path"] = chromePath,
            ["port"] = port.ToString(),
            ["user_data_dir"] = userDataDir,
            ["decision_path"] = "launch",
        });

        var launchedWindow = WaitForWindowForMatchingProcessIds(matchSpec, 4000);
        launchedWindow ??= WaitForForegroundProcessWindow(chromeProcessName, initialForeground, 4000);
        launchedWindow ??= WaitForNewProcessWindow(chromeProcessName, existingVisibleWindowHandles, 4000);
        if (launchedWindow != null)
        {
            TryActivateWindow(launchedWindow);
            instanceRegistry.RememberWindow("chrome", launchKey, launchedWindow);
            var boundPidWasPreexisting = reuseDecision.MatchedProcessIds.Contains(launchedWindow.ProcessId);
            var decisionPath = existingVisibleWindowHandles.Contains(launchedWindow.WindowHandle)
                ? "launch_bind_existing_visible_window"
                : "launch_bind_new_visible_window";
            logger.Info("chrome", "bound launched debug chrome window", new Dictionary<string, string?>
            {
                ["trace_id"] = traceId,
                ["launch_key"] = launchKey,
                ["pid"] = launchedWindow.ProcessId.ToString(),
                ["hwnd"] = launchedWindow.WindowHandle.ToInt64().ToString(),
                ["port"] = port.ToString(),
                ["user_data_dir"] = userDataDir,
                ["decision_path"] = decisionPath,
                ["bound_pid_was_preexisting"] = boundPidWasPreexisting ? "1" : "0",
            });
            return new RequestOutcome(
                Status: boundPidWasPreexisting ? "launch_handoff_existing" : "launched",
                DecisionPath: decisionPath,
                ProcessId: launchedWindow.ProcessId,
                WindowHandle: launchedWindow.WindowHandle.ToInt64());
        }

        logger.Warn("chrome", "launched debug chrome but did not bind a reusable window", new Dictionary<string, string?>
        {
            ["trace_id"] = traceId,
            ["launch_key"] = launchKey,
            ["port"] = port.ToString(),
            ["user_data_dir"] = userDataDir,
            ["decision_path"] = "launch_unbound",
        });
        return new RequestOutcome(
            Status: "launched",
            DecisionPath: "launch_unbound");
    }

    private static WindowMatch? WaitForAnyProcessWindow(string expectedProcessName, int timeoutMs)
    {
        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.ElapsedMilliseconds < timeoutMs)
        {
            foreach (var process in Process.GetProcessesByName(expectedProcessName))
            {
                try
                {
                    process.Refresh();
                    if (process.MainWindowHandle != IntPtr.Zero)
                    {
                        return new WindowMatch(process.Id, process.MainWindowHandle);
                    }
                }
                finally
                {
                    process.Dispose();
                }
            }

            Thread.Sleep(50);
        }

        return null;
    }

    private static HashSet<IntPtr> CaptureVisibleProcessWindowHandles(string expectedProcessName)
    {
        var windowHandles = new HashSet<IntPtr>();
        foreach (var process in Process.GetProcessesByName(expectedProcessName))
        {
            try
            {
                process.Refresh();
                if (process.MainWindowHandle != IntPtr.Zero)
                {
                    windowHandles.Add(process.MainWindowHandle);
                }
            }
            finally
            {
                process.Dispose();
            }
        }

        return windowHandles;
    }

    private static WindowMatch? WaitForNewProcessWindow(string expectedProcessName, IReadOnlySet<IntPtr> existingWindowHandles, int timeoutMs)
    {
        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.ElapsedMilliseconds < timeoutMs)
        {
            foreach (var process in Process.GetProcessesByName(expectedProcessName))
            {
                try
                {
                    process.Refresh();
                    if (process.MainWindowHandle != IntPtr.Zero && !existingWindowHandles.Contains(process.MainWindowHandle))
                    {
                        return new WindowMatch(process.Id, process.MainWindowHandle);
                    }
                }
                finally
                {
                    process.Dispose();
                }
            }

            Thread.Sleep(50);
        }

        return null;
    }

    private string ResolveWorktreeRoot(string directory, string distribution)
    {
        var normalizedDirectory = NormalizeWslPath(directory);
        var currentPath = normalizedDirectory;
        while (!string.IsNullOrWhiteSpace(currentPath))
        {
            var uncPath = ConvertToWslUncPath(currentPath, distribution);
            if (!string.IsNullOrWhiteSpace(uncPath) && Directory.Exists(uncPath))
            {
                if (Directory.Exists(Path.Combine(uncPath, ".git")) || File.Exists(Path.Combine(uncPath, ".git")))
                {
                    return currentPath;
                }
            }

            if (currentPath == "/")
            {
                break;
            }

            currentPath = GetWslParentPath(currentPath);
        }

        return normalizedDirectory;
    }

    private ReuseDecision EvaluateReuse(LaunchMatchSpec spec, ForegroundWindowInfo? initialForeground, int timeoutMs)
    {
        var persistedWindow = instanceRegistry.GetWindow(spec.InstanceType, spec.LaunchKey, spec.ProcessName);
        if (persistedWindow != null)
        {
            if (!TryActivateWindow(persistedWindow))
            {
                return new ReuseDecision(null, "registry_window_activation_failed", true, 0, false, Array.Empty<int>());
            }

            instanceRegistry.RememberWindow(spec.InstanceType, spec.LaunchKey, persistedWindow);
            return new ReuseDecision(persistedWindow, "registry_window", true, 0, false, Array.Empty<int>());
        }

        var matchingWindow = FindWindowForMatchingProcesses(spec);
        if (matchingWindow != null)
        {
            instanceRegistry.RememberWindow(spec.InstanceType, spec.LaunchKey, matchingWindow);
            if (TryActivateWindow(matchingWindow))
            {
                return new ReuseDecision(matchingWindow, "matched_window", false, 1, true, new[] { matchingWindow.ProcessId });
            }

            return new ReuseDecision(null, "matched_window_activation_failed", false, 1, true, new[] { matchingWindow.ProcessId });
        }

        var matchingProcessIds = FindMatchingProcessIds(spec);
        if (spec.ReuseMode != ReuseMode.PreferReuse)
        {
            return new ReuseDecision(null, matchingProcessIds.Count > 0 ? "matched_process_without_window" : "no_match", false, matchingProcessIds.Count, false, matchingProcessIds);
        }

        if (matchingProcessIds.Count == 0)
        {
            return new ReuseDecision(null, "no_match", false, 0, false, matchingProcessIds);
        }

        var reboundWindow = TryRebindExistingInstance(spec, matchingProcessIds, initialForeground, timeoutMs);
        if (reboundWindow != null)
        {
            return new ReuseDecision(reboundWindow, "matched_process_rebind", false, matchingProcessIds.Count, false, matchingProcessIds);
        }

        return new ReuseDecision(null, "matched_process_rebind_failed", false, matchingProcessIds.Count, false, matchingProcessIds);
    }

    private static string FormatProcessIds(IReadOnlyList<int> processIds)
    {
        return processIds.Count == 0
            ? string.Empty
            : string.Join(",", processIds.OrderBy(processId => processId));
    }

    private WindowMatch? TryRebindExistingInstance(LaunchMatchSpec spec, IReadOnlyCollection<int> matchingProcessIds, ForegroundWindowInfo? initialForeground, int timeoutMs)
    {
        var existingWindow = FindWindowForProcessIds(spec.ProcessName, matchingProcessIds);
        if (existingWindow != null && TryActivateWindow(existingWindow))
        {
            instanceRegistry.RememberWindow(spec.InstanceType, spec.LaunchKey, existingWindow);
            return existingWindow;
        }

        foreach (var processId in matchingProcessIds)
        {
            var processWindow = NativeMethods.TryGetProcessMainWindow(processId);
            if (processWindow == IntPtr.Zero)
            {
                continue;
            }

            var processWindowMatch = new WindowMatch(processId, processWindow);
            if (!TryActivateWindow(processWindowMatch))
            {
                continue;
            }

            var activatedWindow = WaitForForegroundProcessWindow(spec.ProcessName, initialForeground, timeoutMs)
                ?? WaitForWindowForProcessIds(spec.ProcessName, matchingProcessIds, timeoutMs)
                ?? processWindowMatch;
            if (activatedWindow != null)
            {
                instanceRegistry.RememberWindow(spec.InstanceType, spec.LaunchKey, activatedWindow);
                return activatedWindow;
            }
        }

        return null;
    }

    private static WindowMatch? WaitForForegroundProcessWindow(string expectedProcessName, ForegroundWindowInfo? initialForeground, int timeoutMs)
    {
        var stopwatch = Stopwatch.StartNew();
        var acceptSameWindow = initialForeground == null || !string.Equals(initialForeground.ProcessName, expectedProcessName, StringComparison.OrdinalIgnoreCase);

        while (stopwatch.ElapsedMilliseconds < timeoutMs)
        {
            var foreground = GetForegroundWindowInfo();
            if (foreground != null && string.Equals(foreground.ProcessName, expectedProcessName, StringComparison.OrdinalIgnoreCase))
            {
                if (acceptSameWindow ||
                    foreground.ProcessId != initialForeground?.ProcessId ||
                    foreground.WindowHandle != initialForeground.WindowHandle)
                {
                    return new WindowMatch(foreground.ProcessId, foreground.WindowHandle);
                }
            }

            Thread.Sleep(50);
        }

        return null;
    }

    private static ForegroundWindowInfo? GetForegroundWindowInfo()
    {
        var windowHandle = NativeMethods.GetForegroundWindow();
        if (windowHandle == IntPtr.Zero || !NativeMethods.IsWindow(windowHandle))
        {
            return null;
        }

        NativeMethods.GetWindowThreadProcessId(windowHandle, out var processId);
        if (processId == 0)
        {
            return null;
        }

        try
        {
            using var process = Process.GetProcessById((int)processId);
            return new ForegroundWindowInfo(process.Id, process.ProcessName, windowHandle);
        }
        catch
        {
            return null;
        }
    }

    private static List<int> FindMatchingProcessIds(LaunchMatchSpec spec)
    {
        var matchingProcessIds = new List<int>();

        foreach (var process in Process.GetProcessesByName(spec.ProcessName))
        {
            try
            {
                var commandLine = ProcessCommandLineReader.TryGetCommandLine(process.Id);
                if (!string.IsNullOrWhiteSpace(commandLine) && spec.CommandLineMatcher(commandLine))
                {
                    matchingProcessIds.Add(process.Id);
                }
            }
            finally
            {
                process.Dispose();
            }
        }

        return matchingProcessIds;
    }

    private static WindowMatch? WaitForWindowForMatchingProcessIds(LaunchMatchSpec spec, int timeoutMs)
    {
        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.ElapsedMilliseconds < timeoutMs)
        {
            var window = FindWindowForMatchingProcesses(spec);
            if (window != null)
            {
                return window;
            }

            Thread.Sleep(50);
        }

        return null;
    }

    private static WindowMatch? FindWindowForMatchingProcesses(LaunchMatchSpec spec)
    {
        foreach (var process in Process.GetProcessesByName(spec.ProcessName))
        {
            try
            {
                var commandLine = ProcessCommandLineReader.TryGetCommandLine(process.Id);
                if (string.IsNullOrWhiteSpace(commandLine) || !spec.CommandLineMatcher(commandLine))
                {
                    continue;
                }

                process.Refresh();
                if (process.MainWindowHandle != IntPtr.Zero)
                {
                    return new WindowMatch(process.Id, process.MainWindowHandle);
                }
            }
            finally
            {
                process.Dispose();
            }
        }

        return null;
    }

    private static WindowMatch? WaitForWindowForProcessIds(string expectedProcessName, IReadOnlyCollection<int> matchingProcessIds, int timeoutMs)
    {
        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.ElapsedMilliseconds < timeoutMs)
        {
            var window = FindWindowForProcessIds(expectedProcessName, matchingProcessIds);
            if (window != null)
            {
                return window;
            }

            Thread.Sleep(50);
        }

        return null;
    }

    private static WindowMatch? FindWindowForProcessIds(string expectedProcessName, IReadOnlyCollection<int> matchingProcessIds)
    {
        if (matchingProcessIds.Count == 0)
        {
            return null;
        }

        foreach (var process in Process.GetProcessesByName(expectedProcessName))
        {
            try
            {
                process.Refresh();
                if (process.MainWindowHandle == IntPtr.Zero)
                {
                    continue;
                }

                if (matchingProcessIds.Contains(process.Id))
                {
                    return new WindowMatch(process.Id, process.MainWindowHandle);
                }
            }
            finally
            {
                process.Dispose();
            }
        }

        return null;
    }

    private static void LaunchDetachedProcess(string executable, IReadOnlyList<string> arguments)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            UseShellExecute = true,
            WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        };

        foreach (var item in arguments)
        {
            startInfo.ArgumentList.Add(item);
        }

        using var process = Process.Start(startInfo) ?? throw new InvalidOperationException($"failed to launch {executable}");
    }

    private static bool TryActivateWindow(WindowMatch window)
    {
        if (window.WindowHandle == IntPtr.Zero || !NativeMethods.IsWindow(window.WindowHandle))
        {
            return false;
        }

        var showCode = NativeMethods.IsIconic(window.WindowHandle) ? 9 : 5;
        NativeMethods.ShowWindowAsync(window.WindowHandle, showCode);
        Thread.Sleep(5);

        var foregroundWindow = NativeMethods.GetForegroundWindow();
        var foregroundThreadId = foregroundWindow == IntPtr.Zero
            ? 0
            : NativeMethods.GetWindowThreadProcessId(foregroundWindow, out _);
        var targetThreadId = NativeMethods.GetWindowThreadProcessId(window.WindowHandle, out _);
        var currentThreadId = NativeMethods.GetCurrentThreadId();

        var attachedToForeground = false;
        var attachedToTarget = false;
        try
        {
            if (foregroundThreadId != 0 && foregroundThreadId != currentThreadId)
            {
                attachedToForeground = NativeMethods.AttachThreadInput(currentThreadId, foregroundThreadId, true);
            }

            if (targetThreadId != 0 && targetThreadId != currentThreadId)
            {
                attachedToTarget = NativeMethods.AttachThreadInput(currentThreadId, targetThreadId, true);
            }

            NativeMethods.BringWindowToTop(window.WindowHandle);
            NativeMethods.SetActiveWindow(window.WindowHandle);
            NativeMethods.SetFocus(window.WindowHandle);
            NativeMethods.SendAltKeyTap();
            if (NativeMethods.SetForegroundWindow(window.WindowHandle)
                && WaitForWindowForeground(window.WindowHandle, 250))
            {
                return true;
            }
        }
        finally
        {
            if (attachedToTarget)
            {
                NativeMethods.AttachThreadInput(currentThreadId, targetThreadId, false);
            }

            if (attachedToForeground)
            {
                NativeMethods.AttachThreadInput(currentThreadId, foregroundThreadId, false);
            }
        }

        var processMainWindow = NativeMethods.TryGetProcessMainWindow(window.ProcessId);
        if (processMainWindow != IntPtr.Zero
            && processMainWindow != window.WindowHandle
            && TryActivateWindow(new WindowMatch(window.ProcessId, processMainWindow)))
        {
            return true;
        }

        NativeMethods.BringWindowToTop(window.WindowHandle);
        NativeMethods.SetActiveWindow(window.WindowHandle);
        NativeMethods.SetFocus(window.WindowHandle);
        NativeMethods.SendAltKeyTap();
        NativeMethods.SetForegroundWindow(window.WindowHandle);
        return WaitForWindowForeground(window.WindowHandle, 500);
    }

    private static bool WaitForWindowForeground(IntPtr windowHandle, int timeoutMs)
    {
        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.ElapsedMilliseconds < timeoutMs)
        {
            if (NativeMethods.GetForegroundWindow() == windowHandle)
            {
                return true;
            }

            Thread.Sleep(20);
        }

        return false;
    }

    private static string BuildVscodeFolderUri(string distro, string targetDir)
    {
        return $"vscode-remote://wsl+{Uri.EscapeDataString(distro)}{ConvertToVscodeRemotePath(targetDir)}";
    }

    private static string ConvertToVscodeRemotePath(string path)
    {
        var normalized = path.Replace('\\', '/');
        var segments = normalized.Split('/', StringSplitOptions.None)
            .Select(Uri.EscapeDataString);
        return string.Join("/", segments);
    }

    private static string BuildWindowCacheKey(string distro, string path)
    {
        return $"{distro}|{NormalizeWslPath(path)}";
    }

    private static string BuildChromeCacheKey(int port, string userDataDir)
    {
        return $"{port}|{NormalizeWindowsPath(userDataDir)}";
    }

    private static string NormalizeWslPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return string.Empty;
        }

        var normalized = path.Replace('\\', '/').Trim();
        if (normalized.Length > 1)
        {
            normalized = normalized.TrimEnd('/');
        }

        return string.IsNullOrWhiteSpace(normalized) ? "/" : normalized;
    }

    private static string NormalizeWindowsPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return string.Empty;
        }

        var normalized = path.Replace('/', '\\').Trim().Trim('"');
        if (normalized.Length > 3)
        {
            normalized = normalized.TrimEnd('\\');
        }

        return normalized;
    }

    private static string? GetWslParentPath(string path)
    {
        var normalized = NormalizeWslPath(path);
        if (string.IsNullOrWhiteSpace(normalized) || normalized == "/")
        {
            return null;
        }

        var lastSlash = normalized.LastIndexOf('/');
        if (lastSlash <= 0)
        {
            return "/";
        }

        return normalized[..lastSlash];
    }

    private static string? ConvertToWslUncPath(string path, string distribution)
    {
        var normalized = NormalizeWslPath(path);
        if (string.IsNullOrWhiteSpace(normalized) || !normalized.StartsWith('/'))
        {
            return null;
        }

        var relative = normalized.TrimStart('/').Replace('/', '\\');
        if (string.IsNullOrWhiteSpace(relative))
        {
            return @"\\wsl$\" + distribution + @"\";
        }

        return @"\\wsl$\" + distribution + @"\" + relative;
    }

    private static string GetProcessNameFromExecutable(string executable, string fallback)
    {
        var processName = Path.GetFileNameWithoutExtension(executable);
        return string.IsNullOrWhiteSpace(processName) ? fallback : processName;
    }

    private void WriteHelperState(string ready, string lastErrorValue)
    {
        EnsureDirectory(Path.GetDirectoryName(config.StatePath));

        var lines = new[]
        {
            "version=3",
            $"ready={Sanitize(lastErrorValue == string.Empty ? ready : ready)}",
            $"pid={Environment.ProcessId}",
            $"started_at_ms={startedAtMs}",
            $"heartbeat_at_ms={DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}",
            $"ipc_endpoint={Sanitize(config.IpcEndpoint)}",
            $"config_hash={Sanitize(config.ConfigHash)}",
            $"runtime_dir={Sanitize(config.RuntimeDir)}",
            $"last_error={Sanitize(lastErrorValue)}",
        };

        WriteAtomicTextFile(config.StatePath, string.Join("\r\n", lines) + "\r\n");
    }

    private static string? GetOptionalString(JsonElement payload, string propertyName)
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

    private static string RequireString(JsonElement payload, string propertyName)
    {
        var value = GetOptionalString(payload, propertyName);
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new InvalidOperationException($"missing {propertyName}");
        }

        return value;
    }

    private static int RequireInt(JsonElement payload, string propertyName)
    {
        if (!payload.TryGetProperty(propertyName, out var property) || !property.TryGetInt32(out var value))
        {
            throw new InvalidOperationException($"missing {propertyName}");
        }

        return value;
    }

    private static IEnumerable<string> GetStringArray(JsonElement payload, string propertyName)
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

    internal static void WriteAtomicTextFile(string path, string content)
    {
        var tempPath = $"{path}.tmp.{Environment.ProcessId}";
        File.WriteAllText(tempPath, content, new UTF8Encoding(false));
        File.Move(tempPath, path, overwrite: true);
    }

    internal static void EnsureDirectory(string? path)
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
