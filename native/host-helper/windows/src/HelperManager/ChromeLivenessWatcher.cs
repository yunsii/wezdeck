using System.Diagnostics;

namespace WezTerm.WindowsHostHelper;

// Tracks the lifetime of debug-chrome processes that ChromeRequestHandler has
// just successfully focused or launched, so the chrome-debug state file gets
// rewritten to mode=none / alive=false the moment Chrome exits. Without this,
// the right-status segment in wezterm keeps showing "H"/"V" until the user
// next presses Alt+b.
//
// Two layers of detection, by design:
//   1. Process.Exited event subscription. Cheap, immediate, fires whenever
//      the .NET runtime sees the process die.
//   2. 5s background polling that re-checks Process.HasExited. Backstop for
//      cases where the Exited event drops on the floor (process hard-killed
//      by the OS during shutdown, or the wrapper Process object is collected
//      before subscription wires up).
//
// Process objects are kept alive via the static dictionary -- if they were
// disposed, the Exited event would never fire because the underlying handle
// would be released. Dispose only happens inside OnExited / Untrack.
internal static class ChromeLivenessWatcher
{
    private sealed record TrackedProcess(string StateFile, Process Process, int Pid, int Port, bool Headless, string TraceId);

    private static readonly Dictionary<string, TrackedProcess> tracked = new();
    private static readonly object gate = new();
    private static System.Threading.Timer? pollingTimer;
    private static StructuredLogger? sharedLogger;

    public static void Track(StructuredLogger logger, string? stateFile, int pid, int port, bool headless, string traceId)
    {
        if (string.IsNullOrWhiteSpace(stateFile))
        {
            return;
        }

        lock (gate)
        {
            sharedLogger ??= logger;

            if (tracked.TryGetValue(stateFile, out var existing))
            {
                if (existing.Pid == pid)
                {
                    // Same pid, nothing to do. Skip re-subscription so we
                    // don't accidentally drop an in-flight Exited handler.
                    return;
                }
                UntrackLocked(existing);
            }

            Process proc;
            try
            {
                proc = Process.GetProcessById(pid);
            }
            catch (Exception ex)
            {
                // Race: chrome already gone between WriteState and Track.
                // Reflect that immediately so the status segment isn't lying.
                logger.Warn("chrome", "chrome process gone before liveness track", new Dictionary<string, string?>
                {
                    ["trace_id"] = traceId,
                    ["pid"] = pid.ToString(),
                    ["port"] = port.ToString(),
                    ["error"] = ex.Message,
                });
                ChromeRequestHandler.WriteStateNone(logger, stateFile, traceId, port, pid, "exited_before_track");
                return;
            }

            try
            {
                proc.EnableRaisingEvents = true;
            }
            catch (Exception ex)
            {
                logger.Warn("chrome", "failed to enable raising events on chrome process", new Dictionary<string, string?>
                {
                    ["trace_id"] = traceId,
                    ["pid"] = pid.ToString(),
                    ["error"] = ex.Message,
                });
                proc.Dispose();
                return;
            }

            var entry = new TrackedProcess(stateFile, proc, pid, port, headless, traceId);
            proc.Exited += (_, _) => OnExited(entry);
            tracked[stateFile] = entry;

            // Re-check immediately: process may have exited between
            // GetProcessById and the EnableRaisingEvents toggle.
            if (proc.HasExited)
            {
                OnExitedLocked(entry, "exited_before_subscription");
                return;
            }

            pollingTimer ??= new System.Threading.Timer(_ => PollTick(), null, TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(5));

            logger.Info("chrome", "tracking chrome process for liveness", new Dictionary<string, string?>
            {
                ["trace_id"] = traceId,
                ["pid"] = pid.ToString(),
                ["port"] = port.ToString(),
                ["headless"] = headless ? "1" : "0",
                ["state_file"] = stateFile,
            });
        }
    }

    public static void ReconcileOnStartup(StructuredLogger logger, string? stateFile)
    {
        if (string.IsNullOrWhiteSpace(stateFile) || !File.Exists(stateFile))
        {
            return;
        }
        sharedLogger ??= logger;

        ChromeStateSnapshot? snapshot;
        try
        {
            snapshot = ChromeStateSnapshot.LoadFromFile(stateFile);
        }
        catch (Exception ex)
        {
            logger.Warn("chrome", "failed to read chrome state during reconcile", new Dictionary<string, string?>
            {
                ["state_file"] = stateFile,
                ["error"] = ex.Message,
            });
            return;
        }

        if (snapshot is null)
        {
            return;
        }

        if (!snapshot.Alive)
        {
            // Already correct. Nothing to do.
            return;
        }

        if (snapshot.Pid is null)
        {
            // Older schema or malformed; we cannot verify.
            // Mark as unknown rather than leaving a confidently-wrong "alive=true".
            logger.Info("chrome", "reconcile: chrome state alive=true but pid missing, marking none", new Dictionary<string, string?>
            {
                ["state_file"] = stateFile,
                ["mode"] = snapshot.Mode,
            });
            ChromeRequestHandler.WriteStateNone(logger, stateFile, traceId: "reconcile", snapshot.Port, pid: null, action: "helper_restart_clear");
            return;
        }

        var pid = snapshot.Pid.Value;
        Process? proc = null;
        try
        {
            proc = Process.GetProcessById(pid);
        }
        catch
        {
            // Process gone.
        }

        if (proc is null || proc.HasExited)
        {
            proc?.Dispose();
            logger.Info("chrome", "reconcile: chrome pid not running, marking none", new Dictionary<string, string?>
            {
                ["state_file"] = stateFile,
                ["pid"] = pid.ToString(),
                ["mode"] = snapshot.Mode,
            });
            ChromeRequestHandler.WriteStateNone(logger, stateFile, traceId: "reconcile", snapshot.Port, pid, action: "helper_restart_clear");
            return;
        }

        // Process alive. Re-subscribe Exited so the next death is caught by
        // the new helper instance, not lost because the previous instance owned
        // the subscription.
        try
        {
            proc.EnableRaisingEvents = true;
        }
        catch (Exception ex)
        {
            logger.Warn("chrome", "reconcile: failed to enable exit events", new Dictionary<string, string?>
            {
                ["pid"] = pid.ToString(),
                ["error"] = ex.Message,
            });
            proc.Dispose();
            return;
        }

        var headless = string.Equals(snapshot.Mode, "headless", StringComparison.OrdinalIgnoreCase);
        var entry = new TrackedProcess(stateFile, proc, pid, snapshot.Port, headless, "reconcile");

        lock (gate)
        {
            if (tracked.TryGetValue(stateFile, out var existing))
            {
                UntrackLocked(existing);
            }
            // Subscribe + insert + HasExited check all under the lock, so a
            // process that exits during this window cannot lose its callback.
            proc.Exited += (_, _) => OnExited(entry);
            tracked[stateFile] = entry;
            if (proc.HasExited)
            {
                OnExitedLocked(entry, "exited_before_reconcile_subscription");
                return;
            }
            pollingTimer ??= new System.Threading.Timer(_ => PollTick(), null, TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(5));
        }

        logger.Info("chrome", "reconcile: re-subscribed chrome liveness watcher", new Dictionary<string, string?>
        {
            ["pid"] = pid.ToString(),
            ["port"] = snapshot.Port.ToString(),
            ["headless"] = headless ? "1" : "0",
            ["state_file"] = stateFile,
        });
    }

    private static void OnExited(TrackedProcess entry)
    {
        lock (gate)
        {
            OnExitedLocked(entry, "exited");
        }
    }

    private static void OnExitedLocked(TrackedProcess entry, string action)
    {
        // Guard against the rare double-fire (Process.Exited racing with the
        // poll-tick fallback, or a duplicate subscription during reconcile).
        // Only the path that actually owns the dictionary entry writes state.
        var owned = tracked.TryGetValue(entry.StateFile, out var current) && ReferenceEquals(current, entry);
        if (!owned)
        {
            return;
        }
        tracked.Remove(entry.StateFile);

        try { entry.Process.Dispose(); } catch { }

        var logger = sharedLogger;
        if (logger is null)
        {
            return;
        }

        ChromeRequestHandler.WriteStateNone(logger, entry.StateFile, entry.TraceId, entry.Port, entry.Pid, action);
        logger.Info("chrome", "chrome process exited, wrote none state", new Dictionary<string, string?>
        {
            ["pid"] = entry.Pid.ToString(),
            ["port"] = entry.Port.ToString(),
            ["state_file"] = entry.StateFile,
            ["action"] = action,
        });
    }

    private static void UntrackLocked(TrackedProcess entry)
    {
        tracked.Remove(entry.StateFile);
        try { entry.Process.Dispose(); } catch { }
    }

    private static void PollTick()
    {
        // Backstop: detect the rare cases where Process.Exited never fires.
        List<TrackedProcess> snapshot;
        lock (gate)
        {
            snapshot = tracked.Values.ToList();
        }

        foreach (var entry in snapshot)
        {
            bool hasExited;
            try
            {
                hasExited = entry.Process.HasExited;
            }
            catch
            {
                hasExited = true;
            }

            if (!hasExited)
            {
                continue;
            }

            lock (gate)
            {
                if (tracked.TryGetValue(entry.StateFile, out var current) && ReferenceEquals(current, entry))
                {
                    OnExitedLocked(entry, "exited_via_poll");
                }
            }
        }
    }
}
