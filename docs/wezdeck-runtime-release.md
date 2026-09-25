# Host Helper Release Rollout

Use this doc when you are publishing a new Windows wezdeck-runtime release, updating the version-pinned `release-manifest.json`, or testing the release-install path locally. This is **maintainer flow**, not a daily-workflow path — most contributors never touch it.

The architectural place of the helper itself (request flow, IPC, reuse policy, cache files) lives in [`architecture.md#windows-host`](./architecture.md#windows-host).

## When to use this

- You changed something in `native/wezdeck-runtime/windows/...` that needs to land on machines without a local Windows `dotnet` SDK.
- You want to verify the release-install path on a machine that *does* have `dotnet` (force the release branch with the env var below).
- You hit a slow GitHub download and want to side-load a pre-fetched zip.

To cut **both** the Go picker and this C# helper in one session (readiness checks + suggested tags + copy-paste commands):

```bash
scripts/dev/prepare-native-releases.sh --dry-run-package
```

Picker narrative: [`picker-release.md`](./picker-release.md).

## Prerequisites

- `gh` CLI authenticated against this repo.
- Repo Actions setting allows auto-PR creation.

Both are documented under [`setup.md#maintainer-setup`](./setup.md#maintainer-setup). Skipping the second one means step 4 below has to be done manually.

## Cutting a release

The standard flow is tag-push + merge the manifest-update PR the workflow opens for you. Run from a clean checkout of `master`.

1. Decide the tag. Convention is `wezdeck-runtime-vYYYY.MM.DD.N` (`N` increments per same-day reroll, starting at `1`).

   ```bash
   tag="wezdeck-runtime-v$(date +%Y.%m.%d).1"
   ```

2. Push the tag — this triggers [`.github/workflows/wezdeck-runtime-release.yml`](/home/yuns/github/wezterm-config/.github/workflows/wezdeck-runtime-release.yml) automatically.

   ```bash
   git tag "$tag" && git push origin "$tag"
   ```

3. Watch the workflow. The `build` job compiles the helper on `windows-latest` and publishes the GitHub Release; `update-manifest` then opens a PR titled `chore(scripts): update WezDeck Runtime release manifest for <tag>`.

   ```bash
   run_id=$(gh run list --workflow=wezdeck-runtime-release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
   gh run watch "$run_id" --exit-status
   ```

   If `update-manifest` fails on the final "Create manifest update PR" step, see [Troubleshooting](#troubleshooting) — the Release itself is already published.

4. Review and merge the auto-PR; this updates `native/wezdeck-runtime/windows/release-manifest.json` on the default branch.

   ```bash
   pr_num=$(gh pr list --head "ci/update-wezdeck-runtime-manifest-$tag" --json number --jq '.[0].number')
   gh pr diff "$pr_num"
   gh pr merge "$pr_num" --squash --delete-branch
   ```

5. Pull the merged manifest into your local checkout, then sync the runtime ([`daily-workflow.md#runtime-sync`](./daily-workflow.md#runtime-sync)) so the new manifest reaches Windows targets.

   ```bash
   git pull --rebase origin master
   skills/wezdeck-runtime-ops/scripts/sync-runtime.sh
   ```

If you need to update the manifest manually from a repo checkout (e.g. the auto-PR step was blocked and you don't want to rerun):

```bash
scripts/dev/update-wezdeck-runtime-release-manifest.sh --tag "$tag" --sha256 <sha256>
```

The SHA-256 is in the workflow summary or `gh release view "$tag" --json assets`.

## Troubleshooting

### `update-manifest` fails with `GitHub Actions is not permitted to create or approve pull requests`

The `build` job already succeeded and the GitHub Release is live; only the auto-PR step was blocked by the repo-level setting. The branch `ci/update-wezdeck-runtime-manifest-<tag>` was successfully pushed too — only the PR creation API call was denied.

One-time fix (also documented in [`setup.md#maintainer-setup`](./setup.md#maintainer-setup)):

```bash
gh api -X PUT repos/<owner>/<repo>/actions/permissions/workflow \
  -f default_workflow_permissions=read \
  -F can_approve_pull_request_reviews=true
```

Then rerun only the failed job — no need to retag or rebuild:

```bash
gh run rerun "$run_id" --failed
```

After it succeeds, continue from step 4 of [Cutting a release](#cutting-a-release).

## Forcing the release path locally

To exercise the release branch on a machine that already has Windows `dotnet`:

```bash
WEZDECK_RUNTIME_INSTALL_SOURCE=release skills/wezdeck-runtime-ops/scripts/sync-runtime.sh
```

Use `WEZDECK_RUNTIME_INSTALL_SOURCE=local` when you want to verify the local-build path explicitly. Leave it unset for normal `auto` behavior.

To inspect what the installer chose, see the `install_source` / `release_archive_source` / `release_archive_path` / `release_download_url` fields documented in [`diagnostics.md#traceability`](./diagnostics.md#traceability), plus `helper-install-state.json` under `%LOCALAPPDATA%\wezterm-runtime\bin\`.

## Side-loading the release zip

When GitHub download speed is poor, the Windows helper installer checks these release-archive sources in order before it falls back to the manifest URL:

- `WEZDECK_RUNTIME_RELEASE_ARCHIVE=C:\path\to\asset.zip`
- `%LOCALAPPDATA%\wezterm-runtime\artifacts/wezdeck-runtime\<version>\<assetName>`
- `%LOCALAPPDATA%\wezterm-runtime\artifacts/wezdeck-runtime\<assetName>`
- the existing `%LOCALAPPDATA%\wezterm-runtime\cache\downloads\<version>\<assetName>` cache entry

For network overrides, use one of:

- `WEZDECK_RUNTIME_RELEASE_URL=https://.../asset.zip`
- `WEZDECK_RUNTIME_RELEASE_BASE_URL=https://mirror.example.com/wezdeck-runtime/<version>`

Both local archives and URL overrides are still verified against the manifest SHA-256 before installation.
