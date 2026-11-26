// What the local services offer, one row per entry point. The names are
// checked against the source by capabilities.test.ts (the Runtime's routes
// and action table, the bridge's switch, the relay's readRPC / runWrite), so
// a new endpoint fails the test until it is described here.
import type { Text } from './model'

export type Capability = { name: string; what: Text }

export type CapabilityGroup = {
  id:
    | 'runtime-http'
    | 'runtime-actions'
    | 'relay-reads'
    | 'relay-writes'
    | 'relay-other'
    | 'bridge'
  title: Text
  summary: Text
  /** where the list lives in the source */
  source: string
  items: Array<Capability>
}

const c = (name: string, zh: string, en: string): Capability => ({
  name,
  what: { zh, en },
})

export const capabilityGroups: Array<CapabilityGroup> = [
  {
    id: 'runtime-http',
    title: { zh: 'Runtime：读取接口', en: 'Runtime: read endpoints' },
    summary: {
      zh: '本机控制台和 WezTerm 用的只读接口，GET，只听 127.0.0.1。需要 WSL 数据的经 bridge 转一手。',
      en: 'Read-only GETs for the console on the host and for WezTerm, loopback only. Anything from WSL goes through the bridge.',
    },
    source: 'native/wezdeck-runtime/windows/src/Runtime/RuntimeWebServer.cs',
    items: [
      c(
        '/api/v1/health',
        '是否就绪、运行时长、支持的能力清单（控制台据此决定显示什么）',
        'Readiness, uptime and the capability list the console decides by',
      ),
      c(
        '/api/v1/rime/stats',
        'Rime 输入法的输入统计',
        'Typing statistics from the Rime input method',
      ),
      c(
        '/api/v1/ime',
        '当前输入法状态（中 / 英）',
        'The current input method state',
      ),
      c(
        '/api/v1/chrome',
        '调试 Chrome 是否在跑、端口与标签页',
        'Whether the debug Chrome runs, its port and tabs',
      ),
      c(
        '/api/v1/browser',
        '浏览器槽：当前后端（ego / cdp）与是否在运行',
        'The browser slot: backend (ego / cdp) and whether it runs',
      ),
      c('/api/v1/vscode', '打开着的 VS Code 窗口', 'Open VS Code windows'),
      c(
        '/api/v1/sessions',
        '会话状态（attention.json 的整理视图）',
        'Session state (a view of attention.json)',
      ),
      c(
        '/api/v1/workspaces',
        '工作区与仓库目录（缓存 30 秒）',
        'Workspaces and repositories (cached 30 s)',
      ),
      c(
        '/api/v1/worktree/status',
        '某个工作树的 git 状态',
        'Git status of a worktree',
      ),
      c('/api/v1/wakatime', '今日编码时长', 'Today’s coding time'),
      c('/api/v1/wsl', 'bridge 是否可用', 'Whether the bridge is available'),
      c(
        '/api/v1/diagnostics',
        '按类别读日志、延迟与计数',
        'Logs, latencies and counters by category',
      ),
      c(
        '/api/v1/clients',
        '本机访问过 Runtime 的来源（Origin + 浏览器，请求 / 写入次数，实时连接），存在内存里',
        'Sources on the host that used the Runtime (Origin + browser, requests / writes, live sockets), kept in memory',
      ),
      c(
        '/api/v1/web-events',
        '本机控制台的限量事件批次，写入独立轮转日志供诊断',
        'Bounded local console events, written to a separate rotating diagnostic log',
      ),
      c(
        '/api/v1/collab/<命令>',
        '工单：health / list / show / events / run / prompt / transcript / metrics',
        'Tickets: health / list / show / events / run / prompt / transcript / metrics',
      ),
      c(
        '/api/v1/remote/<读取>',
        '与 relay 相同的会话读取（见下方 relay 读取）',
        'The relay’s session reads (see relay reads below)',
      ),
      c(
        '/events',
        'WebSocket：心跳与状态变化推送',
        'WebSocket: heartbeat and change notifications',
      ),
    ],
  },
  {
    id: 'runtime-actions',
    title: { zh: 'Runtime：主机操作', en: 'Runtime: host actions' },
    summary: {
      zh: 'WezTerm 经命名管道、控制台经 POST /api/v1/actions/<域>/<动作> 调用，替终端做它在 WSL 里做不到的 Windows 操作。另有 POST /api/v1/remote/<写入> 给本机浏览器写会话。',
      en: 'Called by WezTerm over the named pipe and by the console at POST /api/v1/actions/<domain>/<action>: the Windows work a terminal in WSL cannot do. POST /api/v1/remote/<write> also lets the host browser write to sessions.',
    },
    source: 'native/wezdeck-runtime/windows/src/Runtime/RequestRouter.cs',
    items: [
      c(
        'vscode/focus_or_open',
        '聚焦某目录的 VS Code，没有就打开',
        'Focus the VS Code window for a folder, or open one',
      ),
      c(
        'vscode/focus',
        '聚焦已打开的 VS Code 窗口',
        'Focus an open VS Code window',
      ),
      c('vscode/close', '关闭 VS Code 窗口', 'Close a VS Code window'),
      c(
        'sessions/focus',
        '把 WezTerm 切到某个会话的窗格',
        'Bring WezTerm to a session’s pane',
      ),
      c(
        'chrome/focus_or_start',
        '聚焦调试 Chrome，没有就启动',
        'Focus the debug Chrome, or start it',
      ),
      c(
        'clipboard/resolve_for_paste',
        '粘贴前把剪贴板里的图片落成文件、返回路径',
        'Turn a clipboard image into a file before pasting, return its path',
      ),
      c(
        'clipboard/write_text',
        '写文本到 Windows 剪贴板',
        'Write text to the Windows clipboard',
      ),
      c(
        'clipboard/write_image_file',
        '把图片文件放进 Windows 剪贴板',
        'Put an image file on the Windows clipboard',
      ),
      c('ime/query_state', '查询输入法状态', 'Query the input method state'),
    ],
  },
  {
    id: 'relay-reads',
    title: { zh: 'relay：读取', en: 'relay: reads' },
    summary: {
      zh: '远程网页端经 relay、本机网页端经 Runtime → bridge 调用，两边跑的是同一个 readRPC。读取不需要设备签名，只需要配对令牌（或本机信任）。',
      en: 'Called by the remote web console through the relay and by the local one through Runtime → bridge; both run the same readRPC. Reads need the pairing token (or local trust), not a device signature.',
    },
    source: 'native/wezdeck-wsl/relay.go (readRPC)',
    items: [
      c(
        'sessions',
        '会话列表：状态、窗格、最近一句',
        'The session list: state, pane, last line',
      ),
      c(
        'session',
        '一条会话的对话：首屏 / since 增量 / before 更早',
        'One conversation: first page / since / before',
      ),
      c(
        'session.image',
        '转录里的一张图片：原图分块（缩略图由页面生成）',
        'A transcript image: the original in chunks (the page makes the thumbnail)',
      ),
      c(
        'upload.get',
        '已上传图片的原图分块',
        'A chunk of an uploaded image’s original',
      ),
      c('todos', '仓库待办', 'Repository to-dos'),
      c('repos', '可以新开会话的仓库', 'Repositories a session can start in'),
      c(
        'agent.profiles',
        '主机注册的 agent profile 与默认项（不含凭据）',
        'Host agent profiles and default (without credentials)',
      ),
      c(
        'workstations',
        '某仓库按方向分组的工作站与是否空闲，供新会话选方向复用',
        'A repository’s workstations by direction and whether each is idle, for 新会话 to reuse one',
      ),
      c(
        'ticket.targets',
        '可以开单的目标仓库',
        'Repositories a ticket can go to',
      ),
      c(
        'session.new.job',
        '新开会话任务的进度',
        'Progress of a session being started',
      ),
      c(
        'session.handoff.job',
        '跨 agent 接力任务的进度',
        'Progress of a cross-agent handoff',
      ),
      c(
        'session.history',
        '同一项目里更早的 Claude 会话，供「恢复会话」选择',
        'Earlier Claude conversations of the project, for 恢复会话',
      ),
      c(
        'session.git',
        '会话所在检出的改动文件、未推送 / 未拉取与最近提交（点 git 标签时）',
        'Changed files, unpushed / unpulled and recent commits of the checkout (on tapping the git tag)',
      ),
      c(
        'session.skills',
        '会话 agent 实际加载的 skill（Claude 读会话记录、Codex 读 rollout、Grok 跑 inspect），供「能力」与输入框 / 补全',
        'Skills the session agent was actually given (Claude transcript, Codex rollout, Grok inspect), for 能力 and the composer / completion',
      ),
    ],
  },
  {
    id: 'relay-writes',
    title: { zh: 'relay：写入', en: 'relay: writes' },
    summary: {
      zh: '远程设备的写入要带已批准设备的签名（verifyWrite），本机浏览器的写入标为 local；两者都进 runWrite，受同一组保护并各记一行日志。',
      en: 'Remote writes carry an approved device’s signature (verifyWrite); host browser writes are marked local. Both go through runWrite under the same guards, one log row each.',
    },
    source: 'native/wezdeck-wsl/remote_write.go (runWrite)',
    items: [
      c('send', '往会话窗格发一条消息', 'Send a message to a session’s pane'),
      c(
        'key',
        '发一个按键（Enter、Esc、方向键、选项数字）',
        'Send a key (Enter, Esc, arrows, an option number)',
      ),
      c(
        'reply',
        '回复工单，可选「回复并继续」',
        'Reply to a ticket, optionally continue it',
      ),
      c(
        'attach',
        '在目标仓库的 tmux 窗口里打开工单的 Agent 会话，点选项不够用时接手',
        'Open a ticket’s agent session in a tmux window of its repository, for when a tap is not enough',
      ),
      c(
        'upload',
        '分片上传文件（图片等），发消息时引用',
        'Upload a file in chunks (an image, say) for a message to reference',
      ),
      c('todo', '增改仓库待办', 'Add or change a to-do'),
      c(
        'clear',
        '把一条会话标为已读（等同终端 Alt+/ 里的 Ctrl+X）',
        'Mark a session as read (Ctrl+X in the desk’s Alt+/ picker)',
      ),
      c(
        'session.new',
        '在某仓库新开一个会话：新建一个方向的工作站（方向名 + 一行描述）',
        'Start a session in a repository: a new workstation for one direction (name + one-line purpose)',
      ),
      c(
        'session.new.trust',
        '用户确认后只批准该新会话中 Agy 正显示的工作树信任提示',
        'Confirm only the Agy workspace trust prompt currently shown for that new session',
      ),
      c(
        'agent.profile.configure',
        '写入 Kimi API key 与模型到主机独立凭据文件，不回传密钥',
        'Write the Kimi API key and model to the host credential file without returning the key',
      ),
      c(
        'agent.profile.model',
        '为单个受管 Agent profile 保存或清除模型覆盖',
        'Save or clear the model override for one managed agent profile',
      ),
      c(
        'agent.profile.settings',
        '保存智能体备注与停用状态，阻止停用项的新会话和接力',
        'Save an agent note and disabled state; block new sessions and handoffs to disabled profiles',
      ),
      c(
        'worktree.describe',
        '改工作站的一行描述（git 分支描述，等同终端 Alt+g 里的 Ctrl+e）',
        'Set a workstation’s one-line purpose (its git branch description; Ctrl+e in the desk’s Alt+g)',
      ),
      c(
        'session.restart',
        '重启会话所在窗格（等同终端 F5，agent 恢复原会话）或新开全新进程（等同 Ctrl+Shift+n）',
        'Respawn the session pane (the desk F5: the agent resumes) or start a blank agent process (Ctrl+Shift+n)',
      ),
      c(
        'session.handoff',
        '跨 agent 接力：本格替换为目标 agent，粘贴接续 brief（不 recycle、不迁 transcript；之后 F5 跟目标 agent）',
        'Cross-agent handoff: replace this pane with the target agent and paste a continuation brief (no recycle, no transcript migrate; later F5 keeps the target)',
      ),
      c('ticket.new', '开一张跨仓库工单', 'File a cross-repo ticket'),
    ],
  },
  {
    id: 'relay-other',
    title: { zh: 'relay：设备与诊断', en: 'relay: devices and diagnostics' },
    summary: {
      zh: '只经远程链接可用。',
      en: 'Over the remote link only.',
    },
    source: 'native/wezdeck-wsl/relay.go (dispatchRPC)',
    items: [
      c(
        'device.register',
        '登记这台设备的公钥，等主机批准',
        'Register this device’s public key for approval on the host',
      ),
      c(
        'usage',
        '今天的 Cloudflare 用量：主机代为向 Worker 查询，只答复已获批的设备',
        'Today’s Cloudflare usage: the host asks the Worker for it, and answers approved devices only',
      ),
      c(
        'device.hello',
        '每条连接用设备密钥签名报到，之后才能读取',
        'Sign in on each connection with the device key before any read',
      ),
      c(
        'diag.submit',
        '把客户端的连接诊断交给主机记录',
        'Hand the client’s link diagnostics to the host log',
      ),
    ],
  },
  {
    id: 'bridge',
    title: {
      zh: 'bridge：Runtime 能问 WSL 的事',
      en: 'bridge: what the Runtime may ask WSL',
    },
    summary: {
      zh: '白名单之外一律拒绝。remote.* 直接复用 relay 的读写函数，所以本机网页端与远程网页端看到的永远一致。',
      en: 'Anything off the list is refused. remote.* reuses the relay’s read and write functions, so the local and remote web console always agree.',
    },
    source: 'native/wezdeck-wsl/serve.go',
    items: [
      c('workspace.catalog', '工作区与仓库目录', 'Workspaces and repositories'),
      c('git.status', '工作树的 git 状态', 'Git status of a worktree'),
      c('status.wakatime', '今日编码时长', 'Today’s coding time'),
      c(
        'collab.*',
        '工单读取：health / list / show / events / run / prompt / transcript / metrics',
        'Ticket reads: health / list / show / events / run / prompt / transcript / metrics',
      ),
      c('remote.<读取>', 'relay 的全部读取', 'Every relay read'),
      c(
        'remote.devices',
        '已登记的设备（待批准 / 已批准，不含公钥）：只给本机浏览器，relay 不提供',
        'Registered devices (pending / approved, no keys): for the host browser only, not over the relay',
      ),
      c(
        'remote.device.approve',
        '批准一台待批准的设备：只给本机浏览器，relay 不提供',
        'Approve a pending device: for the host browser only, not over the relay',
      ),
      c(
        'remote.diag.pending',
        '本机浏览器轮询主机发来的诊断请求（本机模式收不到 relay 推送）：只给本机浏览器',
        'The host browser polling for the host’s diagnostics requests (local mode gets no relay push): host browser only',
      ),
      c(
        'remote.diag.submit',
        '本机浏览器把诊断快照分块交回 relay：只给本机浏览器',
        'The host browser handing its diagnostics snapshot back to the relay, in chunks: host browser only',
      ),
      c(
        'remote.device.revoke',
        '撤销一台已批准的设备，relay 下一次读写即拒绝：只给本机浏览器',
        'Revoke an approved device; the relay refuses its next read or write: for the host browser only',
      ),
      c(
        'remote.<写入>',
        'relay 的全部写入，记为 local',
        'Every relay write, marked local',
      ),
      c('bridge.status', 'bridge 自身状态', 'The bridge’s own status'),
    ],
  },
]

export type Decision = { title: Text; body: Text }

export const decisions: Array<Decision> = [
  {
    title: { zh: '直连优先，中转兜底', en: 'Direct first, relay as fallback' },
    body: {
      zh: 'WebRTC 直连延迟低、不经过 Cloudflare；但有的网络打不通，所以 WebSocket 中转一直在，切换对界面透明。',
      en: 'A direct WebRTC link is faster and keeps traffic off Cloudflare, but some networks block it, so the WebSocket relay is always there and the switch is invisible.',
    },
  },
  {
    title: {
      zh: '远程写入要签名，本机写入只认正式控制台',
      en: 'Remote writes are signed; local writes only from the production console',
    },
    body: {
      zh: '配对令牌只证明「能读」。能往终端里打字的权限要绑定到一台被主机批准过的设备。本机浏览器已经在主机上，签名不增加安全，所以不签名；但本机的「来源」不等于可信——localhost 上任何开发服务器都能发请求，因此本机写入只认正式站点来源，并校验 Host 防 DNS rebinding。',
      en: 'The pairing token only proves the right to read. Typing into a terminal is bound to a device the host approved. A browser on the host gains nothing from a signature, so it does not sign; but being on the host is not trust — any dev server on localhost can send requests — so local writes accept the production origin only, and the Host is checked against DNS rebinding.',
    },
  },
  {
    title: {
      zh: '增量同步，而不是每次全量',
      en: 'Incremental sync, not full reloads',
    },
    body: {
      zh: '长对话动辄几百 KB。客户端缓存 + since 增量，让空闲轮询只有一两 KB，打开会话不再等。',
      en: 'Long conversations run to hundreds of KB. A client cache plus `since` keeps an idle poll to a kilobyte or two and makes opening instant.',
    },
  },
  {
    title: { zh: '一个窗格一个写者', en: 'One writer per pane' },
    body: {
      zh: '网页端不另起 Agent 进程，只往会话已有的窗格里粘贴。终端有人在打字时，网页端等一下再发，不会把两边的输入搅在一起。',
      en: 'The web console never starts a second agent process; it pastes into the pane the session already has. While someone types at the desk, it waits rather than mixing the two.',
    },
  },
  {
    title: { zh: '浏览器槽二选一', en: 'One browser in the slot' },
    body: {
      zh: 'Ego 与调试 Chrome 都给 Agent 用，同时开着既费内存又让 Agent 不知道该用哪个。切换后端时，另一边会被停掉。',
      en: 'Ego and the debug Chrome both serve agents; running both wastes memory and leaves agents guessing. Switching the backend stops the other one.',
    },
  },
  {
    title: { zh: '有变化才拉工单列表', en: 'Ticket lists refetch on change' },
    body: {
      zh: '先拉一份很小的健康摘要（事件序号、计数、运行中），只有它变了才重新拉列表。',
      en: 'A small health summary (event head, counts, runs) is fetched first; the list is fetched again only when it changes.',
    },
  },
]
