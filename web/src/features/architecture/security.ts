// 安全设计 on the architecture page: where each boundary checks what (a
// diagram over the overview's lanes), then threats and the guard against
// each. Keep it true to the code — docs/remote-access.md (auth, signing),
// docs/remote-sessions.md ("Local reads and writes", attachments).
import type { Diagram, Text } from './model'
import { CLOUD, DEVICE, WINDOWS, WSL } from './lanes'

export const securityDiagram: Diagram = {
  id: 'security',
  title: { zh: '信任边界', en: 'Trust boundaries' },
  summary: {
    zh: '读和写分开授权：配对令牌只能读，写入要么带主机批准过的设备签名，要么来自本机的正式控制台；写入到窗格前还有一组统一的保护。',
    en: 'Reading and writing are granted apart: the pairing token only reads; a write carries the signature of a device the host approved, or comes from the production console on the host; every write then passes the same guards before it reaches a pane.',
  },
  lanes: [DEVICE, CLOUD, WINDOWS, WSL],
  cards: [
    {
      id: 'token',
      lane: 'device',
      row: 0,
      title: { zh: '配对令牌', en: 'Pairing token' },
      sub: { zh: '只能读', en: 'Reads only' },
      body: {
        zh: '扫码配对后存在这台设备上，用来连上 HostRelay、读会话和工单。拿到它的人能看，不能写。',
        en: 'Kept on the device after pairing; it joins HostRelay and reads sessions and tickets. Whoever holds it can look, not write.',
      },
      impl: {
        zh: 'WebSocket 子协议 token.<secret>；Worker secret RELAY_CLIENT_TOKEN。',
        en: 'WebSocket subprotocol token.<secret>; Worker secret RELAY_CLIENT_TOKEN.',
      },
    },
    {
      id: 'devkey',
      lane: 'device',
      row: 2,
      title: { zh: '设备密钥', en: 'Device key' },
      sub: {
        zh: '不可导出，主机批准后才能写',
        en: 'Non-extractable; writes after approval',
      },
      body: {
        zh: '浏览器里生成的 ECDSA 密钥，私钥导不出来。设备登记后处于待批准，只能在主机上用命令批准。',
        en: 'An ECDSA key made in the browser whose private half cannot be exported. A registered device waits until it is approved by a command on the host.',
      },
      impl: {
        zh: 'lib/device-key.ts；device.register → install-remote-relay.sh --approve。',
        en: 'lib/device-key.ts; device.register → install-remote-relay.sh --approve.',
      },
    },
    {
      id: 'hostpage',
      lane: 'device',
      row: 3,
      title: { zh: '本机控制台', en: 'Console on the host' },
      sub: {
        zh: '正式站点，直连本地 Runtime',
        en: 'The production site, to the local Runtime',
      },
      body: {
        zh: '在主机上打开的正式控制台不需要配对，读写都走 127.0.0.1 上的 Runtime。',
        en: 'The production console opened on the host needs no pairing; it reads and writes through the Runtime on 127.0.0.1.',
      },
    },
    {
      id: 'auth',
      lane: 'cloud',
      row: 0,
      title: { zh: '令牌校验', en: 'Token check' },
      sub: { zh: '主机、设备各一枚', en: 'One for the host, one for devices' },
      body: {
        zh: '主机和设备用不同的令牌，常量时间比较；令牌没配置时一律拒绝，不会让空值混进来。',
        en: 'The host and devices use different tokens, compared in constant time; an unset token refuses everyone instead of matching an empty value.',
      },
      impl: {
        zh: 'web/src/relay/auth.ts（hostAuthorized、safeEqual）。',
        en: 'web/src/relay/auth.ts (hostAuthorized, safeEqual).',
      },
    },
    {
      id: 'transit',
      lane: 'cloud',
      row: 1,
      title: { zh: '中转可读不可写', en: 'The relay reads, cannot write' },
      sub: { zh: '直连时完全不经手', en: 'Not in the path once direct' },
      body: {
        zh: '直连后数据走 WebRTC（DTLS 加密），Cloudflare 不经手；回落到中转时它能看到内容，但伪造不了设备签名，也重放不了旧请求。',
        en: 'Once direct, data goes over WebRTC (DTLS) and never touches Cloudflare. On the relay fallback it can see content, but cannot forge a device signature or replay an old request.',
      },
      impl: {
        zh: 'web/src/relay/host-relay.ts；签名覆盖原文，主机只用签名里的 action / args。',
        en: 'web/src/relay/host-relay.ts; the signature covers the exact payload and the host uses only the signed action / args.',
      },
    },
    {
      id: 'loopback',
      lane: 'windows',
      row: 3,
      title: { zh: 'Runtime 门禁', en: 'Runtime gate' },
      sub: {
        zh: '只听回环，校验 Host 与来源',
        en: 'Loopback, Host and origin checked',
      },
      body: {
        zh: '只监听 127.0.0.1；Host 不是本机回环名就返回 421，防 DNS rebinding；来源不在白名单就返回 403。',
        en: 'Listens on 127.0.0.1 only; a Host that is not a loopback name gets 421 (DNS rebinding); an origin off the allowlist gets 403.',
      },
      impl: {
        zh: 'RuntimeWebServer.cs IsLoopbackHost、IsOriginAllowed。',
        en: 'RuntimeWebServer.cs IsLoopbackHost, IsOriginAllowed.',
      },
    },
    {
      id: 'writeorigin',
      lane: 'windows',
      row: 4,
      title: { zh: '本机写入', en: 'Local writes' },
      sub: {
        zh: '只认正式站点，开发环境只读',
        en: 'Production only; dev servers read',
      },
      body: {
        zh: '写入必须带来源，且是白名单里的非回环地址：localhost 上任何项目的开发服务器都只能读。只收 JSON（表单提交写不进来），请求体上限 256 KB。',
        en: 'A write needs an origin that is allowlisted and not loopback: any project’s dev server on localhost reads only. JSON only (a form post cannot write), at most 256 KB.',
      },
      impl: {
        zh: 'RuntimeWebServer.Remote.cs IsWriteOriginAllowed。',
        en: 'RuntimeWebServer.Remote.cs IsWriteOriginAllowed.',
      },
    },
    {
      id: 'verify',
      lane: 'wsl',
      row: 1,
      title: { zh: '验签', en: 'Signature check' },
      sub: {
        zh: '已批准设备、±2 分钟、nonce',
        en: 'Approved device, ±2 min, nonce',
      },
      body: {
        zh: '签名不对、设备没批准、时间偏差超过 2 分钟或 nonce 用过，都直接拒绝。用过的 nonce 写到磁盘，relay 重启后也不能重放。',
        en: 'A bad signature, an unapproved device, a clock off by more than 2 min or a used nonce is refused; used nonces are kept on disk, so a relay restart reopens nothing.',
      },
      impl: {
        zh: 'remote_session.go verifyWrite；nonce_store.go。',
        en: 'remote_session.go verifyWrite; nonce_store.go.',
      },
    },
    {
      id: 'guards',
      lane: 'wsl',
      row: 2,
      title: { zh: '写入保护', en: 'Write guards' },
      sub: { zh: '两条路进同一组保护', en: 'Both ways in, one set of guards' },
      body: {
        zh: '按键只走白名单（Enter、Esc、方向、数字、Ctrl+C 等）；消息粘贴前去掉控制字符，不能借粘贴按键；只写会话自己的窗格；电脑前 10 秒内有人输入就等一等。',
        en: 'Keys come from an allowlist (Enter, Esc, arrows, digits, Ctrl+C…); message text loses its control characters before the paste, so it cannot press keys; only the session’s own pane is written; a write waits while the desk was used in the last 10 s.',
      },
      impl: {
        zh: 'remote_write.go runWrite；allowedKeys；paste_safe.go。',
        en: 'remote_write.go runWrite; allowedKeys; paste_safe.go.',
      },
    },
    {
      id: 'bridge',
      lane: 'wsl',
      row: 4,
      title: { zh: 'bridge 白名单', en: 'Bridge allowlist' },
      sub: { zh: 'Runtime 只能问固定的事', en: 'The Runtime asks a fixed set' },
      body: {
        zh: 'Runtime 进 WSL 只能调用白名单里的动作，写入复用 relay 的同一个写入函数。',
        en: 'The Runtime can only call allowlisted actions in WSL; writes reuse the relay’s own write function.',
      },
      impl: { zh: 'serve.go dispatch。', en: 'serve.go dispatch.' },
    },
    {
      id: 'files',
      lane: 'wsl',
      row: 5,
      title: { zh: '文件与范围', en: 'Files and scope' },
      sub: {
        zh: '只读自己的目录，不解码图片',
        en: 'Own directory only; no decoding',
      },
      body: {
        zh: '附件只接受上传目录里的 img-* 文件名，不接受路径；对话图片只限列表里的会话；主机不解码图片；工单只能发往白名单仓库，新会话只能开在已知仓库。',
        en: 'Attachments are bare img-* names in the uploads directory, never paths; transcript images only for listed sessions; the host decodes no image; tickets go only to allowlisted repositories and sessions start only in known ones.',
      },
      impl: {
        zh: 'remote_upload_get.go、remote_image.go、ticket_new.go（ticket.targets）、session_new.go（repos）。',
        en: 'remote_upload_get.go, remote_image.go, ticket_new.go (ticket.targets), session_new.go (repos).',
      },
    },
  ],
  links: [
    {
      from: 'token',
      to: 'auth',
      label: { zh: '配对令牌', en: 'pairing token' },
    },
    { from: 'auth', to: 'transit' },
    {
      from: 'devkey',
      to: 'transit',
      label: { zh: '签名写入', en: 'signed write' },
    },
    { from: 'transit', to: 'verify' },
    { from: 'verify', to: 'guards' },
    {
      from: 'hostpage',
      to: 'loopback',
      label: { zh: '127.0.0.1', en: '127.0.0.1' },
    },
    { from: 'loopback', to: 'writeorigin' },
    { from: 'writeorigin', to: 'bridge' },
    { from: 'bridge', to: 'guards' },
    { from: 'bridge', to: 'files', kind: 'data' },
  ],
}

export type Threat = { threat: Text; guard: Text; impl: Text }

export const threats: Array<Threat> = [
  {
    threat: { zh: '配对链接或令牌泄露', en: 'The pairing link or token leaks' },
    guard: {
      zh: '只能读，写入还需要主机上批准过的设备密钥，私钥导不出浏览器。',
      en: 'It only reads; writing also needs a device key approved on the host, whose private half never leaves the browser.',
    },
    impl: {
      zh: 'verifyWrite；lib/device-key.ts。',
      en: 'verifyWrite; lib/device-key.ts.',
    },
  },
  {
    threat: {
      zh: '中转链路被窥探或篡改',
      en: 'The relay path is watched or tampered with',
    },
    guard: {
      zh: '直连时 DTLS 加密且不经 Cloudflare；中转时内容可见，但签名覆盖原文，改不了，也重放不了（±2 分钟 + 落盘的 nonce）。',
      en: 'Direct links are DTLS and skip Cloudflare; on the relay content is visible but signed over the exact payload, so it cannot be changed or replayed (±2 min + nonces on disk).',
    },
    impl: {
      zh: 'remote_session.go verifyWrite；nonce_store.go。',
      en: 'remote_session.go verifyWrite; nonce_store.go.',
    },
  },
  {
    threat: {
      zh: '冒充主机连上 HostRelay',
      en: 'Impersonating the host at HostRelay',
    },
    guard: {
      zh: '主机令牌独立于设备令牌；令牌未配置时一律拒绝。',
      en: 'The host token is separate from the device token; an unset token refuses everyone.',
    },
    impl: {
      zh: 'relay/auth.ts hostAuthorized。',
      en: 'relay/auth.ts hostAuthorized.',
    },
  },
  {
    threat: {
      zh: '消息里夹带按键（粘贴注入）',
      en: 'Keys smuggled inside a message (paste injection)',
    },
    guard: {
      zh: '粘贴前去掉 ESC 等控制字符，提前结束粘贴的序列变成普通文本；按键只走白名单。',
      en: 'ESC and other control characters are dropped before the paste, so an early paste-end becomes plain text; keys only from the allowlist.',
    },
    impl: {
      zh: 'paste_safe.go；allowedKeys。',
      en: 'paste_safe.go; allowedKeys.',
    },
  },
  {
    threat: {
      zh: '恶意网页经 DNS rebinding 读本机',
      en: 'A web page reads the host through DNS rebinding',
    },
    guard: {
      zh: 'Runtime 只回应 Host 为本机回环名的请求，其余 421。',
      en: 'The Runtime answers only a loopback Host; anything else gets 421.',
    },
    impl: {
      zh: 'RuntimeWebServer.cs IsLoopbackHost。',
      en: 'RuntimeWebServer.cs IsLoopbackHost.',
    },
  },
  {
    threat: {
      zh: '本机其他网页或开发服务器往 Agent 里写',
      en: 'Another page or dev server on the host writes to an agent',
    },
    guard: {
      zh: '本机写入只认正式站点来源，localhost 开发环境只读；只收 JSON，表单提交写不进来。',
      en: 'Local writes accept the production origin only; localhost dev servers read; JSON only, so a form post cannot write.',
    },
    impl: {
      zh: 'RuntimeWebServer.Remote.cs IsWriteOriginAllowed。',
      en: 'RuntimeWebServer.Remote.cs IsWriteOriginAllowed.',
    },
  },
  {
    threat: {
      zh: '借附件或图片读任意文件',
      en: 'Reading any file through an attachment or image',
    },
    guard: {
      zh: '只接受上传目录里的 img-* 裸文件名；对话图片只限列表里的会话。',
      en: 'Only bare img-* names inside the uploads directory; transcript images only for listed sessions.',
    },
    impl: {
      zh: 'remote_upload_get.go；remote_image.go。',
      en: 'remote_upload_get.go; remote_image.go.',
    },
  },
  {
    threat: {
      zh: '一张图片撑爆主机内存',
      en: 'One image exhausts the host’s memory',
    },
    guard: {
      zh: '主机不解码图片，只发字节；缩略图由浏览器生成。',
      en: 'The host decodes no image and sends bytes only; the browser makes thumbnails.',
    },
    impl: {
      zh: 'remote_upload_get.go serveImage；lib/upload-image.ts。',
      en: 'remote_upload_get.go serveImage; lib/upload-image.ts.',
    },
  },
  {
    threat: {
      zh: '手机和电脑前同时输入',
      en: 'The phone and the desk type at once',
    },
    guard: {
      zh: '只写会话自己的窗格，不另起进程；电脑前 10 秒内有输入，手机倒计时后再发。',
      en: 'Only the session’s own pane, never a second process; after input at the desk in the last 10 s the phone counts down and retries.',
    },
    impl: {
      zh: 'remote_write.go runWrite（deskIdle）。',
      en: 'remote_write.go runWrite (deskIdle).',
    },
  },
  {
    threat: { zh: '把活儿派到任意目录', en: 'Sending work to any directory' },
    guard: {
      zh: '工单只能发往配置里的白名单仓库；新会话只能开在已知仓库。',
      en: 'Tickets go only to the configured allowlist; new sessions only in known repositories.',
    },
    impl: {
      zh: 'ticket_new.go（ticket.targets）；session_new.go（repos）。',
      en: 'ticket_new.go (ticket.targets); session_new.go (repos).',
    },
  },
  {
    threat: {
      zh: '超大或很慢的请求拖住 Runtime',
      en: 'Huge or slow requests stall the Runtime',
    },
    guard: {
      zh: '写入请求体读之前限制 256 KB；bridge 超时真正生效，写入走独立连接，不阻塞读取。',
      en: 'Write bodies are capped at 256 KB before reading; bridge timeouts hold, and writes have their own connection so reads never wait.',
    },
    impl: {
      zh: 'RuntimeWebServer.Remote.cs；WslBridge.cs。',
      en: 'RuntimeWebServer.Remote.cs; WslBridge.cs.',
    },
  },
  {
    threat: {
      zh: '日志与设备记录被本机其他用户读到',
      en: 'Other local users read logs or device records',
    },
    guard: {
      zh: 'relay.log、设备与 nonce 文件都是 0600。',
      en: 'relay.log, the device store and the nonce file are 0600.',
    },
    impl: {
      zh: 'relay.go openRelayLog；saveDevices；nonce_store.go。',
      en: 'relay.go openRelayLog; saveDevices; nonce_store.go.',
    },
  },
]
