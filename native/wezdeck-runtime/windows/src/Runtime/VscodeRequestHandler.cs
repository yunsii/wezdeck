using System.Diagnostics;
using System.Text.Json;

namespace WezDeck.Runtime;

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
        // target_dir = worktree to show; family_dir = main checkout used as the
        // reuse key so linked worktrees share one VS Code window.
        var targetDir = PathResolvers.ResolveWorktreeRoot(requestedDir, distro);
        var familyDirRaw = RequestPayloadReader.GetOptionalString(payload, "family_dir");
        var familyDir = string.IsNullOrWhiteSpace(familyDirRaw)
            ? PathResolvers.ResolveRepoFamilyRoot(requestedDir, distro)
            : PathResolvers.NormalizeWslPath(familyDirRaw);
        if (string.IsNullOrWhiteSpace(familyDir))
        {
            familyDir = targetDir;
        }

        var command = RequestPayloadReader.GetStringArray(payload, "code_command").ToArray();
        var maxWindows = RequestPayloadReader.GetOptionalPositiveInt(payload, "max_windows");
        if (command.Length == 0)
        {
            command = new[] { "code" };
        }

        // Optional file target. Window reuse is by repo family; the file is
        // revealed on top via --file-uri (launch) or --reuse-window --file-uri.
        var fileRaw = RequestPayloadReader.GetOptionalString(payload, "file");
        string? fileUri = string.IsNullOrWhiteSpace(fileRaw)
            ? null
            : PathResolvers.BuildVscodeFileUri(distro, PathResolvers.NormalizeWslPath(fileRaw));

        var codeExecutable = command[0];
        var codeArguments = command.Skip(1).ToList();
        var processName = PathResolvers.GetProcessNameFromExecutable(codeExecutable, "Code");
        var launchKey = PathResolvers.BuildWindowCacheKey(distro, familyDir);
        var folderUri = PathResolvers.BuildVscodeFolderUri(distro, targetDir);
        // How this folder appears in a VS Code window title, per its default
        // `window.title` template: "<file> - <folder-leaf> [WSL: <distro>] - …".
        var folderLeaf = targetDir.TrimEnd('/').Split('/').LastOrDefault() ?? string.Empty;
        var titleFolderMarker = string.IsNullOrEmpty(folderLeaf) ? null : $"{folderLeaf} [WSL: {distro}]";
        string[] OpenArgs() => fileUri == null
            ? new[] { "--folder-uri", folderUri }
            : new[] { "--folder-uri", folderUri, "--file-uri", fileUri };
        var matchSpec = new LaunchMatchSpec(
            InstanceType: "vscode",
            LaunchKey: launchKey,
            ProcessName: processName,
            CommandLineMatcher: commandLine => commandLine.Contains(folderUri, StringComparison.OrdinalIgnoreCase),
            ReuseMode: ReuseMode.Strict);
        // One snapshot drives both the cap count and the replacement pick, so the
        // window that gets reused is always drawn from the same population the
        // cap counted.
        var existingVisibleWindows = WindowQuery.EnumerateVisibleTopLevelWindows(processName);
        var existingVisibleWindowHandles = existingVisibleWindows.Select(window => window.WindowHandle).ToHashSet();

        logger.Info("vscode", "resolved vscode target", new Dictionary<string, string?>
        {
            ["trace_id"] = traceId,
            ["requested_dir"] = requestedDir,
            ["target_dir"] = targetDir,
            ["family_dir"] = familyDir,
            ["launch_key"] = launchKey,
        });

        var reuseDecision = windowReuseService.EvaluateReuse(matchSpec, WindowQuery.GetForegroundWindowInfo(), 1000);
        logger.Info("vscode", "evaluated vscode reuse candidates", new Dictionary<string, string?>
        {
            ["trace_id"] = traceId,
            ["launch_key"] = launchKey,
            ["family_dir"] = familyDir,
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
            // Family-keyed registry: the cached hwnd may currently show a
            // sibling worktree. That is expected — retarget in place with
            // --reuse-window --folder-uri. Only discard when the hwnd is gone
            // (EvaluateReuse already filters dead windows).
            var titleMatchesTarget = string.IsNullOrEmpty(titleFolderMarker)
                || WindowQuery.WindowTitleContains(reuseDecision.Window.WindowHandle, titleFolderMarker);
            string familyDecisionPath;
            if (titleMatchesTarget)
            {
                familyDecisionPath = "registry_family_window";
                if (fileUri != null)
                {
                    WindowActivator.LaunchDetachedProcess(
                        codeExecutable,
                        codeArguments.Concat(new[] { "--reuse-window", "--file-uri", fileUri }).ToArray());
                }
            }
            else
            {
                familyDecisionPath = "registry_family_retarget";
                WindowActivator.LaunchDetachedProcess(
                    codeExecutable,
                    codeArguments.Concat(new[] { "--reuse-window" }).Concat(OpenArgs()).ToArray());
            }

            logger.Info("vscode", "focused family vscode window", new Dictionary<string, string?>
            {
                ["trace_id"] = traceId,
                ["target_dir"] = targetDir,
                ["family_dir"] = familyDir,
                ["launch_key"] = launchKey,
                ["pid"] = reuseDecision.Window.ProcessId.ToString(),
                ["hwnd"] = reuseDecision.Window.WindowHandle.ToInt64().ToString(),
                ["decision_path"] = familyDecisionPath,
                ["prior_decision_path"] = reuseDecision.Path,
                ["title_matched_target"] = titleMatchesTarget ? "1" : "0",
                ["file_uri"] = fileUri,
            });
            return new RequestOutcome(
                Domain: "vscode",
                Action: "focus_or_open",
                Status: "reused",
                DecisionPath: familyDecisionPath,
                ResultType: "window_ref",
                Result: new RuntimeWindowRefResult
                {
                    Pid = reuseDecision.Window.ProcessId,
                    Hwnd = reuseDecision.Window.WindowHandle.ToInt64(),
                },
                ProcessId: reuseDecision.Window.ProcessId,
                WindowHandle: reuseDecision.Window.WindowHandle.ToInt64());
        }

        // Title-based already-open check runs for every request, not only at
        // the max-windows cap. Session-restored / hand-opened windows never
        // hit the registry or Electron cmdline matcher; without this check a
        // cold Alt+v would re-launch and sit on a flashing taskbar while the
        // helper waited for a foreground steal that Windows refuses.
        var alreadyOpenWindow = WindowQuery.FindWindowShowingFolder(existingVisibleWindows, titleFolderMarker);
        if (alreadyOpenWindow != null && WindowActivator.TryActivateWindow(alreadyOpenWindow))
        {
            if (fileUri != null)
            {
                WindowActivator.LaunchDetachedProcess(
                    codeExecutable,
                    codeArguments.Concat(new[] { "--reuse-window", "--file-uri", fileUri }).ToArray());
            }

            var staleKey = windowReuseService.FindKeyByWindowHandle("vscode", alreadyOpenWindow.WindowHandle);
            if (staleKey != null && !string.Equals(staleKey, launchKey, StringComparison.OrdinalIgnoreCase))
            {
                windowReuseService.ReplaceWindowKey("vscode", staleKey, launchKey, alreadyOpenWindow);
            }
            else
            {
                windowReuseService.RememberWindow("vscode", launchKey, alreadyOpenWindow);
            }

            var titleDecisionPath = maxWindows.HasValue && existingVisibleWindowHandles.Count >= maxWindows.Value
                ? "max_windows_focus_window_showing_folder"
                : "focus_window_showing_folder";
            logger.Info("vscode", "focused the window already showing this folder", new Dictionary<string, string?>
            {
                ["trace_id"] = traceId,
                ["target_dir"] = targetDir,
                ["launch_key"] = launchKey,
                ["title_marker"] = titleFolderMarker,
                ["replaced_launch_key"] = staleKey,
                ["pid"] = alreadyOpenWindow.ProcessId.ToString(),
                ["hwnd"] = alreadyOpenWindow.WindowHandle.ToInt64().ToString(),
                ["existing_visible_window_count"] = existingVisibleWindowHandles.Count.ToString(),
                ["max_windows"] = maxWindows?.ToString(),
                ["decision_path"] = titleDecisionPath,
            });
            return new RequestOutcome(
                Domain: "vscode",
                Action: "focus_or_open",
                Status: "reused",
                DecisionPath: titleDecisionPath,
                ResultType: "window_ref",
                Result: new RuntimeWindowRefResult
                {
                    Pid = alreadyOpenWindow.ProcessId,
                    Hwnd = alreadyOpenWindow.WindowHandle.ToInt64(),
                },
                ProcessId: alreadyOpenWindow.ProcessId,
                WindowHandle: alreadyOpenWindow.WindowHandle.ToInt64());
        }

        if (maxWindows.HasValue && existingVisibleWindowHandles.Count >= maxWindows.Value)
        {
            // Least recently activated across every visible window, by Z order.
            // Scoping this to registry-tracked windows instead made the pick
            // collapse onto whichever window the helper happened to record first
            // and never move off it.
            var lruWindow = WindowQuery.PickLeastRecentlyActivatedWindow(existingVisibleWindows);
            var replacementWindow = lruWindow ?? WindowQuery.FindFirstVisibleProcessWindow(processName);
            var replacementPath = lruWindow != null
                ? "max_windows_reuse_zorder_lru_window"
                : "max_windows_reuse_visible_window";
            if (replacementWindow != null && WindowActivator.TryActivateWindow(replacementWindow))
            {
                // Capture the aim window's prior registry key before launch. We
                // only steal it when the title confirms this window actually
                // received the folder; otherwise VS Code may have focused a
                // different already-open window and the aim window still shows
                // its old content.
                var replacedLaunchKey = windowReuseService.FindKeyByWindowHandle("vscode", replacementWindow.WindowHandle);

                WindowActivator.LaunchDetachedProcess(
                    codeExecutable,
                    codeArguments.Concat(new[] { "--reuse-window" }).Concat(OpenArgs()).ToArray());

                var confirmedWindow = WindowQuery.WaitForWindowShowingFolder(processName, titleFolderMarker, 2000);
                string maxWindowsDecisionPath;
                WindowMatch maxWindowsBoundWindow;
                if (confirmedWindow != null)
                {
                    maxWindowsBoundWindow = confirmedWindow;
                    if (confirmedWindow.WindowHandle == replacementWindow.WindowHandle)
                    {
                        maxWindowsDecisionPath = replacementPath;
                        if (replacedLaunchKey != null
                            && !string.Equals(replacedLaunchKey, launchKey, StringComparison.OrdinalIgnoreCase))
                        {
                            windowReuseService.ReplaceWindowKey("vscode", replacedLaunchKey, launchKey, maxWindowsBoundWindow);
                        }
                        else
                        {
                            windowReuseService.RememberWindow("vscode", launchKey, maxWindowsBoundWindow);
                        }
                    }
                    else
                    {
                        // Folder landed elsewhere (typical VS Code de-dupe).
                        // Leave the aim window's prior key alone — it still
                        // shows its old folder.
                        maxWindowsDecisionPath = "max_windows_folder_landed_elsewhere";
                        var showingStaleKey = windowReuseService.FindKeyByWindowHandle("vscode", maxWindowsBoundWindow.WindowHandle);
                        if (showingStaleKey != null
                            && !string.Equals(showingStaleKey, launchKey, StringComparison.OrdinalIgnoreCase))
                        {
                            windowReuseService.ReplaceWindowKey("vscode", showingStaleKey, launchKey, maxWindowsBoundWindow);
                        }
                        else
                        {
                            windowReuseService.RememberWindow("vscode", launchKey, maxWindowsBoundWindow);
                        }

                        WindowActivator.TryActivateWindow(maxWindowsBoundWindow);
                    }
                }
                else
                {
                    // Title never confirmed. Do not write launchKey onto the
                    // aim window — that is the poison that made Alt+v on the
                    // primary worktree focus a sibling worktree window.
                    maxWindowsBoundWindow = replacementWindow;
                    maxWindowsDecisionPath = "max_windows_reuse_unconfirmed_title";
                    logger.Info("vscode", "max-windows reuse did not confirm folder title; left registry unbound for this folder", new Dictionary<string, string?>
                    {
                        ["trace_id"] = traceId,
                        ["target_dir"] = targetDir,
                        ["launch_key"] = launchKey,
                        ["title_marker"] = titleFolderMarker,
                        ["replaced_launch_key"] = replacedLaunchKey,
                        ["pid"] = maxWindowsBoundWindow.ProcessId.ToString(),
                        ["hwnd"] = maxWindowsBoundWindow.WindowHandle.ToInt64().ToString(),
                        ["existing_visible_window_count"] = existingVisibleWindowHandles.Count.ToString(),
                        ["max_windows"] = maxWindows.Value.ToString(),
                        ["decision_path"] = maxWindowsDecisionPath,
                    });
                    return new RequestOutcome(
                        Domain: "vscode",
                        Action: "focus_or_open",
                        Status: "reused",
                        DecisionPath: maxWindowsDecisionPath,
                        ResultType: "window_ref",
                        Result: new RuntimeWindowRefResult
                        {
                            Pid = maxWindowsBoundWindow.ProcessId,
                            Hwnd = maxWindowsBoundWindow.WindowHandle.ToInt64(),
                        },
                        ProcessId: maxWindowsBoundWindow.ProcessId,
                        WindowHandle: maxWindowsBoundWindow.WindowHandle.ToInt64());
                }

                logger.Info("vscode", "reused least recently activated vscode window because max window count was reached", new Dictionary<string, string?>
                {
                    ["trace_id"] = traceId,
                    ["target_dir"] = targetDir,
                    ["launch_key"] = launchKey,
                    ["replaced_launch_key"] = replacedLaunchKey,
                    ["title_marker"] = titleFolderMarker,
                    ["pid"] = maxWindowsBoundWindow.ProcessId.ToString(),
                    ["hwnd"] = maxWindowsBoundWindow.WindowHandle.ToInt64().ToString(),
                    ["aim_hwnd"] = replacementWindow.WindowHandle.ToInt64().ToString(),
                    ["existing_visible_window_count"] = existingVisibleWindowHandles.Count.ToString(),
                    ["max_windows"] = maxWindows.Value.ToString(),
                    ["decision_path"] = maxWindowsDecisionPath,
                });
                return new RequestOutcome(
                    Domain: "vscode",
                    Action: "focus_or_open",
                    Status: "reused",
                    DecisionPath: maxWindowsDecisionPath,
                    ResultType: "window_ref",
                    Result: new RuntimeWindowRefResult
                    {
                        Pid = maxWindowsBoundWindow.ProcessId,
                        Hwnd = maxWindowsBoundWindow.WindowHandle.ToInt64(),
                    },
                    ProcessId: maxWindowsBoundWindow.ProcessId,
                    WindowHandle: maxWindowsBoundWindow.WindowHandle.ToInt64());
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
        var launchStarted = Stopwatch.StartNew();
        WindowActivator.LaunchDetachedProcess(codeExecutable, codeArguments.Concat(OpenArgs()).ToArray());
        logger.Info("vscode", "launched vscode", new Dictionary<string, string?>
        {
            ["trace_id"] = traceId,
            ["target_dir"] = targetDir,
            ["folder_uri"] = folderUri,
            ["file_uri"] = fileUri,
            ["code_executable"] = codeExecutable,
            ["decision_path"] = "launch",
            ["existing_visible_window_count"] = existingVisibleWindowHandles.Count.ToString(),
        });

        // Single poll: new hwnd / title marker / foreground. Activate as soon
        // as any signal appears — do not burn 4s waiting for a foreground
        // steal Windows will refuse while the taskbar is already flashing.
        var bind = WindowQuery.WaitForLaunchedWindow(
            processName,
            existingVisibleWindowHandles,
            initialForeground,
            titleFolderMarker,
            5000);
        WindowMatch? boundWindow = null;
        string decisionPath;
        if (bind != null)
        {
            boundWindow = bind.Window;
            decisionPath = bind.DecisionPath;
            var activated = WindowActivator.TryActivateWindow(boundWindow);
            windowReuseService.RememberWindow("vscode", launchKey, boundWindow);
            logger.Info("vscode", "bound vscode window after launch", new Dictionary<string, string?>
            {
                ["trace_id"] = traceId,
                ["target_dir"] = targetDir,
                ["launch_key"] = launchKey,
                ["pid"] = boundWindow.ProcessId.ToString(),
                ["hwnd"] = boundWindow.WindowHandle.ToInt64().ToString(),
                ["decision_path"] = decisionPath,
                ["activated"] = activated ? "1" : "0",
                ["bind_wait_ms"] = launchStarted.ElapsedMilliseconds.ToString(),
            });
        }
        else
        {
            decisionPath = "launch_unbound";
            logger.Info("vscode", "no vscode window captured after launch", new Dictionary<string, string?>
            {
                ["trace_id"] = traceId,
                ["target_dir"] = targetDir,
                ["launch_key"] = launchKey,
                ["decision_path"] = decisionPath,
                ["bind_wait_ms"] = launchStarted.ElapsedMilliseconds.ToString(),
            });
        }

        return new RequestOutcome(
            Domain: "vscode",
            Action: "focus_or_open",
            Status: "launched",
            DecisionPath: boundWindow != null ? decisionPath : "launch_unbound",
            ResultType: boundWindow != null ? "window_ref" : null,
            Result: boundWindow != null
                ? new RuntimeWindowRefResult
                {
                    Pid = boundWindow.ProcessId,
                    Hwnd = boundWindow.WindowHandle.ToInt64(),
                }
                : null,
            ProcessId: boundWindow?.ProcessId,
            WindowHandle: boundWindow?.WindowHandle.ToInt64());
    }

    public object ReadWindows()
    {
        var foreground = NativeMethods.GetForegroundWindow();
        var windows = EnumerateWindows()
            .Select(window => new RuntimeVscodeWindowSnapshot
            {
                Pid = window.ProcessId,
                Hwnd = window.WindowHandle.ToInt64(),
                Title = WindowQuery.GetWindowTitle(window.WindowHandle),
                Foreground = window.WindowHandle == foreground,
            })
            .ToArray();
        return new
        {
            available = true,
            windows,
        };
    }

    public RequestOutcome Close(JsonElement payload, string traceId)
    {
        if (!RequestPayloadReader.GetOptionalBool(payload, "confirm"))
        {
            throw new InvalidOperationException("vscode close requires confirm=true");
        }

        var target = RequireWindow(payload);

        if (!WindowActivator.TryCloseWindow(target))
        {
            throw new InvalidOperationException("failed to request vscode window close");
        }

        var cacheKey = windowReuseService.FindKeyByWindowHandle("vscode", target.WindowHandle);

        logger.Info("vscode", "requested vscode window close", new Dictionary<string, string?>
        {
            ["trace_id"] = traceId,
            ["pid"] = target.ProcessId.ToString(),
            ["hwnd"] = target.WindowHandle.ToInt64().ToString(),
            ["cache_key"] = cacheKey,
            ["decision_path"] = "window_wm_close",
        });

        return new RequestOutcome(
            Domain: "vscode",
            Action: "close",
            Status: "requested",
            DecisionPath: "window_wm_close",
            ResultType: "window_ref",
            Result: new RuntimeWindowRefResult
            {
                Pid = target.ProcessId,
                Hwnd = target.WindowHandle.ToInt64(),
            },
            ProcessId: target.ProcessId,
            WindowHandle: target.WindowHandle.ToInt64());
    }

    public RequestOutcome Focus(JsonElement payload, string traceId)
    {
        var target = RequireWindow(payload);
        if (!WindowActivator.TryActivateWindow(target))
        {
            throw new InvalidOperationException("failed to focus vscode window");
        }

        logger.Info("vscode", "focused vscode window from web console", new Dictionary<string, string?>
        {
            ["trace_id"] = traceId,
            ["pid"] = target.ProcessId.ToString(),
            ["hwnd"] = target.WindowHandle.ToInt64().ToString(),
            ["decision_path"] = "window_activate",
        });

        return new RequestOutcome(
            Domain: "vscode",
            Action: "focus",
            Status: "focused",
            DecisionPath: "window_activate",
            ResultType: "window_ref",
            Result: new RuntimeWindowRefResult
            {
                Pid = target.ProcessId,
                Hwnd = target.WindowHandle.ToInt64(),
            },
            ProcessId: target.ProcessId,
            WindowHandle: target.WindowHandle.ToInt64());
    }

    private static IReadOnlyList<WindowMatch> EnumerateWindows()
    {
        var windows = new Dictionary<IntPtr, WindowMatch>();
        foreach (var processName in new[] { "Code", "Code - Insiders", "VSCodium" })
        {
            foreach (var window in WindowQuery.EnumerateVisibleTopLevelWindows(processName))
            {
                windows[window.WindowHandle] = window;
            }
        }

        return windows.Values.ToArray();
    }

    private static WindowMatch RequireWindow(JsonElement payload)
    {
        var requestedHwnd = RequestPayloadReader.GetOptionalPositiveLong(payload, "hwnd");
        var requestedPid = RequestPayloadReader.GetOptionalPositiveInt(payload, "pid");
        var candidates = EnumerateWindows();
        var target = requestedHwnd.HasValue
            ? candidates.FirstOrDefault(window => window.WindowHandle.ToInt64() == requestedHwnd.Value)
            : requestedPid.HasValue
                ? candidates.FirstOrDefault(window => window.ProcessId == requestedPid.Value)
                : null;
        return target ?? throw new InvalidOperationException("vscode window was not found");
    }
}
