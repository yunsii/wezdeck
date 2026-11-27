// Anti-flash loading gate (spin-delay pattern):
// - If a request settles within `delayMs`, stays `false` the whole time so
//   fast local/LAN reads go straight to content without flashing a skeleton.
// - Once the skeleton does appear, holds it for at least `minHoldMs` so a
//   160 ms response never flashes a placeholder for 10 ms before snapping away.
import { useEffect, useRef, useState } from 'react'

export type DelayedLoadingOptions = {
  delayMs?: number
  minHoldMs?: number
}

export function createDelayedLoadingController(
  onChange: (visible: boolean) => void,
  { delayMs = 150, minHoldMs = 240 }: DelayedLoadingOptions = {},
) {
  let shownAt: number | null = null
  let prevKey: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    update(pending: boolean, resetKey: string) {
      const keyChanged = prevKey !== null && prevKey !== resetKey
      prevKey = resetKey

      if (keyChanged) {
        clear()
        shownAt = null
        onChange(false)
      }

      if (pending) {
        if (shownAt !== null || timer !== null) return
        timer = setTimeout(() => {
          timer = null
          shownAt = Date.now()
          onChange(true)
        }, delayMs)
        return
      }

      clear()
      if (shownAt === null) {
        onChange(false)
        return
      }

      const remaining = minHoldMs - (Date.now() - shownAt)
      if (remaining <= 0) {
        shownAt = null
        onChange(false)
        return
      }

      timer = setTimeout(() => {
        timer = null
        shownAt = null
        onChange(false)
      }, remaining)
    },
    dispose() {
      clear()
    },
  }
}

export function useDelayedLoading(
  pending: boolean,
  resetKey: string,
  options: DelayedLoadingOptions = {},
): boolean {
  const { delayMs = 150, minHoldMs = 240 } = options
  const [visible, setVisible] = useState(false)
  const controllerRef = useRef<ReturnType<
    typeof createDelayedLoadingController
  > | null>(null)

  useEffect(() => {
    const ctrl = createDelayedLoadingController(setVisible, {
      delayMs,
      minHoldMs,
    })
    controllerRef.current = ctrl
    return () => {
      ctrl.dispose()
      controllerRef.current = null
    }
  }, [delayMs, minHoldMs])

  useEffect(() => {
    controllerRef.current?.update(pending, resetKey)
  }, [pending, resetKey, delayMs, minHoldMs])

  return visible
}
