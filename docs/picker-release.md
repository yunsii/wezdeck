# Picker Release Rollout

Use this doc when you are publishing a new `native/picker/` release, updating the version-pinned `release-manifest.json`, or testing the release-install path locally. This is **maintainer flow**, not a daily-workflow path — most contributors never touch it.

The picker itself is the static Go binary that powers the high-frequency `Alt+/` (attention), `Alt+g` (worktree), and `Ctrl+Shift+P` (command palette) tmux popups; performance background lives in [`performance.md`](./performance.md).

## When to use this

- You changed something under `native/picker/` that needs to land on machines without a local Go toolchain.
- You want to verify a release artifact before the install-side fetcher lands.

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

3. Watch the workflow. The `build` job cross-compiles `linux-amd64`, packages it as a tar.gz, and publishes the GitHub Release; `update-manifest` then opens a PR titled `chore(scripts): update picker release manifest for <tag>`.

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
scripts/dev/update-picker-release-manifest.sh --tag "$tag" --asset linux-amd64=<sha256>
```

The SHA-256 is in the workflow summary or via `gh release view "$tag" --json assets`. Pass `--asset` again per architecture once additional targets ship.

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

`enabled: false` with empty `version` / `assets` is the placeholder state before the first release is cut. The install-side fetcher (when it lands) treats this as "manifest disabled, fall through to local-build".

## Install path

> **Note:** the install-side fetcher that turns this manifest into a runtime binary is not yet in place. Until that lands, the picker is still built locally by `wezterm-runtime-sync`'s `build-picker` step from `native/picker/build.sh`; end users without Go fall back to the bash pickers (see [`performance.md`](./performance.md) for the cost). When the fetcher arrives it will mirror the helper installer's `WEZTERM_WINDOWS_HELPER_INSTALL_SOURCE=auto|release|local` toggle.
