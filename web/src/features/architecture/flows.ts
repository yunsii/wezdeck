// The flows on the architecture page, each a numbered story across
// lanes. Same rules as overview.ts: concepts on the cards, files and fields
// in `impl`.
import type { Diagram } from './model'
import { imageFlow } from './flows-media'
import { ticketLife, waitingSignal } from './flows-work'
import { CLOUD, DEVICE, WINDOWS, WSL } from './lanes'

export const openSession: Diagram = {
  id: 'open-session',
  title: { zh: '在手机上打开会话', en: 'Opening a session on the phone' },
  summary: {
    zh: '先显示缓存，再建立最快的连接，只取缺的那部分。',
    en: 'Cache first, then the fastest link, then only what is missing.',
  },
  numbered: true,
  lanes: [DEVICE, CLOUD, WSL],
  cards: [
    {
      id: 'cache',
      lane: 'device',
      title: { zh: '先显示缓存', en: 'Show the cache' },
      sub: {
        zh: '上次看到的对话立刻出现',
        en: 'The last copy appears at once',
      },
      body: {
        zh: '每个会话在本机存一份合并好的对话（落盘最多 300 条），打开时直接渲染，同时去取新内容。',
        en: 'Each session keeps one merged copy locally (up to 300 messages on disk); opening renders it at once while new content is fetched.',
      },
      impl: {
        zh: 'lib/session-cache.ts（trimForDisk）、query-provider.tsx。',
        en: 'lib/session-cache.ts (trimForDisk), query-provider.tsx.',
      },
    },
    {
      id: 'join',
      lane: 'device',
      title: { zh: '带令牌接入', en: 'Join with the token' },
      sub: { zh: 'WebSocket 连 HostRelay', en: 'WebSocket to HostRelay' },
      body: {
        zh: '配对令牌只存在这台设备上，用来证明它是主人的设备。',
        en: 'The pairing token lives only on this device and proves it is the owner’s.',
      },
      impl: {
        zh: 'lib/remote-link.ts（openSocket），子协议携带令牌。',
        en: 'lib/remote-link.ts (openSocket); the token rides the subprotocol.',
      },
    },
    {
      id: 'signal',
      lane: 'cloud',
      title: { zh: '交换信令', en: 'Exchange signaling' },
      sub: { zh: '转发 offer / answer', en: 'Relays offer / answer' },
      body: {
        zh: 'HostRelay 只转发建立直连所需的描述，不碰内容。',
        en: 'HostRelay forwards only what the direct connection needs, never content.',
      },
      impl: {
        zh: '非 trickle：SDP 一次带齐候选地址。',
        en: 'Non-trickle: the SDP carries every candidate at once.',
      },
    },
    {
      id: 'answer',
      lane: 'wsl',
      title: { zh: 'relay 应答', en: 'relay answers' },
      sub: { zh: '打开 DataChannel', en: 'Opens a DataChannel' },
      body: {
        zh: '主机端生成应答，双方尝试打洞直连。',
        en: 'The host answers and both sides try to connect directly.',
      },
      impl: {
        zh: 'pion/webrtc，relay.go（answer）。',
        en: 'pion/webrtc, relay.go (answer).',
      },
    },
    {
      id: 'direct',
      lane: 'device',
      title: { zh: '直连优先', en: 'Direct first' },
      sub: { zh: '打不通就留在中转', en: 'Stays on the relay if it fails' },
      body: {
        zh: '直连通了，请求就走 DataChannel，低延迟、不占 Cloudflare；打不通时继续用 WebSocket 中转，界面照常可用。',
        en: 'Once direct, requests use the DataChannel: lower latency, no Cloudflare traffic. If it fails, the WebSocket relay carries on and nothing changes for you.',
      },
    },
    {
      id: 'since',
      lane: 'device',
      title: { zh: '只要缺的', en: 'Ask for what is missing' },
      sub: { zh: 'session {id, since: n}', en: 'session {id, since: n}' },
      body: {
        zh: '告诉主机「我已经有前 n 条」。空闲时一次轮询只有一两 KB。',
        en: 'Tells the host “I have the first n”. An idle poll is a kilobyte or two.',
      },
      impl: {
        zh: '另有 {before: s} 加载更早，{limit} 首屏。',
        en: 'Also {before: s} for earlier pages and {limit} for a first page.',
      },
    },
    {
      id: 'read',
      lane: 'wsl',
      title: { zh: '增量读取', en: 'Read incrementally' },
      sub: { zh: '只解析新增的字节', en: 'Parses only appended bytes' },
      body: {
        zh: '对话记录按文件缓存、只读新增部分；还在等结果的工具调用会一起带回，结果到了就补上。',
        en: 'Transcripts are cached per file and read from where they stopped; a tool call still waiting for its result comes along so the result lands.',
      },
      impl: {
        zh: 'session_window.go、remote_session.go；Claude / Codex / Grok 三种格式。',
        en: 'session_window.go, remote_session.go; Claude, Codex and Grok formats.',
      },
    },
    {
      id: 'parts',
      lane: 'wsl',
      title: { zh: '大回复分片', en: 'Split large replies' },
      sub: { zh: '超过 200 KB 拆成 60 KB', en: 'Over 200 KB → 60 KB parts' },
      body: {
        zh: '浏览器一条 DataChannel 消息最多 256 KiB，大回复拆开发、到了再拼。',
        en: 'A browser takes at most 256 KiB per DataChannel message: large replies go in parts and are joined on arrival.',
      },
      impl: {
        zh: 'relay_parts.go → lib/reply-parts.ts。',
        en: 'relay_parts.go → lib/reply-parts.ts.',
      },
    },
    {
      id: 'merge',
      lane: 'device',
      title: { zh: '合并并渲染', en: 'Merge and render' },
      sub: { zh: '只画新增的气泡', en: 'Only new bubbles render' },
      body: {
        zh: '按消息下标合并进缓存，已有的气泡保持不动。',
        en: 'Merged into the cache by index; bubbles already on screen stay as they are.',
      },
    },
  ],
  links: [
    { from: 'cache', to: 'join' },
    { from: 'join', to: 'signal' },
    { from: 'signal', to: 'answer' },
    { from: 'answer', to: 'direct' },
    { from: 'direct', to: 'since' },
    { from: 'since', to: 'read' },
    {
      from: 'read',
      to: 'parts',
      kind: 'fallback',
      label: { zh: '太大时', en: 'when large' },
    },
    { from: 'read', to: 'merge', kind: 'data' },
    { from: 'parts', to: 'merge', kind: 'data' },
  ],
}

export const sendMessage: Diagram = {
  id: 'send-message',
  title: { zh: '发一条消息', en: 'Sending a message' },
  summary: {
    zh: '远程设备要签名，本机浏览器靠本地信任；两条路最后进同一个写入函数、受同一组保护。',
    en: 'Remote devices sign, the host browser relies on local trust; both end in the same write function under the same guards.',
  },
  numbered: true,
  // explicit rows: the two ways in (signed / local) must not cross
  lanes: [DEVICE, WINDOWS, WSL],
  cards: [
    {
      id: 'type',
      lane: 'device',
      row: 0,
      title: { zh: '输入并发送', en: 'Type and send' },
      sub: { zh: '草稿留在本机', en: 'The draft stays on the device' },
      body: {
        zh: '没发出去的内容按会话保存，离开再回来还在。',
        en: 'Unsent text is kept per session and survives leaving the page.',
      },
      impl: { zh: 'lib/use-draft.ts。', en: 'lib/use-draft.ts.' },
    },
    {
      id: 'sign',
      lane: 'device',
      row: 1,
      title: { zh: '设备签名', en: 'Device signature' },
      sub: { zh: '手机 / 平板', en: 'Phone / tablet' },
      body: {
        zh: '每台设备在浏览器里生成一把不可导出的密钥，主机批准一次后，写入都要带它的签名。',
        en: 'Each device creates a non-extractable key in its browser; once the host approves it, every write carries its signature.',
      },
      impl: {
        zh: 'lib/device-key.ts（ECDSA P-256）；批准：install-remote-relay.sh --approve。',
        en: 'lib/device-key.ts (ECDSA P-256); approval: install-remote-relay.sh --approve.',
      },
    },
    {
      id: 'local',
      lane: 'windows',
      row: 2,
      title: { zh: '本机写入', en: 'Local write' },
      sub: {
        zh: '本机浏览器，无需配对',
        en: 'Browser on the host, nothing to pair',
      },
      body: {
        zh: '只听 127.0.0.1、只接受白名单来源的 JSON 请求，和其他本机操作同一信任级别。',
        en: 'Loopback only, JSON only, allowlisted origins only — the same trust as the other host actions.',
      },
      impl: {
        zh: 'POST /api/v1/remote/<动作> → bridge remote.<动作>。',
        en: 'POST /api/v1/remote/<action> → bridge remote.<action>.',
      },
    },
    {
      id: 'verify',
      lane: 'wsl',
      row: 1,
      title: { zh: '验签', en: 'Verify' },
      sub: {
        zh: '已批准的设备 + 时间戳 + nonce',
        en: 'Approved device + timestamp + nonce',
      },
      body: {
        zh: '签名不对、设备没批准或请求被重放，都直接拒绝。',
        en: 'A bad signature, an unapproved device or a replay is refused.',
      },
      impl: {
        zh: 'remote_session.go verifyWrite。',
        en: 'remote_session.go verifyWrite.',
      },
    },
    {
      id: 'guards',
      lane: 'wsl',
      row: 2,
      title: { zh: '同一组保护', en: 'The same guards' },
      sub: {
        zh: '一个写者、电脑前有人就等',
        en: 'One writer, wait while the desk is busy',
      },
      body: {
        zh: '只往会话自己的窗格里写，不另起进程；电脑前 10 秒内有人操作，就稍后再发，手机会倒计时自动重试。',
        en: 'Only the session’s own pane is written, never a second process; if someone typed at the desk in the last 10 s the phone counts down and retries.',
      },
      impl: {
        zh: 'remote_write.go runWrite（relay 与 bridge 共用），每次写入记一行 event=write。',
        en: 'remote_write.go runWrite (shared by relay and bridge); each write logs event=write.',
      },
    },
    {
      id: 'paste',
      lane: 'wsl',
      row: 3,
      title: { zh: '粘贴进 TUI', en: 'Paste into the TUI' },
      sub: { zh: 'tmux paste-buffer + Enter', en: 'tmux paste-buffer + Enter' },
      body: {
        zh: '和你在电脑前打字一样进入 Agent 的输入框；窗格里会提示「手机发来一条消息」。',
        en: 'It reaches the agent like typing at the desk; the pane shows a short notice.',
      },
    },
    {
      id: 'agent',
      lane: 'wsl',
      row: 4,
      title: { zh: 'Agent 接着干', en: 'The agent goes on' },
      sub: { zh: '运行中也能发', en: 'Works mid-turn too' },
      body: {
        zh: 'Claude 会排队、Codex 会插入当前轮、Grok 会在本轮后跟进。',
        en: 'Claude queues it, Codex steers the running turn, Grok follows up after the turn.',
      },
    },
    {
      id: 'see',
      lane: 'device',
      row: 5,
      title: { zh: '看到结果', en: 'See the reply' },
      sub: { zh: '下一次增量轮询带回', en: 'The next incremental poll' },
      body: {
        zh: '回复流式地出现在对话里。',
        en: 'The reply streams into the conversation.',
      },
    },
  ],
  links: [
    { from: 'type', to: 'sign', label: { zh: '远程设备', en: 'remote' } },
    {
      from: 'type',
      to: 'local',
      kind: 'fallback',
      label: { zh: '本机浏览器', en: 'on the host' },
    },
    { from: 'sign', to: 'verify' },
    { from: 'verify', to: 'guards' },
    { from: 'local', to: 'guards' },
    { from: 'guards', to: 'paste' },
    { from: 'paste', to: 'agent' },
    { from: 'agent', to: 'see', kind: 'data' },
  ],
}

export const flows: Array<Diagram> = [
  openSession,
  sendMessage,
  ticketLife,
  waitingSignal,
  imageFlow,
]
