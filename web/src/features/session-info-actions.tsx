// Quick-action icon tiles for 会话信息 (Telegram-profile action row):
// copy reference, rename, repository links, and (on this computer) open in
// terminal / VS Code.
import { useLingui } from '@lingui/react/macro'
import {
  Check,
  Code2,
  Copy,
  ExternalLink,
  Pencil,
  SquareTerminal,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { copyText } from '#/lib/clipboard'
import { trace } from '#/lib/client-trace'
import { postRuntimeAction } from '#/lib/runtime-client'
import { cn } from '#/lib/utils'
import { useConsoleMode } from './console-mode'
import type { Detail } from './console-sessions'
import type { RepoLinksTarget } from './repo-links'
import { useFocusInTerminal } from './session-focus'

const tileClass =
  'flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl bg-brand-surface px-2 py-2 text-center text-meta font-medium text-brand-text transition-colors hover:bg-brand-soft active:bg-brand-soft disabled:opacity-40'

function QuickActionTile({
  icon,
  label,
  title,
  testId,
  disabled,
  write,
  hasPopup,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  title?: string
  testId?: string
  disabled?: boolean
  write?: boolean
  hasPopup?: 'dialog'
  onClick: () => void
}) {
  return (
    <Button
      variant="plain"
      size="none"
      type="button"
      data-testid={testId}
      data-write={write ? '' : undefined}
      aria-haspopup={hasPopup}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={tileClass}
    >
      <span className="text-brand-muted">{icon}</span>
      <span className="max-w-full truncate">{label}</span>
    </Button>
  )
}

export function SessionInfoQuickActions({
  data,
  cwd,
  linksTarget,
  onRename,
  renameDisabled,
  onOpenLinks,
}: {
  data: Detail
  cwd: string
  linksTarget: RepoLinksTarget | null
  onRename?: (title: string) => void
  renameDisabled?: boolean
  onOpenLinks: () => void
}) {
  const { t } = useLingui()
  const mode = useConsoleMode()
  const focus = useFocusInTerminal(data.focus)
  const [copiedRef, setCopiedRef] = useState(false)
  const [openingCode, setOpeningCode] = useState(false)
  const openVsCode = async () => {
    setOpeningCode(true)
    try {
      const response = await postRuntimeAction('vscode', 'focus_or_open', {
        requested_dir: cwd,
        distro: 'Ubuntu',
      })
      if (!response.ok)
        throw new Error(response.error?.message || t`Runtime action failed`)
      toast(t`VS Code window focused`)
    } catch (error) {
      toast(error instanceof Error ? error.message : t`Runtime action failed`)
    } finally {
      setOpeningCode(false)
    }
  }
  const tiles: Array<React.ReactNode> = []
  if (data.reference) {
    tiles.push(
      <QuickActionTile
        key="copy-ref"
        icon={
          copiedRef ? (
            <Check size={16} className="text-brand-done" aria-hidden />
          ) : (
            <Copy size={16} aria-hidden />
          )
        }
        label={copiedRef ? t`Copied` : t`Copy reference`}
        title={t`Copy session reference for an agent`}
        onClick={() => {
          void copyText(data.reference ?? '').then(() => {
            setCopiedRef(true)
            setTimeout(() => setCopiedRef(false), 1_500)
          })
        }}
      />,
    )
  }
  if (onRename) {
    tiles.push(
      <QuickActionTile
        key="rename"
        icon={<Pencil size={16} aria-hidden />}
        label={t`Rename`}
        title={t`Rename via /rename in the agent pane`}
        write
        disabled={renameDisabled}
        onClick={() => {
          const title = data.title || ''
          const next = window.prompt(t`New session title`, title)?.trim()
          if (next && next !== title) onRename(next)
        }}
      />,
    )
  }
  if (linksTarget) {
    tiles.push(
      <QuickActionTile
        key="links"
        testId="session-repo-links-button"
        hasPopup="dialog"
        icon={<ExternalLink size={16} aria-hidden />}
        label={t`Links`}
        title={t`Open repository links (key: l)`}
        onClick={() => {
          trace('repo-links', {
            open: true,
            via: 'info',
            repo: linksTarget.label,
          })
          onOpenLinks()
        }}
      />,
    )
  }
  if (focus.available) {
    tiles.push(
      <QuickActionTile
        key="terminal"
        icon={<SquareTerminal size={16} aria-hidden />}
        label={t`Terminal`}
        title={t`Same as Enter in the Alt+/ picker (key: o)`}
        disabled={focus.busy}
        onClick={() => void focus.run()}
      />,
    )
  }
  if (mode === 'local' && cwd) {
    tiles.push(
      <QuickActionTile
        key="vscode"
        icon={<Code2 size={16} aria-hidden />}
        label="VS Code"
        title={t`Open in VS Code`}
        disabled={openingCode}
        onClick={() => void openVsCode()}
      />,
    )
  }
  if (!tiles.length) return null
  return (
    <div
      data-testid="session-info-actions"
      className={cn(
        'grid gap-2',
        tiles.length <= 2
          ? 'grid-cols-2'
          : tiles.length === 3
            ? 'grid-cols-3'
            : 'grid-cols-4',
      )}
    >
      {tiles}
    </div>
  )
}
