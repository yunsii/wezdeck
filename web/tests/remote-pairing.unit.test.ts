import { afterEach, describe, expect, it, vi } from 'vitest'

import { describeError, isPairingGateError } from '#/lib/remote-auth'
import {
  adoptPairingHash,
  clearPairingInvite,
  readPairedToken,
  readPairingInvite,
} from '#/lib/remote-pairing'

function stubBrowser(hash: string, initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  const replaceState = vi.fn()
  const confirm = vi.fn(() => true)
  vi.stubGlobal('localStorage', localStorage)
  vi.stubGlobal('location', {
    hash,
    pathname: '/console/collab',
    search: '',
  })
  vi.stubGlobal('history', { state: null, replaceState })
  vi.stubGlobal('document', { documentElement: { lang: 'zh-CN' } })
  vi.stubGlobal('window', { confirm })
  return { store, confirm, replaceState }
}

afterEach(() => {
  clearPairingInvite()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('remote pairing invite handling', () => {
  it('adopts #pair and &invite together and keeps same-token re-pair silent', () => {
    const token = 'A'.repeat(40)
    const invite = 'B'.repeat(24)
    const { confirm } = stubBrowser(`#pair=${token}&invite=${invite}`, {
      'wezdeck.remote.token': token,
    })
    expect(adoptPairingHash()).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    expect(readPairedToken()).toBe(token)
    expect(readPairingInvite()).toBe(invite)
  })

  it('clears stale invite when adopting a different bare #pair token', () => {
    const oldToken = 'A'.repeat(40)
    const newToken = 'C'.repeat(40)
    const { confirm } = stubBrowser(`#pair=${newToken}`, {
      'wezdeck.remote.token': oldToken,
      'wezdeck.remote.invite': 'D'.repeat(24),
    })
    expect(adoptPairingHash()).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(readPairedToken()).toBe(newToken)
    expect(readPairingInvite()).toBe('')
  })

  it('classifies and localizes pairing gate refusal errors', () => {
    vi.stubGlobal('document', { documentElement: { lang: 'zh-CN' } })
    const raw =
      'pairing link already bound: run install-remote-relay.sh --pair on the host for a new link'
    expect(isPairingGateError(new Error(raw))).toBe(true)
    expect(describeError(raw)).toContain('已经绑定过设备')
    expect(isPairingGateError(new Error(describeError(raw)))).toBe(true)

    const exp =
      'pairing link invalid or expired: run install-remote-relay.sh --pair on the host for a new link'
    expect(isPairingGateError(new Error(exp))).toBe(true)
    expect(describeError(exp)).toContain('无效或已过期')
  })
})
