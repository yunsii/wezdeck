#!/usr/bin/env bash
# core.sh — worktree-task command implementations (aggregator).
#
# Split by command surface so launch / reclaim / configure can evolve
# without dragging the whole monorepo entry into one 800-line file.
# worktree-task still sources this single path.

# shellcheck shell=bash

__WT_CORE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$__WT_CORE_DIR/core-shared.sh"
# shellcheck disable=SC1091
. "$__WT_CORE_DIR/core-configure.sh"
# shellcheck disable=SC1091
. "$__WT_CORE_DIR/core-launch.sh"
# shellcheck disable=SC1091
. "$__WT_CORE_DIR/core-reclaim.sh"
