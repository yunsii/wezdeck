package main

// `repo.links {repo?, cwd?, refresh?}` (read): project external links resolved
// by the host's `vscode-links` CLI — the same list as the desk's `Ctrl+k l`
// picker (provider auto-detect such as GitHub / CNB plus `.vscode/settings.json`
// `links.resources` / `links.remoteResources`).
//
// Scoped to repositories the user works in (knownRepos / live session cwds).
// Results are cached per checkout for 60 s unless `refresh: true` is passed.
// Only http(s) URLs are surfaced to the web console.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	repoLinksTimeout  = 4 * time.Second
	repoLinksCacheTTL = 60 * time.Second
	repoLinksMax      = 200
	repoLinkDiagMax   = 240
)

type repoLink struct {
	Type        string `json:"type"` // detected | local | remote-project | remote-shared
	Source      string `json:"source"`
	URL         string `json:"url"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
}

type repoLinksReply struct {
	V            int        `json:"v"`
	OK           bool       `json:"ok"`
	CLIAvailable bool       `json:"cli_available"`
	Cwd          string     `json:"cwd,omitempty"`
	Links        []repoLink `json:"links"`
	Diagnostics  []string   `json:"diagnostics,omitempty"`
}

type cachedRepoLinks struct {
	reply repoLinksReply
	at    time.Time
}

var (
	repoLinksMu    sync.Mutex
	repoLinksCache = map[string]cachedRepoLinks{}
)

func repoLinks(args json.RawMessage) (any, error) {
	var a struct {
		Repo    string `json:"repo"`
		Cwd     string `json:"cwd"`
		Refresh bool   `json:"refresh"`
	}
	_ = json.Unmarshal(args, &a)
	dir, err := resolveRepoLinksDir(strings.TrimSpace(a.Repo), strings.TrimSpace(a.Cwd))
	if err != nil {
		return nil, err
	}
	start := time.Now()
	bin := resolveVSCodeLinksBin()
	if bin == "" {
		reply := repoLinksReply{
			V:            1,
			OK:           true,
			CLIAvailable: false,
			Cwd:          dir,
			Links:        []repoLink{},
			Diagnostics: []string{
				"vscode-links is not installed on the host (run scripts/runtime/setup-vscode-links.sh --install)",
			},
		}
		relayLogf("repo_links", "dir=%q n=0 diags=1 cli_available=false cached=false ms=%d", dir, time.Since(start).Milliseconds())
		return reply, nil
	}

	cacheKey := bin + "\x00" + dir
	if !a.Refresh {
		repoLinksMu.Lock()
		entry, ok := repoLinksCache[cacheKey]
		repoLinksMu.Unlock()
		if ok && time.Since(entry.at) < repoLinksCacheTTL {
			relayLogf("repo_links", "dir=%q n=%d diags=%d cli_available=true cached=true ms=%d",
				dir, len(entry.reply.Links), len(entry.reply.Diagnostics), time.Since(start).Milliseconds())
			return entry.reply, nil
		}
	}

	links, diags := runVSCodeLinks(bin, dir)
	reply := repoLinksReply{
		V:            1,
		OK:           true,
		CLIAvailable: true,
		Cwd:          dir,
		Links:        links,
		Diagnostics:  diags,
	}
	repoLinksMu.Lock()
	repoLinksCache[cacheKey] = cachedRepoLinks{reply: reply, at: time.Now()}
	repoLinksMu.Unlock()
	relayLogf("repo_links", "dir=%q n=%d diags=%d cli_available=true cached=false ms=%d",
		dir, len(reply.Links), len(reply.Diagnostics), time.Since(start).Milliseconds())
	return reply, nil
}

func resolveRepoLinksDir(repo, cwd string) (string, error) {
	if cwd != "" {
		cleanCwd := filepath.Clean(cwd)
		if info, err := os.Stat(cleanCwd); err == nil && info.IsDir() {
			_, root, _ := gitRepoMeta(cleanCwd)
			if root != "" && isKnownRepo(root) {
				if repo == "" || filepath.Clean(root) == filepath.Clean(repo) {
					return cleanCwd, nil
				}
			}
			if isLiveSessionCwd(cleanCwd) {
				return cleanCwd, nil
			}
		}
	}
	if repo != "" {
		cleanRepo := filepath.Clean(repo)
		if isKnownRepo(cleanRepo) {
			if info, err := os.Stat(cleanRepo); err == nil && info.IsDir() {
				return cleanRepo, nil
			}
		}
	}
	return "", errors.New("repo.links: not a repository you work in")
}

func isLiveSessionCwd(target string) bool {
	entries, err := liveSessions()
	if err != nil {
		return false
	}
	for _, e := range entries {
		if _, cwd, _, _, _, alive := paneState(e); alive && cwd != "" {
			if filepath.Clean(cwd) == target {
				return true
			}
		}
	}
	return false
}

// resolveVSCodeLinksBin matches scripts/runtime/links-menu.sh precedence:
// VSCODE_LINKS_BIN → <repo>/native/vscode-links/bin/vscode-links → PATH.
func resolveVSCodeLinksBin() string {
	if envBin, ok := os.LookupEnv("VSCODE_LINKS_BIN"); ok {
		envBin = strings.TrimSpace(envBin)
		if envBin != "" && isExecutableFile(envBin) {
			return envBin
		}
		return ""
	}
	if root := repoRoot(); root != "" {
		managed := filepath.Join(root, "native", "vscode-links", "bin", "vscode-links")
		if isExecutableFile(managed) {
			return managed
		}
	}
	if path, err := exec.LookPath("vscode-links"); err == nil && isExecutableFile(path) {
		return path
	}
	return ""
}

func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Mode()&0o111 != 0
}

func runVSCodeLinks(bin, dir string) ([]repoLink, []string) {
	ctx, cancel := context.WithTimeout(context.Background(), repoLinksTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "resolve", "--cwd", dir, "--format", "ndjson")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()

	links, diags := parseVSCodeLinksNDJSON(stdout.Bytes())
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		diags = append(diags, "vscode-links resolve failed: "+clip(msg, repoLinkDiagMax))
	}
	return links, diags
}

func parseVSCodeLinksNDJSON(data []byte) ([]repoLink, []string) {
	links := []repoLink{}
	var diags []string
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 0, 16*1024), 512*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var env struct {
			Kind string          `json:"kind"`
			Data json.RawMessage `json:"data"`
		}
		if json.Unmarshal([]byte(line), &env) != nil {
			continue
		}
		switch env.Kind {
		case "link":
			if len(links) >= repoLinksMax {
				continue
			}
			var item repoLink
			if json.Unmarshal(env.Data, &item) != nil {
				continue
			}
			item.URL = strings.TrimSpace(item.URL)
			item.Title = strings.TrimSpace(item.Title)
			item.Description = strings.TrimSpace(item.Description)
			item.Type = strings.TrimSpace(item.Type)
			item.Source = strings.TrimSpace(item.Source)
			if !isSafeWebURL(item.URL) {
				continue
			}
			if item.Title == "" {
				item.Title = item.URL
			}
			links = append(links, item)
		case "diagnostic":
			var d struct {
				Level   string `json:"level"`
				Source  string `json:"source"`
				Message string `json:"message"`
			}
			if json.Unmarshal(env.Data, &d) != nil || strings.TrimSpace(d.Message) == "" {
				continue
			}
			text := strings.TrimSpace(d.Message)
			if d.Level != "" && d.Source != "" {
				text = fmt.Sprintf("[%s] %s: %s", d.Level, d.Source, text)
			} else if d.Source != "" {
				text = fmt.Sprintf("%s: %s", d.Source, text)
			}
			diags = append(diags, clip(text, repoLinkDiagMax))
		}
	}
	return links, diags
}

func isSafeWebURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	scheme := strings.ToLower(u.Scheme)
	return (scheme == "http" || scheme == "https") && u.Host != ""
}
