// 我的 › 应用: installing the app and the version row with 检查更新 — split
// from console-me.tsx, which keeps the index and the other groups.
import { useLingui } from '@lingui/react/macro'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import {
  buildId,
  checkForUpdate,
  promptInstall,
  useInstallState,
} from '#/lib/pwa'

export function Row({
  label,
  value,
}: {
  label: string
  value: React.ReactNode
}) {
  return (
    <div className="flex min-h-9 items-baseline justify-between gap-3 py-2 text-body">
      <span className="text-brand-label">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-meta">
        {value}
      </span>
    </div>
  )
}

export function InstallEntry() {
  const { t } = useLingui()
  const state = useInstallState()
  if (state === 'installed') return <Row label={t`App`} value={t`Installed`} />
  if (state === 'prompt')
    return (
      <Button onClick={() => void promptInstall()} className="min-h-11">
        {t`Install WezDeck`}
      </Button>
    )
  const hint = {
    ios: t`In Safari tap Share, then “Add to Home Screen”.`,
    'in-app': t`Open this page in the system browser first, then install it from there.`,
    unavailable: t`Use the browser menu: “Install app” / “Add to Home screen”.`,
  }[state]
  return <p className="text-caption text-brand-muted">{hint}</p>
}

export function UpdateCheck() {
  const { t } = useLingui()
  const [result, setResult] = useState('')
  const [checking, setChecking] = useState(false)
  const check = () => {
    setChecking(true)
    void checkForUpdate()
      .then((r) =>
        setResult(
          r === 'new'
            ? t`New version ready, reload to use it`
            : r === 'offline'
              ? t`Offline, try again later`
              : t`Already the latest`,
        ),
      )
      .finally(() => setChecking(false))
  }
  // one settings row: 版本, then the build and a quiet text action
  return (
    <div className="grid gap-1">
      <div className="flex min-h-9 items-baseline justify-between gap-3 py-2 text-body">
        <span className="shrink-0 whitespace-nowrap text-brand-label">
          {t`Version`}
        </span>
        <span className="flex min-w-0 items-baseline gap-3">
          <span className="min-w-0 truncate font-mono text-meta">
            {buildId}
          </span>
          <Button
            variant="plain"
            type="button"
            disabled={checking}
            onClick={check}
            className="shrink-0 text-body text-brand-running disabled:opacity-50"
          >
            {checking ? t`Checking…` : t`Check for updates`}
          </Button>
        </span>
      </div>
      {result ? (
        <p role="status" className="text-right text-meta text-brand-muted">
          {result}
        </p>
      ) : null}
    </div>
  )
}
