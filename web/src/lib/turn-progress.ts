// The running turn's progress line, from hook timestamps rather than the
// TUI's screen: the host sends when the turn / the compaction began
// (attention turn_started / compact_started) and the turn's output tokens
// (transcript usage); the page ticks the elapsed time itself.
import { useEffect, useState } from 'react'

const two = (n: number) => String(n).padStart(2, '0')

/**
 * 36s · 4m 09s · 1h 02m — the desk TUI's units, the smaller one zero-padded
 * so a ticking line keeps its width from one second to the next
 * (docs/web-pwa.md "Layout stability")
 */
export function formatElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${two(s % 60)}s`
  return `${Math.floor(m / 60)}h ${two(m % 60)}m`
}

/** 812 · 19.1k · 1.2M */
export function formatTokens(n: number) {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** Host-side token output rate (OTel primary, transcript step-window fallback). */
export type TokenRate = {
  source: 'otel' | 'transcript'
  tok_per_s: number
  last_tok_per_s: number
  decode_tok_per_s?: number
  ttft_ms?: number
  samples: number
  profile?: string
  updated_at_ms?: number
}

/** 56.1 tok/s · 120 tok/s */
export function formatTokenRate(tokPerS: number) {
  if (!Number.isFinite(tokPerS) || tokPerS <= 0) return ''
  const num =
    tokPerS >= 100
      ? String(Math.round(tokPerS))
      : tokPerS.toFixed(1).replace(/\.0$/, '')
  return `${num} tok/s`
}

/** 420ms · 2.6s */
export function formatTtft(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`
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
