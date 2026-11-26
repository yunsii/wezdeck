// Layer bodies for 新会话: compose (message + location bar), place
// (repository + directions), and new (name + purpose). Kept out of
// session-new.tsx so the sheet's wiring stays under the per-function line
// budget.
import { useLingui } from '@lingui/react/macro'
import { ChevronRight } from 'lucide-react'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Textarea } from '#/components/ui/textarea'
import { Select } from '#/components/ui/select'
import { DirectionPicker } from './session-new-direction'
import type { Direction, DirectionPick } from './session-new-direction'

type Repo = { root: string; label: string; visited?: number }

type StageJob = {
  stage: 'creating' | 'starting' | 'sending' | 'done' | 'failed'
  branch?: string
  error?: string
  mode?: 'new' | 'parallel' | 'reuse'
}

export function ComposeLayer({
  busy,
  repoLabel,
  locationClause,
  locationHint,
  prompt,
  setPrompt,
  isNew,
  name,
  slug,
  current,
  stageText,
  error,
  ready,
  onPlace,
  onSubmit,
}: {
  busy: boolean
  repoLabel: string
  locationClause: string
  locationHint: string
  prompt: string
  setPrompt: (next: string) => void
  isNew: boolean
  name: string
  slug: string
  current?: StageJob
  stageText: (job: StageJob) => string
  error: string
  ready: boolean
  onPlace: () => void
  onSubmit: () => void
}) {
  const { t } = useLingui()
  return (
    <>
      <Button
        variant="plain"
        size="none"
        type="button"
        disabled={busy}
        data-testid="new-session-place"
        onClick={onPlace}
        className="flex min-h-12 w-full min-w-0 items-center gap-2 rounded-xl border border-brand-edge bg-brand-surface px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-running"
      >
        <span className="min-w-0 flex-1 truncate text-body text-brand-text">
          <span className="text-brand-muted">{repoLabel || '…'}</span>
          {repoLabel ? <span className="text-brand-label"> › </span> : null}
          <span className="font-medium">{locationClause}</span>
          {locationHint ? (
            <span className="text-brand-label"> · {locationHint}</span>
          ) : null}
        </span>
        <ChevronRight
          size={18}
          aria-hidden
          className="shrink-0 text-brand-label"
        />
      </Button>
      <label className="grid gap-1 text-caption text-brand-muted">
        {t`First message to the agent`}
        <Textarea
          value={prompt}
          disabled={busy}
          rows={4}
          autoFocus
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t`What should it work on?`}
        />
      </label>
      {isNew && name.trim() && !slug ? (
        <p
          role="status"
          data-testid="new-session-slug"
          className="px-1 text-meta text-brand-error"
        >
          {t`Needs letters or digits: it becomes the directory and branch. Put the rest in the description.`}
        </p>
      ) : null}
      {current ? (
        <p
          role="status"
          data-testid="new-session-stage"
          data-stage={current.stage}
          className={
            current.stage === 'failed'
              ? 'rounded-xl bg-brand-error/10 px-3 py-2 text-caption text-brand-error'
              : 'rounded-xl bg-brand-surface px-3 py-2 text-caption'
          }
        >
          {stageText(current)}
          {current.branch ? (
            <span className="block text-meta text-brand-label">
              {current.branch}
            </span>
          ) : null}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-caption text-brand-error">
          {error}
        </p>
      ) : null}
      <Button
        variant="solid"
        type="button"
        disabled={!ready || busy}
        onClick={onSubmit}
        className="min-h-12 px-3 text-body disabled:opacity-40"
      >
        {t`Create session`}
      </Button>
    </>
  )
}

export function PlaceLayer({
  busy,
  chosen,
  repos,
  dirs,
  pick,
  pickedDir,
  plan,
  onRepo,
  onPick,
}: {
  busy: boolean
  chosen: string
  repos: Array<Repo>
  dirs: Array<Direction>
  pick: DirectionPick
  pickedDir?: Direction
  plan: (d: Direction | undefined) => string
  onRepo: (next: string) => void
  onPick: (next: DirectionPick) => void
}) {
  const { t } = useLingui()
  return (
    <>
      <label className="grid gap-1 text-caption text-brand-muted">
        {t`Repository`}
        <Select
          size="lg"
          value={chosen}
          disabled={busy}
          onValueChange={onRepo}
          options={repos.map((r) => ({
            value: r.root,
            label: r.label,
          }))}
        />
      </label>
      <div className="grid gap-1 text-caption text-brand-muted">
        {t`Direction`}
        <DirectionPicker
          directions={dirs}
          value={pick}
          onChange={onPick}
          disabled={busy}
        />
        {pickedDir ? (
          <span
            className="px-1 text-meta text-brand-label"
            data-testid="new-session-plan"
          >
            {plan(pickedDir)}
          </span>
        ) : null}
      </div>
    </>
  )
}

export function NewDirectionLayer({
  busy,
  name,
  slug,
  setName,
  description,
  setDescription,
  onDone,
}: {
  busy: boolean
  name: string
  slug: string
  setName: (next: string) => void
  description: string
  setDescription: (next: string) => void
  onDone: () => void
}) {
  const { t } = useLingui()
  return (
    <>
      <label className="grid gap-1 text-caption text-brand-muted">
        {t`New direction`}
        <Input
          variant="field"
          value={name}
          disabled={busy}
          maxLength={60}
          autoFocus
          onChange={(event) => setName(event.target.value)}
          placeholder={t`e.g. ux, ci, i18n`}
        />
        <span
          className={
            name.trim() && !slug
              ? 'px-1 text-meta text-brand-error'
              : 'px-1 text-meta text-brand-label'
          }
          data-testid="new-session-slug"
        >
          {!name.trim()
            ? t`A new workstation for this direction, off the latest main branch, like Ctrl+k g d at the desk.`
            : slug
              ? t`Worktree ${slug}, branch dev/${slug} (a taken name gets -2)`
              : t`Needs letters or digits: it becomes the directory and branch. Put the rest in the description.`}
        </span>
      </label>
      <label className="grid gap-1 text-caption text-brand-muted">
        {t`Description`}
        <Input
          variant="field"
          value={description}
          disabled={busy}
          maxLength={120}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={t`What this workstation is for, one line`}
        />
      </label>
      <Button
        variant="solid"
        type="button"
        disabled={!slug || busy}
        data-testid="new-session-direction-done"
        onClick={onDone}
        className="min-h-12 px-3 text-body disabled:opacity-40"
      >
        {t`Continue`}
      </Button>
    </>
  )
}
