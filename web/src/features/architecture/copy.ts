// Page copy for 架构解析, bilingual inline like the diagrams (long-form page
// text, not UI chrome).
import type { LinkKind, Text } from './model'

export const SOURCE = 'https://github.com/yunsii/wezdeck'

export const COPY = {
  title: { zh: 'WezDeck 是怎么搭起来的', en: 'How WezDeck fits together' },
  lead: {
    zh: 'AI Agent 跑在 WSL 的 tmux 里，日常在网页控制台查看和操作；需要真实 TUI 时再用 WezTerm 接入。Windows 上的本地服务处理主机操作，远程设备经 Cloudflare 找到这台电脑，再尽量直连。下面先看全景，再走五条常用流程，最后列出本地服务的能力。',
    en: 'AI agents run in tmux inside WSL. The web console is the daily interface, with WezTerm attaching when you need the real TUI. A local Windows service handles host actions; remote devices find this computer through Cloudflare and connect directly when possible. First the whole picture, then five common flows, then the local services.',
  },
  concepts: { zh: '几个概念', en: 'A few concepts' },
  flows: { zh: '流程', en: 'Flows' },
  security: { zh: '安全设计', en: 'Security design' },
  securityLead: {
    zh: '这套系统能往你的终端里打字，所以先把「谁能读、谁能写」分开：配对令牌只能读；写入要么带主机批准过的设备签名，要么来自本机的正式控制台；无论从哪条路来，写进窗格前都过同一组保护。下面是各道边界的位置，以及每种威胁对应的防线。',
    en: 'This system can type into your terminal, so reading and writing are granted apart: the pairing token only reads; a write carries the signature of a device the host approved, or comes from the production console on the host; either way it passes the same guards before reaching a pane. Below: where each boundary sits, and the guard against each threat.',
  },
  threats: { zh: '威胁与防线', en: 'Threats and guards' },
  capabilities: {
    zh: '本地服务提供的能力',
    en: 'What the local services offer',
  },
  capabilitiesLead: {
    zh: '三个本地进程：Windows 上的 Runtime，WSL 里的 relay 与 bridge（同一个 wezdeck-wsl 程序的两种运行方式）。展开看每一项；这些清单由单元测试对照源码，新增接口不写进来测试就不过。',
    en: 'Three local processes: the Runtime on Windows, and relay and bridge in WSL (two modes of one wezdeck-wsl program). Open a group for every entry; a unit test checks these lists against the source, so a new endpoint fails until it is described here.',
  },
  decisions: { zh: '设计取舍', en: 'Design decisions' },
  legend: { zh: '连线', en: 'Lines' },
  impl: { zh: '实现细节', en: 'Implementation' },
  steps: { zh: '步骤', en: 'Steps' },
  parts: { zh: '组成', en: 'Parts' },
  fullscreen: { zh: '全屏查看', en: 'Full screen' },
  exitFullscreen: { zh: '退出全屏', en: 'Exit full screen' },
  zoomHint: {
    zh: '拖动平移，捏合或 Ctrl+滚轮缩放；点卡片看说明。',
    en: 'Drag to pan, pinch or Ctrl+wheel to zoom; select a card for its notes.',
  },
  source: { zh: '查看源码', en: 'View the source' },
  console: { zh: '打开控制台', en: 'Open the console' },
  entry: { zh: '入口', en: 'Entry point' },
  what: { zh: '做什么', en: 'What it does' },
  toc: { zh: '目录', en: 'On this page' },
  filterCapabilities: {
    zh: '搜索接口、动作或说明…',
    en: 'Filter endpoints, actions or descriptions…',
  },
  clearFilter: { zh: '清空筛选', en: 'Clear filter' },
  noCapabilitiesMatch: {
    zh: '没有匹配的本地服务能力。',
    en: 'No matching local service capabilities.',
  },
} satisfies Record<string, Text>

export const KINDS: Array<{ kind: LinkKind; label: Text }> = [
  { kind: 'flow', label: { zh: '主路径', en: 'main path' } },
  { kind: 'data', label: { zh: '读取数据', en: 'reads data' } },
  { kind: 'trigger', label: { zh: '触发 / 通知', en: 'fires / notifies' } },
  {
    kind: 'fallback',
    label: { zh: '备选 / 条件分支', en: 'fallback / branch' },
  },
]
export const CONCEPTS: Array<{ term: Text; body: Text }> = [
  {
    term: { zh: '主机', en: 'Host' },
    body: {
      zh: '跑 Agent 的那台电脑（Windows + WSL）：终端、本地服务、tmux 会话都在它上面。',
      en: 'The computer the agents run on (Windows + WSL): the terminal, the local services and the tmux sessions all live there.',
    },
  },
  {
    term: { zh: '终端', en: 'Terminal' },
    body: {
      zh: '按需打开的 WezTerm 客户端，接入主机上持续运行的 tmux pane，供你直接操作真实 TUI。备用完整配置还包含工作区、标签页和徽标。',
      en: 'An on-demand WezTerm client attached to a persistent tmux pane on the host for direct TUI use. The optional full configuration also has workspaces, tabs and badges.',
    },
  },
  {
    term: { zh: '网页端', en: 'Web console' },
    body: {
      zh: '浏览器里的 WezDeck 控制台。按接入分：本机网页端在主机上打开，直接走本地 Runtime，不用配对；远程网页端在别的设备上打开，经中转连接，要配对并批准设备。',
      en: 'The WezDeck console in a browser. By the way in: the local web console is opened on the host and talks to the local Runtime, nothing to pair; the remote web console is opened elsewhere and goes through the relay, paired and approved per device.',
    },
  },
  {
    term: { zh: '桌面端与移动端', en: 'Desktop and mobile' },
    body: {
      zh: '网页端的另一个维度，按屏幕和输入方式分：桌面端是宽屏（768 px 起）加键鼠，列表和详情并排、有快捷键；移动端是窄屏加触屏，底部标签栏、详情推入、底部面板。和接入方式互不相干：手机是远程网页端的移动端，主机上的浏览器是本机网页端的桌面端，另一台电脑是远程网页端的桌面端。',
      en: 'The web console’s other axis, by screen and input: desktop is a wide window (768 px and up) with keyboard and mouse, list and detail side by side, shortcuts; mobile is a narrow touch screen with bottom tabs, a pushed detail and bottom sheets. Independent of the way in: a phone is a remote console on mobile, the host’s browser a local console on desktop, another computer a remote console on desktop.',
    },
  },
  {
    term: { zh: '会话', en: 'Session' },
    body: {
      zh: '一个 Agent（Claude、Codex 或 Grok）在某个仓库或工作树里的一段对话，住在一个 tmux 窗格里。终端和网页端看到的是同一个会话。',
      en: 'One agent (Claude, Codex or Grok) in conversation inside a repository or worktree, living in one tmux pane. The desk and the web console see the same session.',
    },
  },
  {
    term: { zh: '等你', en: 'Waiting on you' },
    body: {
      zh: 'Agent 停下来要你回答、确认，或本轮做完了。这是整个系统最重要的信号：终端徽标、Alt+j、网页端的会话列表都围绕它。',
      en: 'The agent stopped for an answer, a confirmation, or the end of its turn. The most important signal in the system: desk badges, Alt+j and the web console’s session list all revolve around it.',
    },
  },
  {
    term: { zh: '工单', en: 'Ticket' },
    body: {
      zh: '从一个仓库交给另一个仓库的活儿，由后台 Agent 完成，需要你时停下来问。',
      en: 'Work handed from one repository to another, done by a headless agent that stops to ask when it needs you.',
    },
  },
  {
    term: { zh: '本地服务', en: 'Local services' },
    body: {
      zh: 'Windows 上的 Runtime 做主机操作并给本机网页端提供接口；WSL 里的 relay 面向远程网页端，bridge 是 Runtime 进 WSL 的通道。',
      en: 'The Runtime on Windows does host work and serves the console on the host; in WSL the relay faces the remote web console and the bridge is the Runtime’s way in.',
    },
  },
  {
    term: { zh: '配对与批准', en: 'Pairing and approval' },
    body: {
      zh: '设备是一个登记过密钥的远程网页端。配对令牌只让它连上中转；主机批准过它的设备密钥，它才能读写。本机网页端不需要这一步。',
      en: 'A device is a remote web console with a registered key. The pairing token only gets it to the relay; once the host approves its device key it can read and write. The local web console needs neither.',
    },
  },
]
