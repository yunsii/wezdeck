// The running turn's progress line, from hook timestamps rather than the
// TUI's screen: the host sends when the turn / the compaction began
// (attention turn_started / compact_started) and the turn's output tokens
// (transcript usage); the page ticks the elapsed time itself.
import { useEffect, useState } from 'react'

/** 36s · 4m 39s · 1h 2m — the desk TUI's way of writing it */
export function formatElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** 812 · 19.1k · 1.2M */
export function formatTokens(n: number) {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** now, re-read every second while `on` */
export function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [on])
  return now
}
