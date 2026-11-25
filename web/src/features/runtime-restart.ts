// The local Runtime restarting under an open page (a runtime sync stops and
// replaces it) left no trace: while it is gone the page drops to the remote
// mode, and once it is back nothing says it happened — only a small 运行时长
// (2026-11-25: 68 s down, noticed only as 这台设备还没获批). Each Runtime
// start has its own health.instance_id: when it changes under the page, say
// so once, with roughly how long it was gone, and leave a trace row. The
// last one seen lives outside React: the mode switch remounts the provider.
import { useLingui } from '@lingui/react/macro'
import { useEffect } from 'react'
import { toast } from 'sonner'

import { trace } from '#/lib/client-trace'

/** a Runtime younger than this is marked 刚重启 in the status band */
export const RECENT_START_MS = 5 * 60_000

let last: { instance: string; at: number } | null = null

export function useRuntimeRestartNotice(
  instance: string | undefined,
  /** when that instance's sample arrived (dataUpdatedAt) */
  sampledAt: number,
) {
  const { t } = useLingui()
  useEffect(() => {
    if (!instance) return
    const before = last
    last = { instance, at: sampledAt }
    if (!before || before.instance === instance) return
    // the gap between the old instance's last sample and the new one's first
    const gone = Math.max(0, Math.round((sampledAt - before.at) / 1000))
    trace('runtime-restart', {
      gone_s: gone,
      from: before.instance,
      to: instance,
    })
    toast(t`The local Runtime restarted (about ${gone} s without it)`)
  }, [instance, sampledAt, t])
}
