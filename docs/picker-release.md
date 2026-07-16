# Picker Release Rollout

Use this doc when you are publishing a new `native/picker/` release, updating the version-pinned `release-manifest.json`, or testing the release-install path locally. This is **maintainer flow**, not a daily-workflow path — most contributors never touch it.

The picker itself is the static Go binary that powers the high-frequency `Alt+/` (attention), `Alt+g` (worktree), and `Ctrl+Shift+P` (command palette) tmux popups; performance background lives in [`performance.md`](./performance.md).

## When to use this

- You changed something under `native/picker/` that needs to land on machines without a local Go toolchain (required after Go-only popups — see [Install path](#install-path)).
- You want a local dry-run of the release tarball before tagging.

To cut **both** picker (Go) and host-helper (C#) in one session:

```bash
scripts/dev/prepare-native-releases.sh --dry-run-package
```

## Prerequisites

- `gh` CLI authenticated against this repo.
- Repo Actions setting allows auto-PR creation.

Both are documented under [`setup.md#maintainer-setup`](./setup.md#maintainer-setup). Skipping the second one means step 4 below has to be done manually.

## Cutting a release

The standard flow is tag-push + merge the manifest-update PR the workflow opens for you. Run from a clean checkout of `master`.

1. Decide the tag. Convention is `picker-vYYYY.MM.DD.N` (`N` increments per same-day reroll, starting at `1`).

   ```bash
   tag="picker-v$(date +%Y.%m.%d).1"
   ```

2. Push the tag — this triggers [`.github/workflows/picker-release.yml`](/home/yuns/github/wezterm-config/.github/workflows/picker-release.yml) automatically.

   ```bash
   git tag "$tag" && git push origin "$tag"
   ```

3. Watch the workflow. The `build` job runs `native/picker/package-release.sh` to cross-compile `linux-amd64` + `linux-arm64`, packages each as a tar.gz, and publishes the GitHub Release; `update-manifest` then opens a PR titled `chore(scripts): update picker release manifest for <tag>`.

   ```bash
   run_id=$(gh run list --workflow=picker-release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
   gh run watch "$run_id" --exit-status
   ```

   If `update-manifest` fails on the final "Create manifest update PR" step, see [`host-helper-release.md#troubleshooting`](./host-helper-release.md#troubleshooting) — the same `Allow GitHub Actions to create PRs` permission gate applies, and the same one-shot fix + `gh run rerun --failed` pattern works.

4. Review and merge the auto-PR; this updates `native/picker/release-manifest.json` on the default branch.

   ```bash
   pr_num=$(gh pr list --head "ci/update-picker-manifest-$tag" --json number --jq '.[0].number')
   gh pr diff "$pr_num"
   gh pr merge "$pr_num" --squash --delete-branch
   ```

5. Pull the merged manifest into your local checkout, then sync the runtime ([`daily-workflow.md#runtime-sync`](./daily-workflow.md#runtime-sync)).

   ```bash
   git pull --rebase origin master
   skills/wezterm-runtime-sync/scripts/sync-runtime.sh
   ```

If you need to update the manifest manually from a repo checkout (e.g. the auto-PR step was blocked and you don't want to rerun):

```bash
scripts/dev/update-picker-release-manifest.sh --tag "$tag" \
  --asset linux-amd64=<sha256> --asset linux-arm64=<sha256>
```

The SHA-256 is in the workflow summary or via `gh release view "$tag" --json assets`. Pass one `--asset` per architecture.

## Manifest schema

`native/picker/release-manifest.json` uses a multi-asset map keyed by `<os>-<arch>`, in contrast to `native/host-helper/windows/release-manifest.json` (single-asset) — picker can grow into additional architectures via Go cross-compile, and pre-baking the map avoids a `schemaVersion` bump later.

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "version": "picker-vYYYY.MM.DD.N",
  "assets": {
    "linux-amd64": {
      "assetName": "wezdeck-picker-<version>-linux-amd64.tar.gz",
      "downloadUrl": "https://github.com/yunsii/wezdeck/releases/download/<version>/<assetName>",
      "sha256": "..."
    }
  }
}
```

`enabled: false` with empty `version` / `assets` is the placeholder state before the first release is cut. `native/picker/build.sh` treats that as "manifest disabled" and keeps a local build / existing binary only.

### Local dry-run packaging

Without pushing a tag, package the same artifacts CI would:

```bash
native/picker/package-release.sh --tag picker-v$(date +%Y.%m.%d).1 --targets linux-amd64,linux-arm64
# or full readiness checklist + dry-run:
scripts/dev/prepare-native-releases.sh --dry-run-package --targets linux-amd64,linux-arm64
```

## Install path

`native/picker/build.sh` is the single entry point for provisioning the binary at `native/picker/bin/picker`. It chooses between two paths based on `WEZTERM_PICKER_INSTALL_SOURCE`:

- `local`: runs `go build` against the repo source. If Go is missing, keeps an already-installed binary; otherwise fails non-zero (no silent skip).
- `release`: reads `release-manifest.json`, picks the `<os>-<arch>` asset for the host (`uname -s`/`uname -m` mapped to `linux-amd64`, `linux-arm64`, etc.), downloads the tarball, SHA-256 verifies it against the manifest, and extracts to `native/picker/bin/picker`. Fails non-zero if the manifest is `enabled: false`, has no asset for the host arch, or the download / hash check fails — unless an existing binary can be kept.
- `auto` (default): tries `local` first (HEAD source for maintainers), falls through to `release` when Go is missing, then keeps any existing binary; only exits non-zero when no path can produce or retain a binary.

Downloaded tarballs are cached at `${WEZDECK_PICKER_CACHE:-$XDG_CACHE_HOME/wezdeck/picker}/<version>/` keyed by version, so a re-sync after a successful fetch only re-extracts.

### Go-only product path

High-frequency popups (`Alt+/` attention, `Alt+g` worktree, command palette, `Alt+t` overflow) **require** `native/picker/bin/picker`. Menu wrappers resolve it via `scripts/runtime/picker-bin-lib.sh`. When the binary is missing they toast and refuse to open a degraded UI.

`wezterm-runtime-sync`'s `build-picker` step is a **hard gate**: a failed install aborts the native subflow (and thus the sync) so a broken machine does not silently lose popup UX.

Emergency escape hatch only: set `WEZTERM_ALLOW_BASH_PICKER=1` to re-enable the deprecated bash pickers (`tmux-*-picker.sh`) or overflow's legacy `display-menu` path. This is for recovery when install is broken — not the default product path. Prefer fixing install (`sync-runtime.sh`, Go toolchain, or a published release asset).

`wezterm-runtime-sync`'s `build-picker` step inherits the env from the calling shell, so a maintainer can force a release-install verification with:

```bash
WEZTERM_PICKER_INSTALL_SOURCE=release skills/wezterm-runtime-sync/scripts/sync-runtime.sh
```

Use `WEZTERM_PICKER_INSTALL_SOURCE=local` to force the build path explicitly. Same shape as the host-helper's `WEZTERM_WINDOWS_HELPER_INSTALL_SOURCE` toggle.
