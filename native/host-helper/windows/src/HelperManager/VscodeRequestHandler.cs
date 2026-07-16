using System.Text.Json;

namespace WezTerm.WindowsHostHelper;

internal sealed class VscodeRequestHandler
{
    private readonly StructuredLogger logger;
    private readonly WindowReuseService windowReuseService;

    public VscodeRequestHandler(StructuredLogger logger, WindowReuseService windowReuseService)
    {
        this.logger = logger;
        this.windowReuseService = windowReuseService;
    }

    public RequestOutcome FocusOrOpen(JsonElement payload, string traceId)
    {
        var requestedDir = PathResolvers.NormalizeWslPath(RequestPayloadReader.RequireString(payload, "requested_dir"));
        var distro = RequestPayloadReader.RequireString(payload, "distro");
        var targetDir = PathResolvers.ResolveWorktreeRoot(requestedDir, distro);
        var command = RequestPayloadReader.GetStringArray(payload, "code_command").ToArray();
        var maxWindows = RequestPayloadReader.GetOptionalPositiveInt(payload, "max_windows");
        if (command.Length == 0)
        {
            command = new[] { "code" };
        }

        // Optional file target. When present, the window is still resolved and
        // reused by folder (so all files of a repo share one window), and the
        // file is revealed on top: launches append `--file-uri`, and the
        // reuse-existing-window path issues a follow-up `--reuse-window
        // --file-uri` so the already-open window jumps to the file.
        var fileRaw = RequestPayloadReader.GetOptionalString(payload, "file");
        string? fileUri = string.IsNullOrWhiteSpace(fileRaw)
            ? null
            : PathResolvers.BuildVscodeFileUri(distro, PathResolvers.NormalizeWslPath(fileRaw));

        var codeExecutable = command[0];
        var codeArguments = command.Skip(1).ToList();
        var processName = PathResolvers.GetProcessNameFromExecutable(codeExecutable, "Code");
        var launchKey = PathResolvers.BuildWindowCacheKey(distro, targetDir);
        var folderUri = PathResolvers.BuildVscodeFolderUri(distro, targetDir);
        string[] OpenArgs() => fileUri == null
            ? new[] { "--folder-uri", folderUri }
            : new[] { "--folder-uri", folderUri, "--file-uri", fileUri };
        var matchSpec = new LaunchMatchSpec(
            InstanceType: "vscode",
            LaunchKey: launchKey,
            ProcessName: processName,
            CommandLineMatcher: commandLine => commandLine.Contains(folderUri, StringComparison.OrdinalIgnoreCase),
            ReuseMode: ReuseMode.Strict);
        var existingVisibleWindowHandles = WindowQuery.CaptureVisibleProcessWindowHandles(processName);

        logger.Info("vscode", "resolved vscode target", new Dictionary<string, string?>
        {
            ["trace_id"] = traceId,
            ["requested_dir"] = requestedDir,
            ["target_dir"] = targetDir,
            ["launch_key"] = launchKey,
        });

        var reuseDecision = windowReuseService.EvaluateReuse(matchSpec, WindowQuery.GetForegroundWindowInfo(), 1000);
        logger.Info("vscode", "evaluated vscode reuse candidates", new Dictionary<string, string?>
        {
            ["trace_id"] = traceId,
            ["launch_key"] = launchKey,
            ["reuse_mode"] = matchSpec.ReuseMode.ToString(),
            ["registry_hit"] = reuseDecision.RegistryHit ? "1" : "0",
            ["matched_process_count"] = reuseDecision.MatchedProcessCount.ToString(),
            ["matched_process_ids"] = WindowQuery.FormatProcessIds(reuseDecision.MatchedProcessIds),
            ["matched_window_found"] = reuseDecision.MatchedWindowFound ? "1" : "0",
            ["decision_path"] = reuseDecision.Path,
            ["existing_visible_window_count"] = existingVisibleWindowHandles.Count.ToString(),
            ["max_windows"] = maxWindows?.ToString(),
            ["folder_uri"] = folderUri,
        });
        if (reuseDecision.Window != null)
        {
            if (fileUri != null)
            {
                WindowActivator.LaunchDetachedProcess(
                    codeExecutable,
                    codeArguments.Concat(new[] { "--reuse-window", "--file-uri", fileUri }).ToArray());
            }
            logger.Info("vscode", "focused cached vscode window", new Dictionary<string, string?>
            {
                ["trace_id"] = traceId,
                ["target_dir"] = targetDir,
                ["launch_key"] = launchKey,
                ["pid"] = reuseDecision.Window.ProcessId.ToString(),
                ["hwnd"] = reuseDecision.Window.WindowHandle.ToInt64().ToString(),
                ["decision_path"] = reuseDecision.Path,
                ["file_uri"] = fileUri,
            });
            return new RequestOutcome(
                Domain: "vscode",
                Action: "focus_or_open",
                Status: "reused",
                DecisionPath: reuseDecision.Path,
                ResultType: "window_ref",
                Result: new HelperWindowRefResult
                {
                    Pid = reuseDecision.Window.ProcessId,
                    Hwnd = reuseDecision.Window.WindowHandle.ToInt64(),
                },
                ProcessId: reuseDecision.Window.ProcessId,
                WindowHandle: reuseDecision.Window.WindowHandle.ToInt64());
        }

        if (maxWindows.HasValue && existingVisibleWindowHandles.Count >= maxWindows.Value)
        {
            var reuseCandidate = windowReuseService.FindLeastRecentlyUsedWindow("vscode", processName);
            var replacementWindow = reuseCandidate?.Window ?? WindowQuery.FindFirstVisibleProcessWindow(processName);
            if (replacementWindow != null && WindowActivator.TryActivateWindow(replacementWindow))
            {
                WindowActivator.LaunchDetachedProcess(
                    codeExecutable,
                    codeArguments.Concat(new[] { "--reuse-window" }).Concat(OpenArgs()).ToArray());

                if (reuseCandidate != null)
                {
                    windowReuseService.ReplaceWindowKey("vscode", reuseCandidate.LaunchKey, launchKey, replacementWindow);
                }
                else
                {
                    windowReuseService.RememberWindow("vscode", launchKey, replacementWindow);
                }

                logger.Info("vscode", "reused least recently used vscode window because max window count was reached", new Dictionary<string, string?>
                {
                    ["trace_id"] = traceId,
                    ["target_dir"] = targetDir,
                    ["launch_key"] = launchKey,
                    ["replaced_launch_key"] = reuseCandidate?.LaunchKey,
                    ["lru_last_used_at_utc"] = reuseCandidate?.LastUsedAtUtc.ToString("O"),
                    ["pid"] = replacementWindow.ProcessId.ToString(),
                    ["hwnd"] = replacementWindow.WindowHandle.ToInt64().ToString(),
                    ["existing_visible_window_count"] = existingVisibleWindowHandles.Count.ToString(),
                    ["max_windows"] = maxWindows.Value.ToString(),
                    ["decision_path"] = reuseCandidate != null
                        ? "max_windows_reuse_lru_window"
                        : "max_windows_reuse_visible_window",
                });
                return new RequestOutcome(
                    Domain: "vscode",
                    Action: "focus_or_open",
                    Status: "reused",
                    DecisionPath: reuseCandidate != null
                        ? "max_windows_reuse_lru_window"
                        : "max_windows_reuse_visible_window",
                    ResultType: "window_ref",
                    Result: new HelperWindowRefResult
                    {
                        Pid = replacementWindow.ProcessId,
                        Hwnd = replacementWindow.WindowHandle.ToInt64(),
                    },
                    ProcessId: replacementWindow.ProcessId,
                    WindowHandle: replacementWindow.WindowHandle.ToInt64());
            }

            logger.Info("vscode", "max window count was reached but no focusable vscode window was found", new Dictionary<string, string?>
            {
                ["trace_id"] = traceId,
                ["target_dir"] = targetDir,
                ["launch_key"] = launchKey,
                ["existing_visible_window_count"] = existingVisibleWindowHandles.Count.ToString(),
                ["max_windows"] = maxWindows.Value.ToString(),
                ["decision_path"] = "max_windows_no_focusable_window",
            });
        }

        var initialForeground = WindowQuery.GetForegroundWindowInfo();
        WindowActivator.LaunchDetachedProcess(codeExecutable, codeArguments.Concat(OpenArgs()).ToArray());
        logger.Info("vscode", "launched vscode", new Dictionary<string, string?>
        {
            ["trace_id"] = traceId,
            ["target_dir"] = targetDir,
            ["folder_uri"] = folderUri,
            ["file_uri"] = fileUri,
            ["code_executable"] = codeExecutable,
            ["decision_path"] = "launch",
        });

        WindowMatch? boundWindow = WindowQuery.WaitForForegroundProcessWindow(processName, initialForeground, 4000);
        string decisionPath;
        var focusedWindow = boundWindow;
        if (focusedWindow != null)
        {
            windowReuseService.RememberWindow("vscode", launchKey, focusedWindow);
            decisionPath = "launch_bind_foreground_window";
            logger.Info("vscode", "captured vscode window after launch", new Dictionary<string, string?>
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
            var launchedWindow = WindowQuery.WaitForWindowForMatchingProcessIds(matchSpec, 4000);
            launchedWindow ??= WindowQuery.WaitForNewProcessWindow(processName, existingVisibleWindowHandles, 4000);
            if (launchedWindow != null && WindowActivator.TryActivateWindow(launchedWindow))
            {
                boundWindow = launchedWindow;
                decisionPath = existingVisibleWindowHandles.Contains(launchedWindow.WindowHandle)
                    ? "launch_bind_existing_visible_window"
                    : "launch_bind_new_visible_window";
                windowReuseService.RememberWindow("vscode", launchKey, launchedWindow);
                logger.Info("vscode", "focused vscode window after launch fallback", new Dictionary<string, string?>
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
                logger.Info("vscode", "no vscode foreground window captured after launch", new Dictionary<string, string?>
                {
                    ["trace_id"] = traceId,
                    ["target_dir"] = targetDir,
                    ["launch_key"] = launchKey,
                    ["decision_path"] = decisionPath,
                });
            }
        }

        return new RequestOutcome(
            Domain: "vscode",
            Action: "focus_or_open",
            Status: "launched",
            DecisionPath: boundWindow != null ? decisionPath : "launch_unbound",
            ResultType: boundWindow != null ? "window_ref" : null,
            Result: boundWindow != null
                ? new HelperWindowRefResult
                {
                    Pid = boundWindow.ProcessId,
                    Hwnd = boundWindow.WindowHandle.ToInt64(),
                }
                : null,
            ProcessId: boundWindow?.ProcessId,
            WindowHandle: boundWindow?.WindowHandle.ToInt64());
    }
}
