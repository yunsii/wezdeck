// The system at a glance. Concepts on the cards and in `body`; file names,
// endpoints and fields go to `impl` (folded on the page). Keep it true to the
// code — docs/remote-access.md, docs/remote-sessions.md and docs/collab.md
// are the sources.
import type { Diagram } from './model'
import { CLOUD, DEVICE, WINDOWS, WSL } from './lanes'

export const overview: Diagram = {
  id: 'overview',
  title: { zh: '全景', en: 'At a glance' },
  summary: {
    zh: 'Agent 跑在 WSL 的 tmux 里，终端由 WezTerm 承载。网页端在别的设备上打开时经 Cloudflare 找到主机，再尽量直连；在主机上打开时直接问本地 Runtime。',
    en: 'Agents run in tmux inside WSL, hosted by WezTerm on the desktop. The web console on another device finds the host through Cloudflare, then connects directly when it can; on the host it asks the local Runtime.',
  },
  lanes: [DEVICE, CLOUD, WINDOWS, WSL],
  cards: [
    {
      id: 'remoteweb',
      lane: 'device',
      row: 0,
      title: { zh: '远程网页端', en: 'Remote web console' },
      sub: {
        zh: '手机、平板或其他电脑上的同一个控制台，经 relay',
        en: 'The same console on a phone, tablet or another computer, through the relay',
      },
      body: {
        zh: '配对后可在任何网络下查看与驱动主机上的 Agent 会话、处理工单。界面先显示本地缓存，再增量补新内容；写入需要主机批准过这台设备。',
        en: 'Once paired it follows and drives the agent sessions on the host and handles tickets from any network. It shows the local cache first and then fetches only what is new; writing needs the host to approve the device.',
      },
      impl: {
        zh: 'web/（TanStack Start + React）。连接：lib/remote-link.ts；缓存：IndexedDB（query-provider.tsx），会话按 lib/session-cache.ts 合并。',
        en: 'web/ (TanStack Start + React). Link: lib/remote-link.ts; cache: IndexedDB (query-provider.tsx), sessions merged by lib/session-cache.ts.',
      },
    },
    {
      id: 'localweb',
      lane: 'device',
      row: 2,
      title: { zh: '本机网页端', en: 'Local web console' },
      sub: {
        zh: '同一个控制台，走本地 Runtime',
        en: 'The same console, through the local Runtime',
      },
      body: {
        zh: '在主机上打开控制台时，读写都直接走 127.0.0.1 上的 Runtime，不需要配对；还多出「本机」「诊断」两页。',
        en: 'On the host itself the console reads and writes through the Runtime on 127.0.0.1, with nothing to pair, and gains the This computer and Diagnostics pages.',
      },
      impl: {
        zh: 'lib/runtime-client.ts：hostRead / hostWrite 先探测本地 Runtime 的能力（remote.read / remote.write），不支持时回落远程链接。',
        en: 'lib/runtime-client.ts: hostRead / hostWrite probe the local Runtime for remote.read / remote.write and fall back to the remote link.',
      },
    },
    {
      id: 'worker',
      lane: 'cloud',
      row: 0,
      title: { zh: '站点', en: 'Site' },
      sub: {
        zh: 'Worker 提供页面与 /relay',
        en: 'A Worker serves the app and /relay',
      },
      body: {
        zh: '同一个 Cloudflare Worker 发布 Web 应用，并把 /relay 交给 HostRelay。它不保存会话内容。',
        en: 'One Cloudflare Worker serves the web app and hands /relay to HostRelay. It keeps no session content.',
      },
      impl: {
        zh: 'web/src/server.ts、web/wrangler.jsonc。',
        en: 'web/src/server.ts, web/wrangler.jsonc.',
      },
    },
    {
      id: 'do',
      lane: 'cloud',
      row: 1,
      title: { zh: 'HostRelay', en: 'HostRelay' },
      sub: {
        zh: '配对校验、信令、兜底中转',
        en: 'Pairing check, signaling, fallback relay',
      },
      body: {
        zh: '一个 Durable Object 守着主机的长连接。远程网页端带配对令牌接入，它负责交换建立直连所需的信令；直连打不通时，请求经它的 WebSocket 中转。',
        en: 'A Durable Object holds the host’s long-lived socket. Remote web consoles join with a pairing token; it exchanges the signaling for a direct connection and relays requests over WebSocket when that fails.',
      },
      impl: {
        zh: 'web/src/relay/host-relay.ts；令牌由 scripts/dev/install-remote-relay.sh 生成与轮换。',
        en: 'web/src/relay/host-relay.ts; tokens from scripts/dev/install-remote-relay.sh.',
      },
    },
    {
      id: 'wezterm',
      lane: 'windows',
      row: 0,
      title: { zh: 'WezTerm', en: 'WezTerm' },
      sub: {
        zh: '每个仓库一个标签页，徽标与快捷键',
        en: 'A tab per repository, badges and keys',
      },
      body: {
        zh: '终端的入口：工作区、标签页、「等你」徽标，以及 Alt+j 跳到等你的会话等键盘操作。',
        en: 'The desktop entry: workspaces, tabs, the waiting-on-you badges, and keys such as Alt+j to jump to a session that waits on you.',
      },
      impl: {
        zh: 'wezterm-x/（Lua 配置）；快捷键唯一来源 wezterm-x/commands/manifest.json。',
        en: 'wezterm-x/ (Lua config); every key comes from wezterm-x/commands/manifest.json.',
      },
    },
    {
      id: 'runtime',
      lane: 'windows',
      row: 1,
      title: { zh: 'WezDeck Runtime', en: 'WezDeck Runtime' },
      sub: {
        zh: '本地服务，只听 127.0.0.1',
        en: 'The local service, loopback only',
      },
      body: {
        zh: 'Windows 上的常驻服务：给本机控制台提供读写接口与事件推送，替 WezTerm 做剪贴板、窗口焦点、VS Code、浏览器等主机操作，并采样输入法与日志。',
        en: 'A resident Windows service: read and write APIs plus an event stream for the console on the host, host actions for WezTerm (clipboard, window focus, VS Code, browser), and samples of the input method and logs.',
      },
      impl: {
        zh: 'native/wezdeck-runtime/windows（C#，ASP.NET）。HTTP 127.0.0.1:35791，WezTerm 走命名管道；只放行白名单来源。',
        en: 'native/wezdeck-runtime/windows (C#, ASP.NET). HTTP 127.0.0.1:35791; WezTerm uses a named pipe; only allowlisted origins.',
      },
    },
    {
      id: 'slot',
      lane: 'windows',
      row: 2,
      title: { zh: '浏览器槽', en: 'Browser slot' },
      sub: {
        zh: 'Ego 或调试 Chrome，二选一',
        en: 'Ego or the debug Chrome, one at a time',
      },
      body: {
        zh: '给 Agent 用的浏览器。同一时间只开一个后端：切换时准备新的一边、停掉另一边。',
        en: 'The browser agents use. One backend at a time: switching prepares the chosen side and stops the other.',
      },
      impl: {
        zh: 'scripts/runtime/apply-browser-backend.sh；状态 state/browser-agent/status.json，Runtime 经 /api/v1/browser 读出。',
        en: 'scripts/runtime/apply-browser-backend.sh; status in state/browser-agent/status.json, read back via /api/v1/browser.',
      },
    },
    {
      id: 'tmux',
      lane: 'wsl',
      row: 0,
      title: { zh: 'tmux 与 Agent', en: 'tmux and agents' },
      sub: {
        zh: 'Claude / Codex / Grok，各在自己的窗格',
        en: 'Claude / Codex / Grok, each in its pane',
      },
      body: {
        zh: '每个仓库或工作树一个 tmux 会话，Agent 跑在窗格里。网页端发的消息就是粘贴进这个窗格。',
        en: 'A tmux session per repository or worktree, agents in its panes. A message from the web console is pasted into that pane.',
      },
      impl: {
        zh: '启动统一经 scripts/runtime/agent-launcher.sh；工作树由 open-task-window 创建。',
        en: 'Every launch goes through scripts/runtime/agent-launcher.sh; worktrees come from open-task-window.',
      },
    },
    {
      id: 'relay',
      lane: 'wsl',
      row: 1,
      title: { zh: 'relay', en: 'relay' },
      sub: {
        zh: 'wezdeck-wsl：远程请求的主机端',
        en: 'wezdeck-wsl: the host end of remote requests',
      },
      body: {
        zh: '常驻的 systemd 服务：连着 HostRelay，接受直连，回答读取请求，验签后执行写入。',
        en: 'A resident systemd service: holds the HostRelay socket, accepts direct connections, answers reads and runs writes after checking their signature.',
      },
      impl: {
        zh: 'native/wezdeck-wsl（Go）relay.go、remote_write.go、session_window.go；日志 relay.log。',
        en: 'native/wezdeck-wsl (Go) relay.go, remote_write.go, session_window.go; log relay.log.',
      },
    },
    {
      id: 'bridge',
      lane: 'wsl',
      row: 2,
      title: { zh: 'bridge', en: 'bridge' },
      sub: {
        zh: 'wezdeck-wsl：Runtime 进 WSL 的通道',
        en: 'wezdeck-wsl: the Runtime’s way into WSL',
      },
      body: {
        zh: 'Runtime 需要 WSL 里的东西（会话、工单、git 状态）时，经它转一手；它跑的是与 relay 相同的读写函数。',
        en: 'When the Runtime needs something from WSL (sessions, tickets, git status) it asks through the bridge, which runs the same read and write functions as the relay.',
      },
      impl: {
        zh: 'wezdeck-wsl serve（unix socket），Runtime 经 wsl.exe 上的 attach 进程连接；serve.go 按白名单分发。',
        en: 'wezdeck-wsl serve (unix socket), reached by the Runtime through an attach process under wsl.exe; serve.go dispatches an allowlist.',
      },
    },
    {
      id: 'attention',
      lane: 'wsl',
      row: 3,
      title: { zh: '会话状态', en: 'Session state' },
      sub: {
        zh: 'attention.json：谁在跑、谁在等你',
        en: 'attention.json: who runs, who waits on you',
      },
      body: {
        zh: 'Agent 的 hook 把每个会话的窗格、状态（运行中、等你、本轮结束）写到这里，终端徽标和网页端的会话列表都从它读。',
        en: 'Agent hooks record each session’s pane and status (running, waiting on you, finished its turn); desktop badges and the web console’s session list both read it.',
      },
      impl: {
        zh: '见 docs/agent-attention.md。',
        en: 'See docs/agent-attention.md.',
      },
    },
    {
      id: 'tickets',
      lane: 'wsl',
      row: 4,
      title: { zh: '工单库', en: 'Ticket store' },
      sub: {
        zh: '跨仓库委托，后台 Agent 执行',
        en: 'Cross-repo hand-offs, run by headless agents',
      },
      body: {
        zh: '把活儿从一个仓库交给另一个：每张工单是一份文件和一串事件，后台 Agent 调研、实现，需要你拍板时停下来问。',
        en: 'Work handed from one repository to another: a ticket is a file plus an event log; a headless agent researches and implements, and stops to ask when it needs you.',
      },
      impl: {
        zh: '~/.agent/tickets；CLI 与 api：skills/agent-collab/（ticket、lib/api.py）。',
        en: '~/.agent/tickets; CLI and api: skills/agent-collab/ (ticket, lib/api.py).',
      },
    },
  ],
  links: [
    {
      from: 'remoteweb',
      to: 'worker',
      kind: 'data',
      label: { zh: '页面', en: 'app' },
    },
    {
      from: 'remoteweb',
      to: 'do',
      label: { zh: '配对 · 信令', en: 'pairing · signaling' },
    },
    { from: 'do', to: 'relay', label: { zh: '主机长连接', en: 'host socket' } },
    {
      from: 'remoteweb',
      to: 'relay',
      kind: 'fallback',
      label: { zh: 'WebRTC 直连', en: 'WebRTC direct' },
    },
    {
      from: 'localweb',
      to: 'runtime',
      label: { zh: '127.0.0.1', en: '127.0.0.1' },
    },
    { from: 'runtime', to: 'bridge', label: { zh: 'wsl.exe', en: 'wsl.exe' } },
    {
      from: 'wezterm',
      to: 'runtime',
      kind: 'trigger',
      label: { zh: '命名管道', en: 'named pipe' },
    },
    { from: 'wezterm', to: 'tmux', label: { zh: '承载', en: 'hosts' } },
    { from: 'runtime', to: 'slot', kind: 'trigger' },
    { from: 'relay', to: 'tmux', label: { zh: '粘贴写入', en: 'paste' } },
    {
      from: 'tmux',
      to: 'attention',
      kind: 'trigger',
      label: { zh: 'hook', en: 'hooks' },
    },
    { from: 'relay', to: 'attention', kind: 'data' },
    { from: 'bridge', to: 'attention', kind: 'data' },
    { from: 'bridge', to: 'tickets', kind: 'data' },
  ],
}
