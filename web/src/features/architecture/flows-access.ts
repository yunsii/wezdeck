// Device access on the architecture page: how the host joins the relay, how a
// browser becomes an approved device, and what every read and write checks.
// Keep it true to the code — docs/remote-access.md (auth, devices),
// scripts/dev/install-remote-relay.sh, native/wezdeck-wsl/relay_auth.go.
import type { Diagram } from './model'
import { CLOUD, DEVICE, WSL } from './lanes'

export const accessFlow: Diagram = {
  id: 'access',
  title: { zh: '设备授权', en: 'Device access' },
  summary: {
    zh: '主机用自己的令牌登记到中转；浏览器配对后只能连上中转，要登记设备密钥、在主机上批准，之后每条连接签名报到，每次读写都核对它还在批准名单里。撤销后下一次读写就被拒。',
    en: 'The host joins the relay with its own token. A paired browser only reaches the relay: it registers a device key, the host approves it, then each connection signs in and every read and write checks the device is still approved. A revoke refuses the very next request.',
  },
  numbered: true,
  lanes: [DEVICE, CLOUD, WSL],
  cards: [
    {
      id: 'tokens',
      lane: 'wsl',
      title: { zh: '主机生成令牌', en: 'The host makes the tokens' },
      sub: { zh: '主机令牌 + 配对令牌', en: 'Host token + pairing token' },
      body: {
        zh: '首次安装时在主机上随机生成两枚令牌，只存在主机的 0600 文件里，再推送为 Worker 的 secret：主机令牌只给主机用，配对令牌发给要配对的浏览器。',
        en: 'The first install makes two random tokens, kept in a 0600 file on the host and pushed as Worker secrets: the host token is for the host alone, the pairing token goes to browsers being paired.',
      },
      impl: {
        zh: 'install-remote-relay.sh（--push-secrets）；~/.config/shell-env.d/wezdeck-remote.env：WEZDECK_RELAY_HOST_TOKEN / WEZDECK_RELAY_CLIENT_TOKEN。',
        en: 'install-remote-relay.sh (--push-secrets); ~/.config/shell-env.d/wezdeck-remote.env: WEZDECK_RELAY_HOST_TOKEN / WEZDECK_RELAY_CLIENT_TOKEN.',
      },
    },
    {
      id: 'hostjoin',
      lane: 'wsl',
      title: { zh: '主机登记到中转', en: 'The host joins the relay' },
      sub: {
        zh: '常驻的 relay，主动外连',
        en: 'A resident relay, dialing out',
      },
      body: {
        zh: '主机上常驻一个 relay 进程，用主机令牌连上 HostRelay，占住主机席位。主机不开放任何入站端口；只有持主机令牌的一方能当主机，用量接口也只认它。',
        en: 'A resident relay process on the host dials HostRelay with the host token and takes the host seat. The host opens no inbound port; only the holder of the host token can be the host, and only it may read usage.',
      },
      impl: {
        zh: 'systemd 用户单元 wezdeck-relay.service → wezdeck-wsl relay；/relay/host，Authorization: Bearer（relay/auth.ts）。',
        en: 'systemd user unit wezdeck-relay.service → wezdeck-wsl relay; /relay/host, Authorization: Bearer (relay/auth.ts).',
      },
    },
    {
      id: 'room',
      lane: 'cloud',
      title: { zh: 'HostRelay', en: 'HostRelay' },
      sub: { zh: '按令牌分席位，只转发', en: 'Seats by token, forwards only' },
      body: {
        zh: '主机令牌进主机席位，配对令牌进客户端连接，每条客户端连接有自己的编号。中转只看帧类型、按连接编号转发，不看请求内容，也不保存会话数据；设备是否获批由主机判断。',
        en: 'The host token takes the host seat, the pairing token a client connection, each with its own id. The relay looks only at the frame type and forwards by connection id; it never reads a request or keeps session data, and whether a device is approved is the host’s call.',
      },
      impl: {
        zh: 'relay/host-relay.ts（Durable Object）；客户端令牌走 WebSocket 子协议 token.<secret>。',
        en: 'relay/host-relay.ts (Durable Object); the client token rides the WebSocket subprotocol token.<secret>.',
      },
    },
    {
      id: 'pair',
      lane: 'device',
      title: { zh: '扫码配对', en: 'Pair by QR code' },
      sub: { zh: '连得上，但什么也看不到', en: 'Connected, nothing to see' },
      body: {
        zh: '在主机上打印配对链接和二维码，远程网页端打开后把配对令牌存在本机。它只能连上中转：所有配对过的浏览器共用这一枚令牌，它不代表任何一台设备。',
        en: 'The host prints a pairing link and QR code; the remote web console keeps the pairing token. It only reaches the relay: every paired browser shares it, so it names no device.',
      },
      impl: {
        zh: 'install-remote-relay.sh --pair；链接带 #pair=<token>（不进服务器日志）。',
        en: 'install-remote-relay.sh --pair; the link carries #pair=<token> (never in server logs).',
      },
    },
    {
      id: 'register',
      lane: 'device',
      title: { zh: '客户端登记', en: 'The browser registers' },
      sub: { zh: '设备密钥 + 浏览器信息', en: 'Device key + browser info' },
      body: {
        zh: '浏览器生成一把私钥导不出来的 ECDSA 密钥，把公钥和浏览器、系统、机型一起登记到主机，进入待批准。在 我的 › 设备授权 里点「申请授权」。',
        en: 'The browser makes an ECDSA key whose private half cannot be exported and registers the public key with its browser, OS and model; it then waits for approval. Me › Device access › Request access.',
      },
      impl: {
        zh: 'lib/device-key.ts；device.register；浏览器信息取自 UA Client Hints，取不到时用 bowser 解析 UA（features/device-state.ts）。',
        en: 'lib/device-key.ts; device.register; browser info from UA Client Hints, else the UA parsed by bowser (features/device-state.ts).',
      },
    },
    {
      id: 'approve',
      lane: 'wsl',
      title: { zh: '在主机上批准', en: 'Approved on the host' },
      sub: { zh: '只能用主机上的命令', en: 'Only by a command on the host' },
      body: {
        zh: '主机上列出待批准的设备（浏览器 · 系统 · 机型、最近出现时间），核对后批准。网页上没有批准入口，拿到配对令牌的人没法给自己批准。',
        en: 'The host lists pending devices (browser · OS · model, last seen) and approves one after checking it. There is no approve button on the web, so holding the pairing token never approves itself.',
      },
      impl: {
        zh: 'install-remote-relay.sh --devices / --approve <id>；名单在 ~/.config/wezdeck/remote-devices.json。',
        en: 'install-remote-relay.sh --devices / --approve <id>; the list is ~/.config/wezdeck/remote-devices.json.',
      },
    },
    {
      id: 'hello',
      lane: 'device',
      title: { zh: '每条连接签名报到', en: 'Each connection signs in' },
      sub: { zh: '时间戳 + 一次性随机数', en: 'Timestamp + one-time nonce' },
      body: {
        zh: '连接建立后先用设备密钥签名报到，主机核对签名和批准名单，把这条连接绑定到这台设备。同一份签名不能重放到别的连接；主机 relay 重启后，已认证过的连接会自动重新报到。',
        en: 'A new connection first signs in with the device key; the host checks the signature and the list and binds the connection to the device. The same signature cannot be replayed onto another connection; after a relay restart a connection that had signed in signs in again by itself.',
      },
      impl: {
        zh: 'device.hello（lib/remote-link.ts sayHello）→ relay_auth.go deviceHello / verifyWrite。',
        en: 'device.hello (lib/remote-link.ts sayHello) → relay_auth.go deviceHello / verifyWrite.',
      },
    },
    {
      id: 'gate',
      lane: 'wsl',
      title: { zh: '每次读写都核对', en: 'Every read and write is checked' },
      sub: {
        zh: '读看绑定，写再签一次',
        en: 'Reads by binding, writes signed again',
      },
      body: {
        zh: '每次读取都重读批准名单，确认这条连接的设备还在；每次写入（发消息、按键、回复、上传）再单独签名。用量也算读取：页面经 relay 查询，relay 再用主机令牌去问 Worker。',
        en: 'Every read re-reads the approved list for this connection’s device; every write (message, keys, reply, upload) is signed on its own. Usage counts as a read: the page asks the relay, which asks the Worker with the host token.',
      },
      impl: {
        zh: 'relay.go dispatchRPC → readAllowed；写入 verifyWrite；relay_usage.go。',
        en: 'relay.go dispatchRPC → readAllowed; writes verifyWrite; relay_usage.go.',
      },
    },
    {
      id: 'revoke',
      lane: 'wsl',
      title: { zh: '撤销', en: 'Revoke' },
      sub: { zh: '下一次请求就被拒', en: 'Refused on the next request' },
      body: {
        zh: '在主机上撤销后，这台设备的下一次读写就被拒，不用等它断线；页面显示「还没获批」，可以重新申请。',
        en: 'After a revoke on the host the device’s next read or write is refused, without waiting for it to disconnect; the page says it is not approved and can ask again.',
      },
      impl: {
        zh: 'install-remote-relay.sh --revoke <id>；页面按 errNotApproved 前缀识别（lib/remote-auth.ts）。',
        en: 'install-remote-relay.sh --revoke <id>; the page matches the errNotApproved prefix (lib/remote-auth.ts).',
      },
    },
  ],
  links: [
    { from: 'tokens', to: 'hostjoin' },
    {
      from: 'hostjoin',
      to: 'room',
      label: { zh: '主机令牌', en: 'host token' },
    },
    {
      from: 'pair',
      to: 'room',
      label: { zh: '配对令牌', en: 'pairing token' },
    },
    { from: 'pair', to: 'register' },
    {
      from: 'register',
      to: 'approve',
      kind: 'data',
      label: { zh: '待批准', en: 'pending' },
    },
    {
      from: 'hello',
      to: 'gate',
      label: { zh: '签名报到', en: 'signed hello' },
    },
    { from: 'revoke', to: 'gate', kind: 'fallback' },
  ],
}
