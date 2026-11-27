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
  'session.new.trust',
  'agent.profile.configure',
  'agent.profile.model',
  'agent.profile.settings',
  'session.restart',
  'session.delete',
  'session.handoff',
  'session.autotitle.update',
  'ticket.new',
  'worktree.describe',
  'host.warp.set',
])

/**
 * The host's refusal of an unapproved device (relay_auth.go errNotApproved),
 * in the page's language and with where to look — outside React here, so
 * the language comes from <html lang>.
 */
export function describeError(error: string) {
  const zh =
    typeof document !== 'undefined' &&
    document.documentElement.lang.startsWith('zh')
  if (error.startsWith('device not approved')) {
    return zh
      ? '这台设备还没获批，暂时看不到电脑上的内容：到 我的 › 设备授权 提交申请，在电脑上批准它。'
      : 'This device is not approved yet, so the host shows it nothing: request access in Settings › Device access and approve it on the host.'
  }
  if (error.startsWith('pairing link already bound')) {
    return zh
      ? '这个配对链接已经绑定过设备，不能再发起新的审批申请。请在电脑上重新运行 scripts/dev/install-remote-relay.sh --pair 获取新链接。'
      : 'This pairing link is already bound and cannot request approval for another device. Run scripts/dev/install-remote-relay.sh --pair on the host for a new link.'
  }
  if (error.startsWith('pairing link invalid or expired')) {
    return zh
      ? '这个配对链接的授权邀请无效或已过期。请在电脑上重新运行 scripts/dev/install-remote-relay.sh --pair 获取新链接。'
      : 'This pairing invite is invalid or expired. Run scripts/dev/install-remote-relay.sh --pair on the host for a new link.'
  }
  return error || 'remote error'
}

export function isPairingGateError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return (
    error.message.startsWith('pairing link already bound') ||
    error.message.startsWith('pairing link invalid or expired') ||
    error.message.startsWith('这个配对链接已经绑定过设备') ||
    error.message.startsWith('这个配对链接的授权邀请无效或已过期') ||
    error.message.startsWith('This pairing link is already bound') ||
    error.message.startsWith('This pairing invite is invalid or expired')
  )
}

/** the host refused a read: this connection is not bound to an approved device */
export class NotApprovedError extends Error {
  constructor() {
    super(describeError('device not approved'))
    this.name = 'NotApprovedError'
  }
}

/** a refusal frame's error, as the Error the page sees */
export function refusal(error: string) {
  return error.startsWith('device not approved')
    ? new NotApprovedError()
    : new Error(error || 'remote error')
}

/** a read the host refused as not approved, which a fresh hello may cure */
export const retriable = (error: unknown, action: string) =>
  error instanceof NotApprovedError && !OPEN_ACTIONS.has(action)

/**
 * Transient transport errors returned BEFORE the host executed the action
 * (e.g. during a relay restart or Cloudflare DO handoff): safe to retry once
 * after waiting briefly for the link to recover.
 */
export const isTransientReconnectError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  const msg = error.message
  return (
    msg === 'host offline' ||
    msg === 'home host is offline' ||
    msg === 'remote link is not connected'
  )
}
