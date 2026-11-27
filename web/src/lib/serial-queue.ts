// Per-key FIFO serial execution queue. Used by multi-step TUI prompts and
// back-to-back session sends so UI state can advance in 0ms while host tmux
// writes execute strictly in order and abort remaining queued steps on failure.

export function createSerialQueue() {
  const tails = new Map<string, Promise<unknown>>()
  const generations = new Map<string, number>()

  const generationOf = (key: string) => generations.get(key) ?? 0

  const enqueue = <T>(
    key: string,
    task: () => Promise<T>,
  ): Promise<
    { ok: true; value: T } | { ok: false; aborted: boolean; error?: unknown }
  > => {
    const gen = generationOf(key)
    const prev = tails.get(key) ?? Promise.resolve()
    const next = prev.then(
      async (): Promise<
        | { ok: true; value: T }
        | { ok: false; aborted: boolean; error?: unknown }
      > => {
        if (generationOf(key) !== gen) {
          return { ok: false, aborted: true }
        }
        try {
          const value = await task()
          if (Object.is(value, false)) {
            generations.set(key, gen + 1)
            return { ok: false, aborted: false }
          }
          return { ok: true, value }
        } catch (error) {
          generations.set(key, gen + 1)
          return { ok: false, aborted: false, error }
        }
      },
    )
    const tracked = next.finally(() => {
      if (tails.get(key) === tracked) tails.delete(key)
    })
    tails.set(key, tracked)
    return next
  }

  const abort = (key: string) => {
    generations.set(key, generationOf(key) + 1)
  }

  return { enqueue, abort }
}
