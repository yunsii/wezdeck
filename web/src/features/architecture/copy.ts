// Page copy for 架构解析, bilingual inline like the diagrams (long-form page
// text, not UI chrome).
import type { LinkKind, Text } from './model'

export const SOURCE = 'https://github.com/yunsii/wezterm-config'

export const COPY = {
  title: { zh: 'WezDeck 是怎么搭起来的', en: 'How WezDeck fits together' },
  lead: {
    zh: 'AI Agent 跑在 WSL 的 tmux 里，桌面上由 WezTerm 承载；Windows 上的本地服务替它们做主机操作；手机经 Cloudflare 找到这台电脑，再尽量直连。下面先看全景，再走五条最常用的流程，最后列出本地服务提供的全部能力。',
    en: 'AI agents run in tmux inside WSL, hosted by WezTerm on the desktop; a local Windows service does the host work for them; a phone finds the computer through Cloudflare and then connects directly when it can. First the whole picture, then the five flows you use most, then everything the local services offer.',
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
    term: { zh: '会话', en: 'Session' },
    body: {
      zh: '一个 Agent（Claude、Codex 或 Grok）在某个仓库或工作树里的一段对话，住在一个 tmux 窗格里。桌面和手机看到的是同一个会话。',
      en: 'One agent (Claude, Codex or Grok) in conversation inside a repository or worktree, living in one tmux pane. The desk and the phone see the same session.',
    },
  },
  {
    term: { zh: '等你', en: 'Waiting on you' },
    body: {
      zh: 'Agent 停下来要你回答、确认，或本轮做完了。这是整个系统最重要的信号：桌面徽标、Alt+j、手机列表都围绕它。',
      en: 'The agent stopped for an answer, a confirmation, or the end of its turn. The most important signal in the system: desk badges, Alt+j and the phone list all revolve around it.',
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
      zh: 'Windows 上的 Runtime 做主机操作并给本机控制台提供接口；WSL 里的 relay 面向远程设备，bridge 是 Runtime 进 WSL 的通道。',
      en: 'The Runtime on Windows does host work and serves the console on the host; in WSL the relay faces remote devices and the bridge is the Runtime’s way in.',
    },
  },
  {
    term: { zh: '配对与批准', en: 'Pairing and approval' },
    body: {
      zh: '配对令牌让一台设备能看；主机批准过的设备密钥才让它能写。',
      en: 'A pairing token lets a device read; only a device key the host approved lets it write.',
    },
  },
]
