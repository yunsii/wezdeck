// A new agent reply writing itself in: phrase-sized batches at reading pace,
// so a long reply is readable as it arrives and the next messages wait their
// turn (chat-thread.tsx reveals them one at a time).
import { useEffect, useRef, useState } from 'react'

const reducedMotion = () =>
  typeof matchMedia !== 'undefined' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches

/** a new batch every 120 ms: calm, phrase-sized steps rather than a ticker */
const TICK_MS = 120
/** let the last batch finish fading in (reveal duration in chat-markdown.tsx) */
const SETTLE_MS = 700
/**
 * Reading pace, not a fixed duration: ~60 chars a second, however long the
 * reply (it used to fit any reply into 3 s, so a long one flashed past); the
 * next messages wait their turn. With two or more queued behind it the pace
 * triples to catch up — and the thread still jumps once it is 8 behind.
 */
const READ_CPS = 60
const RUSH_CPS = 180
const BREAK = /[\s，。！？；：、,.!?;:）)\]】」』]/

/**
 * Where the next batch ends: at least `step` chars on, then on to the next
 * phrase break (punctuation or space) if one is near, else the end of the
 * word; a batch reads as a phrase appearing, not letters ticking in.
 */
function batchEnd(text: string, from: number, step: number) {
  let end = Math.min(text.length, from + step)
  const reach = Math.min(text.length, end + step)
  for (let at = end; at < reach; at++)
    if (BREAK.test(text[at] ?? '')) return at + 1
  while (end < text.length && /[\w\-./:@#%&+=~]/.test(text[end] ?? '')) end++
  return end
}

/**
 * Stream a just-arrived reply in the way Gemini's feels: a phrase-sized
 * batch every 120 ms at a reading pace (about 350 chars/s, the whole
 * message in 0.6–3 s), each batch fading in softly (chat-markdown.tsx) while
 * the thread glides down after it (chat-scroll.ts). Text that grows
 * mid-stream continues from where it is, never from the start.
 */
export function useStream(
  text: string,
  active: boolean,
  onDone?: () => void,
  rush = false,
) {
  const [shown, setShown] = useState(active ? 0 : text.length)
  // the last words are still blurring in when the text is complete
  const [settling, setSettling] = useState(false)
  const at = useRef(shown)
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    if (!active || reducedMotion() || document.hidden) {
      at.current = text.length
      setShown(text.length)
      done.current?.()
      return
    }
    const cps = rush ? RUSH_CPS : READ_CPS
    // short replies still take ~0.6 s, so they don't pop
    const total = Math.max(600, (text.length / cps) * 1000)
    const step = Math.max(2, Math.ceil(text.length / (total / TICK_MS)))
    let tail: ReturnType<typeof setTimeout> | undefined
    const timer = setInterval(() => {
      at.current = batchEnd(text, at.current, step)
      setShown(at.current)
      if (at.current >= text.length) {
        clearInterval(timer)
        setSettling(true)
        tail = setTimeout(() => {
          setSettling(false)
          done.current?.()
        }, SETTLE_MS)
      }
    }, TICK_MS)
    return () => {
      clearInterval(timer)
      clearTimeout(tail)
    }
  }, [text, active, rush])
  return {
    text: text.slice(0, shown),
    streaming: active && (shown < text.length || settling),
  }
}
