// Reads need an approved device (native/wezdeck-wsl/relay_auth.go): which
// requests go without the per-connection hello, and how the host's refusal
// reads on the page. remote-link.ts says the hello.

/** answered without a hello: asking, saying hello, host-requested diagnostics; writes sign themselves */
export const OPEN_ACTIONS = new Set([
  'device.register',
  'device.hello',
  'diag.submit',
  'send',
  'key',
  'reply',
  'attach',
  'upload',
  'todo',
  'clear',
  'session.new',
  'ticket.new',
])

/**
 * The host's refusal of an unapproved device (relay_auth.go errNotApproved),
 * in the page's language and with where to look — outside React here, so
 * the language comes from <html lang>.
 */
export function describeError(error: string) {
  if (!error.startsWith('device not approved')) return error || 'remote error'
  return document.documentElement.lang.startsWith('zh')
    ? '这台设备还没获批，暂时看不到电脑上的内容：到 我的 › 设备授权 提交申请，在电脑上批准它。'
    : 'This device is not approved yet, so the host shows it nothing: request access in Settings › Device access and approve it on the host.'
}
