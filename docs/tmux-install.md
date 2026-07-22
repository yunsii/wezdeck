# tmux 安装与入口策略（WezDeck）

**Floor：tmux ≥ 3.7**（DEC sync 需 3.6+；copy-mode `refresh-from-pane` 需 3.7+）。

- 为何要 3.7+：[`ime-flicker-and-sync-output.md`](./ime-flicker-and-sync-output.md)
- UI：[`tmux-ui.md`](./tmux-ui.md)
- 侧载：[`../openclaw/docs/session-bridge.md`](../openclaw/docs/session-bridge.md)

## 决策树（跨系统）

```text
PATH 上的 tmux -V ≥ 3.7 ？
  ├─ 是 → 直接用系统/包管理器入口，不必用户级编译
  │        （保持 client/server 同一条 command -v 路径即可）
  └─ 否 → 用本机包管理器能否装到 ≥ 3.7 ？
            ├─ 是 → 用包管理器（见「系统/包管理器」）
            └─ 否 → 用户级源码安装到 ~/.local/bin（固定兜底）
```

| 原则 | 说明 |
| --- | --- |
| **够用就不编译** | 系统或 brew/dnf 等已 ≥ 3.7 → **不要**再装一份用户级 |
| **不够再用户级** | 典型：Ubuntu 24.04 apt 仍为 3.4 → 才走 `~/.local` 源码装 |
| **单一生效入口** | 运行时只应有一条「首选」tmux；禁止 `cargo/bin`、`~/bin` 多处 shim |
| **勿 apt remove** | 卸 apt `tmux` 可能牵连 `byobu` / `ubuntu-wsl` 等；与「用户级补装」无关 |

自检 floor：

```bash
tmux -V
# 或
./scripts/dev/install-tmux-user.sh --check   # 仅检查，不安装
```

`scripts/runtime/tmux-version-lib.sh` 在 managed 建 session 时也会 warn 低于 3.7。

## 系统 / 包管理器（优先）

目标：让 **`command -v tmux`** 指向 ≥ 3.7，且与将要跑的 server 一致。

| 环境 | 常见现状 | 推荐 |
| --- | --- | --- |
| **macOS** | Homebrew 通常 ≥ 3.7 | `brew install tmux` 或 `brew upgrade tmux` |
| **Fedora / 较新 rolling** | 包可能已 ≥ 3.7 | `sudo dnf install tmux`（先 `tmux -V` 确认） |
| **Debian / Ubuntu 24.04** | apt **3.4** | **保留 apt 包**（依赖）；**另**走用户级 3.7+（见下） |
| **WSL2 + Ubuntu** | 同 24.04 | 同上；WezDeck hybrid 跑在 WSL 里的是这条链 |
| **已有 /usr/local 自建** | 历史 3.6a 等 | 若 `-V` ≥ 3.7 且 PATH 优先它 → 可继续用；否则升级或改用户级 |

```bash
# 装完/升级后
command -v tmux
tmux -V          # 必须 ≥ 3.7
type -a tmux     # 确认没有更旧的副本抢在前面
```

**不要**为了「统一」强行把够用的系统 tmux 换成用户编译版。

## 用户级源码安装（固定兜底）

**仅当** PATH 上拿不到 ≥ 3.7 时使用（Ubuntu apt 3.4 是主场景）。

| 项 | 约定 |
| --- | --- |
| 前缀 | `~/.local`（`PREFIX=$HOME/.local`） |
| 二进制 | **`~/.local/bin/tmux` 唯一用户入口** |
| man | `~/.local/share/man`（随 `make install`） |
| 系统 apt | **保留**；不覆盖 `/usr/bin/tmux` |
| PATH | 将 `~/.local/bin` **置于** `/usr/bin` 之前（仅在需要用户级时） |

### 一键脚本

```bash
./scripts/dev/install-tmux-user.sh --check     # 已 ≥ 3.7 则提示可跳过
./scripts/dev/install-tmux-user.sh             # 默认 tag=3.7b → ~/.local
./scripts/dev/install-tmux-user.sh 3.7a
./scripts/dev/install-tmux-user.sh --force     # 即使已满足 floor 仍重装用户级
```

脚本在 **未** `--force` 且检测到 `tmux -V` ≥ 3.7 时会 **退出 0 且不编译**。

### 手工步骤（与脚本等价）

**Debian/Ubuntu 构建依赖：**

```bash
sudo apt-get update
sudo apt-get install -y build-essential autoconf automake pkg-config \
  libevent-dev libncurses-dev bison git
```

**macOS（仅当 brew 无法满足、才源码）：** Xcode CLT + `brew install libevent ncurses` 等，再 `./configure --prefix=$HOME/.local`。

**构建：**

```bash
TAG=3.7b
src="$(mktemp -d)"
git clone --depth 1 --branch "$TAG" https://github.com/tmux/tmux.git "$src/tmux"
cd "$src/tmux"
sh autogen.sh
./configure --prefix="$HOME/.local"
make -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)"
make install

export PATH="$HOME/.local/bin:$PATH"
tmux -V
```

换用用户级后，若旧 server 仍是别的二进制起的，需在方便时 `tmux kill-server` 或冷启动 WezTerm，避免 client/server 错配。

### PATH（仅用户级场景）

| 机制 | 作用 |
| --- | --- |
| `~/.zshenv` / `~/.profile` | 交互壳前置 `~/.local/bin` |
| `~/.config/shell-env.d/00-tmux-bin.env` | managed / 统一 env 加载时前置 |
| cron | 见 [`reminders.md`](./reminders.md)：`PATH` 须含实际使用的 tmux 目录 |
| OpenClaw session-bridge | 自动 probe 能连 live socket 的 client |

系统已 ≥ 3.7 时：**不必**为 tmux 单独改 PATH 去「绕开」系统包。

## 本机演进史（说明，非通用必做）

| 阶段 | 装法 | 落点 | 谁 |
| --- | --- | --- | --- |
| 基线 | Ubuntu apt | `/usr/bin` **3.4** | 系统 |
| IME/sync 修复 | 源码 **3.6a** | 曾 **`/usr/local/bin`** | 排查期（ime 文档 Step 6，历史） |
| floor 提到 3.7 | 源码 **3.7b** | **`~/.local/bin`** | WezDeck agent / 维护脚本 |

- **3.4 之后、本机上的较新 tmux 多半不是 apt 升的**，而是需求驱动的 agent/维护构建。  
- 多二进制并存 → `server exited unexpectedly`：保证 **client 与 server 同路径/同版本族**，删多余 shim。

## 与 WezDeck 运行时

| 组件 | 行为 |
| --- | --- |
| `open-*-session.sh` | `tmux_version_ensure_supported`（&lt; 3.7 则 warn） |
| `tmux.conf` auto-refresh | 需要 3.7+ |
| `check-deps-updates.sh` | 对比 installed vs floor 3.7 / upstream |
| session-bridge | probe 匹配 server 的 client |

## 排障

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| `server exited unexpectedly` | client/server 二进制不一致 | `type -a tmux`；侧载用与 server 相同 bin |
| Ubuntu 上 `tmux -V` 一直 3.4 | 只装了 apt | 走用户级兜底，PATH 前置 `~/.local/bin` |
| macOS 已 brew 3.7+ 仍被教去编译 | 旧文档过推用户级 | **以决策树为准：够用就不编译** |
| 多份用户/local 二进制 | 历史叠加 | 只保留一条生效路径；去掉 multi-shim |
| 想 apt remove「清场」 | 依赖包 | **不要** |

## 文档索引

| 主题 | 文档 |
| --- | --- |
| 本页 | `docs/tmux-install.md` |
| 为何 ≥ 3.7 | `docs/ime-flicker-and-sync-output.md` |
| UI | `docs/tmux-ui.md` |
| 安装脚本 | `scripts/dev/install-tmux-user.sh` |
| 版本 helper | `scripts/runtime/tmux-version-lib.sh` |
