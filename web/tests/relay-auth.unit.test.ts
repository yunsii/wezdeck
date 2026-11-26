import { describe, expect, it, vi } from 'vitest'

import { bearerToken, hostAuthorized, safeEqual } from '#/relay/auth'
import { relayFetch } from '#/relay/relay-fetch'
import type { RelayFetchEnv } from '#/relay/relay-fetch'

function makeEnv() {
  const fetch = vi.fn(async () =>
    Response.json({ online: true, since: '2026-11-27T00:00:00Z', clients: 1 }),
  )
  const idFromName = vi.fn((name: string) => `id:${name}`)
  const get = vi.fn(() => ({ fetch }))
  const env: RelayFetchEnv<string> = {
    HOST_RELAY: { idFromName, get },
    RELAY_HOST_TOKEN: 'host-secret',
    RELAY_CLIENT_TOKEN: 'client-secret',
  }
  return { env, idFromName, get, fetch }
}

describe('relay host auth', () => {
  it('an unset host token lets nobody in', () => {
    expect(hostAuthorized('Bearer undefined', undefined)).toBe(false)
    expect(hostAuthorized('Bearer ', '')).toBe(false)
    expect(hostAuthorized('', undefined)).toBe(false)
  })
  it('the right bearer token passes, anything else fails', () => {
    expect(hostAuthorized('Bearer s3cret', 's3cret')).toBe(true)
    expect(hostAuthorized('Bearer s3cres', 's3cret')).toBe(false)
    expect(hostAuthorized('s3cret', 's3cret')).toBe(false)
    expect(hostAuthorized('Basic s3cret', 's3cret')).toBe(false)
    expect(bearerToken('Bearer abc')).toBe('abc')
    expect(bearerToken('abc')).toBe('')
  })
  it('safeEqual refuses empty sides', () => {
    expect(safeEqual('', '')).toBe(false)
    expect(safeEqual('a', 'a')).toBe(true)
  })
})

describe('relayFetch gating', () => {
  it('refuses unauthenticated /relay/health without touching HOST_RELAY or room DOs', async () => {
    const { env, idFromName, get, fetch } = makeEnv()
    const res = await relayFetch(
      new Request('https://wezdeck.yuns.love/relay/health?room=probe-123'),
      env,
    )
    expect(res.status).toBe(401)
    expect(idFromName).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('answers /relay/health for client or host bearer token', async () => {
    for (const token of ['client-secret', 'host-secret']) {
      const { env, idFromName, fetch } = makeEnv()
      const res = await relayFetch(
        new Request('https://wezdeck.yuns.love/relay/health?room=test', {
          headers: { authorization: `Bearer ${token}` },
        }),
        env,
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ online: true, clients: 1 })
      expect(idFromName).toHaveBeenCalledWith('test')
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  })

  it('never touches HOST_RELAY on unauthenticated /relay/host, /relay/client, or unknown paths', async () => {
    const { env, idFromName, get } = makeEnv()
    const cases = [
      new Request('https://wezdeck.yuns.love/relay/host?room=x', {
        headers: { upgrade: 'websocket', authorization: 'Bearer wrong' },
      }),
      new Request('https://wezdeck.yuns.love/relay/client?room=x', {
        headers: {
          upgrade: 'websocket',
          'sec-websocket-protocol': 'wezdeck.v1, token.wrong',
        },
      }),
      new Request('https://wezdeck.yuns.love/relay/unknown?room=x'),
      new Request('https://wezdeck.yuns.love/relay/auth', {
        headers: { authorization: 'client-secret' }, // missing Bearer prefix
      }),
    ]
    const statuses = await Promise.all(
      cases.map((req) => relayFetch(req, env).then((r) => r.status)),
    )
    expect(statuses).toEqual([401, 401, 404, 401])
    expect(idFromName).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  })
})
