// Whether this device may write: none → (enable) → pending → (host runs
// install-remote-relay.sh --approve <id>) → approved. A browser on the host
// itself is approved at once: it writes through the local Runtime. The host is the
// source of truth; asking it again is how the phone learns about approval.
import Bowser from 'bowser'
import { useEffect, useSyncExternalStore } from 'react'

import { createDeviceKey, loadDeviceKey } from '#/lib/device-key'
import { remoteLink } from '#/lib/remote-link'
import { hasLocalWrite } from '#/lib/runtime-client'

export type DeviceWriteState = 'checking' | 'none' | 'pending' | 'approved'

let state: { state: DeviceWriteState; id?: string; error?: string } = {
  state: 'checking',
}
const listeners = new Set<() => void>()
const set = (next: typeof state) => {
  state = next
  listeners.forEach((listener) => listener())
}

async function ask(create: boolean) {
  // on this computer the local Runtime takes writes: nothing to pair or approve
  if (await hasLocalWrite().catch(() => false)) {
    set({ state: 'approved', id: 'local' })
    return
  }
  try {
    const key = create ? await createDeviceKey() : await loadDeviceKey()
    if (!key) {
      set({ state: 'none' })
      return
    }
    const info = await clientInfo()
    const name =
      [info.browser, info.os, info.model].filter(Boolean).join(' · ') ||
      'browser'
    const result = (await remoteLink.rpc('device.register', {
      public_key: key.publicRaw,
      name,
      info,
    })) as { state: 'pending' | 'approved' }
    set({ state: result.state, id: key.id })
  } catch (error) {
    const key = await loadDeviceKey()
    set({
      state: key ? 'pending' : 'none',
      id: key?.id,
      error: (error as Error).message,
    })
  }
}

type HintBrand = { brand: string; version: string }
type HintNavigator = Navigator & {
  userAgentData?: {
    platform: string
    mobile: boolean
    getHighEntropyValues: (hints: Array<string>) => Promise<{
      platformVersion?: string
      model?: string
      fullVersionList?: Array<HintBrand>
    }>
  }
}

/**
 * What this browser is, for the host's device list (`install-remote-relay.sh
 * --devices`): the first "(...)" of the UA alone named a Chrome phone "Linux"
 * (Chrome freezes it to "Linux; Android 10; K") and a Firefox one
 * "Android 16", so a device to revoke could not be told apart. Chromium
 * gives client hints (real brand, major version, OS version, model);
 * Firefox / Safari don't, so their UA is parsed.
 */
export async function clientInfo() {
  const nav = navigator as HintNavigator
  const ua = navigator.userAgent
  let browser = ''
  let os = ''
  let model = ''
  const hints = nav.userAgentData
  if (hints) {
    try {
      const high = await hints.getHighEntropyValues([
        'platformVersion',
        'model',
        'fullVersionList',
      ])
      const brand =
        high.fullVersionList?.find(
          (b) => !/not.?a.?brand|chromium/i.test(b.brand),
        ) ?? high.fullVersionList?.find((b) => /chromium/i.test(b.brand))
      if (brand) browser = `${brand.brand} ${brand.version.split('.')[0]}`
      const major = high.platformVersion?.split('.')[0]
      os = [hints.platform, major && major !== '0' ? major : '']
        .filter(Boolean)
        .join(' ')
      model = high.model ?? ''
    } catch {
      // hints refused: fall back to the UA below
    }
  }
  const fallback = uaFallback(ua)
  browser ||= fallback.browser
  os ||= fallback.os
  return {
    browser,
    os,
    model,
    mobile: hints?.mobile ?? fallback.mobile,
    standalone: matchMedia('(display-mode: standalone)').matches,
    language: navigator.language,
    screen: `${screen.width}×${screen.height}`,
    ua: ua.slice(0, 300),
  }
}

/**
 * browser + OS from the UA string, for browsers without client hints
 * (Firefox, Safari): bowser (MIT, maintained) instead of hand-rolled regexes
 * — ua-parser-js 2.x is AGPL. Major versions only; Windows by its marketing
 * name (NT 10.0 → 10).
 */
export function uaFallback(ua: string) {
  const r = Bowser.parse(ua)
  const major = (v?: string) => v?.split('.')[0] ?? ''
  const browser = [r.browser.name, major(r.browser.version)]
    .filter(Boolean)
    .join(' ')
  const os = [r.os.name, r.os.versionName ?? major(r.os.version)]
    .filter(Boolean)
    .join(' ')
  return { browser, os, mobile: r.platform.type === 'mobile' }
}

let started = false

export function useDeviceState() {
  const snapshot = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
    () => state,
  )
  useEffect(() => {
    if (started) return
    started = true
    void ask(false)
  }, [])
  return {
    ...snapshot,
    enable: () => ask(true),
    refresh: () => ask(false),
  }
}
