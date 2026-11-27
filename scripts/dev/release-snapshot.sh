#!/usr/bin/env bash
# Prepare one reusable, detached source tree for a release batch. The primary
# checkout may advance under land.lock while this tree builds and tests.

release_snapshot_prepare() {
  local target="$1" origin_url created=0 temporary common_dir
  BATCH_TREE="$STATE/release/deploy-source"
  mkdir -p "$STATE/release" || return 1
  common_dir="$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)" || return 1
  if [[ -e "$BATCH_TREE" && ! -d "$BATCH_TREE/.git" ]]; then
    echo "release: snapshot path exists but is not a Git checkout" >&2
    return 1
  fi
  if [[ ! -d "$BATCH_TREE/.git" ]]; then
    temporary="$(mktemp -d "$STATE/release/.deploy-source.XXXXXX")" || return 1
    git clone -q --shared --no-checkout "$REPO" "$temporary" || return 1
    printf '%s\n' "$common_dir" >"$temporary/.release-snapshot"
    chmod 600 "$temporary/.release-snapshot"
    mv "$temporary" "$BATCH_TREE" || return 1
    created=1
  fi
  if [[ "$(cat "$BATCH_TREE/.release-snapshot" 2>/dev/null)" != "$common_dir" ]]; then
    echo "release: snapshot checkout is not owned by this repository" >&2
    return 1
  fi
  if ((created == 0)); then
    git -C "$BATCH_TREE" diff --quiet &&
      git -C "$BATCH_TREE" diff --cached --quiet || {
        echo "release: snapshot checkout has tracked changes" >&2
        return 1
      }
  fi
  git -C "$BATCH_TREE" checkout --detach -q "$target" || return 1
  origin_url="$(git -C "$REPO" remote get-url origin)" || return 1
  git -C "$BATCH_TREE" remote set-url origin "$origin_url" || return 1
  git -C "$BATCH_TREE" update-ref refs/remotes/origin/master "$target" || return 1
  git -C "$BATCH_TREE" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/master || return 1
  [[ -d "$REPO/web/node_modules" ]] || {
    echo "release: web/node_modules is missing in the primary checkout" >&2
    return 1
  }
  if [[ ! -e "$BATCH_TREE/web/node_modules" ]]; then
    ln -s "$REPO/web/node_modules" "$BATCH_TREE/web/node_modules" || return 1
  fi
  if [[ -f "$REPO/web/.dev.vars" ]]; then
    install -m 600 "$REPO/web/.dev.vars" "$BATCH_TREE/web/.dev.vars" || return 1
  fi
  [[ "$(git -C "$BATCH_TREE" rev-parse HEAD)" == "$target" ]] || return 1
  echo "release: source snapshot at ${target:0:8}"
}
