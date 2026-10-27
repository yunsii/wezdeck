namespace WezDeck.Runtime;

internal static class PathResolvers
{
    public static string ResolveWorktreeRoot(string directory, string distribution)
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

    // Main checkout root for a git repo family (dirname of --git-common-dir).
    // Linked worktrees under .worktrees/<repo>/<slug> share one family with the
    // primary so Alt+v reuses a single VS Code window across them.
    public static string ResolveRepoFamilyRoot(string directory, string distribution)
    {
        var worktreeRoot = ResolveWorktreeRoot(directory, distribution);
        var uncRoot = ConvertToWslUncPath(worktreeRoot, distribution);
        if (string.IsNullOrWhiteSpace(uncRoot))
        {
            return worktreeRoot;
        }

        var gitDirPath = Path.Combine(uncRoot, ".git");
        if (Directory.Exists(gitDirPath))
        {
            // Primary checkout: .git is a directory → family root is this tree.
            return worktreeRoot;
        }

        if (!File.Exists(gitDirPath))
        {
            return worktreeRoot;
        }

        // Linked worktree: .git is a file "gitdir: <abs>/.git/worktrees/<name>".
        string? gitdirLine;
        try
        {
            gitdirLine = File.ReadLines(gitDirPath).FirstOrDefault();
        }
        catch
        {
            return worktreeRoot;
        }

        if (string.IsNullOrWhiteSpace(gitdirLine))
        {
            return worktreeRoot;
        }

        const string prefix = "gitdir:";
        if (!gitdirLine.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            return worktreeRoot;
        }

        var gitdirValue = gitdirLine[prefix.Length..].Trim().Replace('\\', '/');
        if (string.IsNullOrWhiteSpace(gitdirValue))
        {
            return worktreeRoot;
        }

        // …/<main>/.git/worktrees/<name> → …/<main>/.git → …/<main>
        var normalizedGitdir = NormalizeWslPath(gitdirValue);
        var worktreesMarker = "/.git/worktrees/";
        var markerIndex = normalizedGitdir.IndexOf(worktreesMarker, StringComparison.OrdinalIgnoreCase);
        if (markerIndex > 0)
        {
            return NormalizeWslPath(normalizedGitdir[..markerIndex]);
        }

        // …/<main>/.git (unusual pointer) → …/<main>
        if (normalizedGitdir.EndsWith("/.git", StringComparison.OrdinalIgnoreCase)
            && normalizedGitdir.Length > 5)
        {
            return NormalizeWslPath(normalizedGitdir[..^5]);
        }

        return worktreeRoot;
    }

    public static string BuildVscodeFolderUri(string distro, string targetDir)
    {
        return $"vscode-remote://wsl+{Uri.EscapeDataString(distro)}{ConvertToVscodeRemotePath(targetDir)}";
    }

    // Same remote-URI shape as the folder URI; VS Code distinguishes a file
    // target from a folder target by the CLI flag (`--file-uri` vs
    // `--folder-uri`), not by the URI itself.
    public static string BuildVscodeFileUri(string distro, string filePath)
    {
        return $"vscode-remote://wsl+{Uri.EscapeDataString(distro)}{ConvertToVscodeRemotePath(filePath)}";
    }

    public static string BuildWindowCacheKey(string distro, string path)
    {
        return $"{distro}|{NormalizeWslPath(path)}";
    }

    public static string BuildChromeCacheKey(int port, string userDataDir)
    {
        return $"{port}|{NormalizeWindowsPath(userDataDir)}";
    }

    public static string NormalizeWslPath(string path)
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

    public static string NormalizeWindowsPath(string path)
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

    public static string GetProcessNameFromExecutable(string executable, string fallback)
    {
        var processName = Path.GetFileNameWithoutExtension(executable);
        return string.IsNullOrWhiteSpace(processName) ? fallback : processName;
    }

    private static string ConvertToVscodeRemotePath(string path)
    {
        var normalized = path.Replace('\\', '/');
        var segments = normalized.Split('/', StringSplitOptions.None)
            .Select(Uri.EscapeDataString);
        return string.Join("/", segments);
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
}
