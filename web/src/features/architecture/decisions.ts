// Key architectural trade-offs shown on the Architecture page.
import type { Text } from './model'

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
