import { beforeEach, describe, expect, it, vi } from 'vitest'

const postLocalEvents = vi.fn(
  async (_events: Array<unknown>, _dropped: number) => true,
)
vi.mock('../src/lib/runtime-client', () => ({ postLocalEvents }))
vi.mock('../src/lib/pwa', () => ({ buildId: 'test' }))

beforeEach(() => {
  postLocalEvents.mockClear()
  vi.resetModules()
})

describe('local Web events', () => {
  it('keeps only allowlisted fields and event kinds', async () => {
    const { recordLocalEvent, flushLocalEvents } =
      await import('../src/lib/local-events')
    recordLocalEvent('error', {
      message: 'secret token',
      id: 'session-1',
      count: 2,
    })
    recordLocalEvent('unknown', { text: 'secret' })
    await flushLocalEvents()
    expect(postLocalEvents).toHaveBeenCalledOnce()
    expect(postLocalEvents.mock.calls[0]?.[0]).toMatchObject([
      { kind: 'error', data: { id: 'session-1', count: 2 } },
    ])
  })

  it('keeps a Chinese host --reason on host-diag', async () => {
    const { recordLocalEvent, flushLocalEvents } =
      await import('../src/lib/local-events')
    recordLocalEvent('host-diag', {
      action: 'reload',
      reason: '发布网页 e009ca40',
      steps: 1,
    })
    await flushLocalEvents()
    expect(postLocalEvents.mock.calls[0]?.[0]).toMatchObject([
      {
        kind: 'host-diag',
        data: { action: 'reload', reason: '发布网页 e009ca40' },
      },
    ])
  })

  it('keeps only the route path, never its query or fragment', async () => {
    const { recordLocalEvent, flushLocalEvents } =
      await import('../src/lib/local-events')
    recordLocalEvent('boot', { url: '/zh/console/sessions?pair=private#token' })
    await flushLocalEvents()
    expect(postLocalEvents.mock.calls[0]?.[0]).toMatchObject([
      { kind: 'boot', data: { route: '/zh/console/sessions' } },
    ])
    expect(JSON.stringify(postLocalEvents.mock.calls)).not.toContain('private')
  })

  it('caps the queue and reports dropped events', async () => {
    const { recordLocalEvent, flushLocalEvents } =
      await import('../src/lib/local-events')
    for (let i = 0; i < 130; i++) recordLocalEvent('chat-render', { shown: i })
    await flushLocalEvents()
    expect(postLocalEvents.mock.calls[0]?.[0]).toHaveLength(20)
    expect(postLocalEvents.mock.calls[0]?.[1]).toBe(10)
    const sent = postLocalEvents.mock.calls[0]?.[0] as Array<{ seq: number }>
    expect(sent[0]?.seq).toBe(11)
  })

  it('retries the same batch when the local Runtime is unavailable', async () => {
    postLocalEvents.mockResolvedValueOnce(false)
    const { recordLocalEvent, flushLocalEvents } =
      await import('../src/lib/local-events')
    recordLocalEvent('visibility', { state: 'hidden' })
    await flushLocalEvents()
    await flushLocalEvents()
    expect(postLocalEvents).toHaveBeenCalledTimes(2)
    expect(postLocalEvents.mock.calls[1]?.[0]).toEqual(
      postLocalEvents.mock.calls[0]?.[0],
    )
  })

  it('does not count an in-flight batch as dropped during a burst', async () => {
    let release!: (value: boolean) => void
    postLocalEvents.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        }),
    )
    const { recordLocalEvent, flushLocalEvents } =
      await import('../src/lib/local-events')
    for (let i = 1; i <= 20; i++) recordLocalEvent('chat-render', { shown: i })
    const flight = flushLocalEvents()
    for (let i = 21; i <= 140; i++)
      recordLocalEvent('chat-render', { shown: i })
    release(true)
    await flight
    await flushLocalEvents()
    const second = postLocalEvents.mock.calls[1]?.[0] as Array<{ seq: number }>
    expect(second[0]?.seq).toBe(41)
    expect(postLocalEvents.mock.calls[1]?.[1]).toBe(20)
  })
})
