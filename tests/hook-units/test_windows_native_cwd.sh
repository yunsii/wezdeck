#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_ROOT="$(mktemp -d /tmp/wezdeck-windows-cwd.XXXXXX)"
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/windows" "$TEST_ROOT/guest"
export WINDOWS_POWERSHELL_CWD="$TEST_ROOT/windows"
export WINDOWS_CWD_PROBE="$TEST_ROOT/cwd.log"
export HOME="$TEST_ROOT/home"
export XDG_CACHE_HOME="$TEST_ROOT/cache"
export WEZTERM_NO_PATH_CACHE=1
printf '#!/usr/bin/env bash\nprintf "powershell:%%s\\n" "$PWD" >> "$WINDOWS_CWD_PROBE"\nprintf "interop-ok\\n"\n' > "$TEST_ROOT/bin/powershell.exe"
printf '#!/usr/bin/env bash\nprintf "cmd:%%s\\n" "$PWD" >> "$WINDOWS_CWD_PROBE"\ncase "$*" in *LOCALAPPDATA*) printf "C:\\\\Users\\\\Test\\\\AppData\\\\Local\\n";; *) printf "C:\\\\Users\\\\Test\\n";; esac\n' > "$TEST_ROOT/bin/cmd.exe"
printf '#!/usr/bin/env bash\nprintf "/mnt/c/Users/Test\\n"\n' > "$TEST_ROOT/bin/wslpath"
chmod +x "$TEST_ROOT/bin/powershell.exe" "$TEST_ROOT/bin/cmd.exe" "$TEST_ROOT/bin/wslpath"
export PATH="$TEST_ROOT/bin:$PATH"
# shellcheck disable=SC1091
source "$ROOT/scripts/runtime/windows-shell-lib.sh"
# shellcheck disable=SC1091
source "$ROOT/scripts/runtime/windows-runtime-paths-lib.sh"
cd "$TEST_ROOT/guest"
[[ "$(windows_run_powershell_command_utf8 'Write-Output probe')" == interop-ok ]]
windows_runtime_detect_paths
[[ "$PWD" == "$TEST_ROOT/guest" ]]
[[ "$(rg -c "^powershell:$TEST_ROOT/windows$" "$WINDOWS_CWD_PROBE")" == 1 ]]
[[ "$(rg -c "^cmd:$TEST_ROOT/windows$" "$WINDOWS_CWD_PROBE")" == 2 ]]
printf 'PASS windows-native-cwd\n'
