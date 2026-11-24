// 诊断: the Runtime's log stream (local Runtime only), laid out like 会话 and
// 工单 — on a wide screen the list sticky on the left with the entry beside
// it, j / k move through it; on a phone the list, an entry in a bottom sheet.
// Filters: one row of levels with counts, a search (trace id or text, sent
// to the Runtime), categories in a small select. Entries keep a stable id, so
// the 5 s refresh pushing new lines on top does not move the selection.
import { useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import { Copy, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Led } from '#/components/deck/led'
import type { LedTone } from '#/components/deck/led'
import { Segmented } from '#/components/deck/segmented'
import { Button } from '#/components/ui/button'
import { Field, FieldList } from '#/components/ui/field'
import { Input } from '#/components/ui/input'
import { Select } from '#/components/ui/select'
import { Sheet } from '#/components/ui/sheet'
import { copyText } from '#/lib/clipboard'
import { getDiagnostics } from '#/lib/runtime-client'
import type { DiagnosticsState } from '#/lib/runtime-contract'
import { useIsWidePhoneFirst } from '#/lib/use-media'
import { cn } from '#/lib/utils'
import { useRuntimeData } from './console-data'
import { nextInCycle } from './session-order'

type Raw = DiagnosticsState['entries'][number]
type Level = 'all' | 'warn' | 'error'
type Entry = {
  id: string
  level: string
  category: string
  message: string
  ts: string
  source: string
  trace: string
  raw: string
}

function field(entry: Raw, name: string) {
  const record = entry as unknown as Record<string, unknown>
  const upper =
    name === 'trace_id' ? 'TraceId' : name[0].toUpperCase() + name.slice(1)
  return String(record[name] ?? record[upper] ?? '')
}

export function toEntry(raw: Raw): Entry {
  const message = field(raw, 'message') || field(raw, 'raw')
  const ts = field(raw, 'ts')
  return {
    // stable across refreshes: the same line keeps its id when new ones land
    id: `${ts}|${field(raw, 'trace_id')}|${message.slice(0, 80)}`,
    level: field(raw, 'level') || 'info',
    category: field(raw, 'category'),
    message,
    ts,
    source: field(raw, 'stream') || field(raw, 'source'),
    trace: field(raw, 'trace_id'),
    raw: field(raw, 'raw') || message,
  }
}

const toneOf = (level: string): LedTone =>
  level === 'error' ? 'error' : level === 'warn' ? 'waiting' : 'muted'

/** "14:32:41" out of "2026-11-23 14:32:41.910" */
const clockOf = (ts: string) => ts.match(/\d{2}:\d{2}:\d{2}/)?.[0] ?? ts

export function ConsoleDiagnosticsPage() {
  const { t } = useLingui()
  const wide = useIsWidePhoneFirst()
  const runtime = useRuntimeData()
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState<Level>('all')
  const [category, setCategory] = useState('')
  const [selected, setSelected] = useState('')
  const [sheetOpen, setSheetOpen] = useState(false)
  const logs = useQuery({
    queryKey: ['runtime', 'diagnostics', query],
    queryFn: () => getDiagnostics({ limit: 200, trace: query }),
    enabled: typeof window !== 'undefined',
    refetchInterval: 5_000,
  })
  const all = (logs.data?.entries ?? []).map(toEntry)
  const inCategory = all.filter(
    (entry) => !category || entry.category === category,
  )
  const count = (want: Level) =>
    inCategory.filter((entry) => want === 'all' || entry.level === want).length
  const entries = inCategory.filter(
    (entry) => level === 'all' || entry.level === level,
  )
  const categories = Object.keys(logs.data?.counts ?? {}).sort()
  const current =
    entries.find((entry) => entry.id === selected) ??
    (wide ? entries.at(0) : undefined)
  const empty = logs.isPending
    ? t`Loading…`
    : runtime.connected
      ? t`No matching log entries`
      : t`Runtime diagnostics are unavailable while Runtime is offline.`
  useListKeys(
    wide ? entries.map((entry) => entry.id) : [],
    current?.id ?? '',
    setSelected,
  )

  const filters = (
    <div className="grid gap-2">
      <label className="flex min-h-11 items-center gap-2 rounded-xl border border-brand-edge bg-brand-deck px-3 focus-within:ring-2 focus-within:ring-brand-running md:min-h-9">
        <Search size={15} aria-hidden className="text-brand-label" />
        <Input
          variant="bare"
          type="search"
          value={query}
          aria-label={t`Trace ID or text`}
          placeholder={t`Trace ID or text`}
          onChange={(event) => setQuery(event.target.value.trim())}
          className="min-w-0 flex-1 bg-transparent py-1.5 text-body outline-none placeholder:text-brand-label md:text-caption"
        />
      </label>
      <div className="flex items-center gap-2">
        <Segmented
          label={t`Level`}
          value={level}
          onChange={setLevel}
          className="min-w-0 flex-1"
          options={[
            { value: 'all', label: t`All`, count: count('all') },
            { value: 'warn', label: t`Warnings`, count: count('warn') },
            { value: 'error', label: t`Errors`, count: count('error') },
          ]}
        />
        <div className="w-32 shrink-0">
          <Select
            value={category}
            onValueChange={setCategory}
            aria-label={t`Category`}
            options={[
              { value: '', label: t`All categories` },
              ...categories.map((item) => ({ value: item, label: item })),
            ]}
          />
        </div>
      </div>
    </div>
  )
  const list = (
    <EntryList
      entries={entries}
      selected={wide ? current?.id : undefined}
      empty={empty}
      onPick={(id) => {
        setSelected(id)
        if (!wide) setSheetOpen(true)
      }}
    />
  )
  const detail = current ? (
    <EntryDetail entry={current} onTrace={setQuery} />
  ) : null

  if (wide)
    return (
      <div className="grid content-start gap-3">
        <h1 className="text-body font-semibold">{t`Diagnostics`}</h1>
        <div className="grid grid-cols-[minmax(320px,400px)_minmax(0,1fr)] items-start">
          <aside
            aria-label={t`Log stream`}
            className="sticky top-4 grid h-[calc(100cqh-2rem)] content-start gap-3 overflow-y-auto overscroll-contain border-r border-brand-edge pr-[var(--page-x)] pb-1 [scrollbar-gutter:stable_both-edges]"
          >
            {filters}
            {list}
          </aside>
          <div
            data-testid="diagnostics-pane"
            className="ml-[var(--page-x)] min-w-0 rounded-2xl bg-brand-surface p-5"
          >
            {detail ?? (
              <p className="py-10 text-center text-caption text-brand-muted">
                {empty}
              </p>
            )}
          </div>
        </div>
      </div>
    )
  return (
    <div className="grid content-start gap-3">
      {filters}
      {list}
      <Sheet
        open={sheetOpen && Boolean(current)}
        onOpenChange={setSheetOpen}
        title={t`Log entry`}
        testId="diagnostics-sheet"
      >
        <div className="px-4">{detail}</div>
      </Sheet>
    </div>
  )
}

/** j / k through the list (wide), like 会话 and 工单 */
function useListKeys(
  ids: Array<string>,
  current: string,
  onGo: (id: string) => void,
) {
  const key = ids.join('\n')
  useEffect(() => {
    if (!key) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        (event.key !== 'j' && event.key !== 'k') ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest('input, textarea, select, [contenteditable="true"]') ||
        document.querySelector('[role="dialog"]')
      )
        return
      const next = nextInCycle(
        key.split('\n'),
        current,
        event.key === 'j' ? 1 : -1,
      )
      if (!next) return
      event.preventDefault()
      onGo(next)
      document
        .querySelector(`[data-entry="${CSS.escape(next)}"]`)
        ?.scrollIntoView({ block: 'nearest' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [key, current, onGo])
}

function EntryList({
  entries,
  selected,
  empty,
  onPick,
}: {
  entries: Array<Entry>
  selected?: string
  empty: string
  onPick: (id: string) => void
}) {
  const { t } = useLingui()
  if (entries.length === 0)
    return (
      <p className="rounded-2xl bg-brand-surface px-4 py-10 text-center text-caption text-brand-muted">
        {empty}
      </p>
    )
  return (
    <ul
      aria-label={t`Log stream`}
      className="overflow-hidden rounded-2xl bg-brand-surface"
    >
      {entries.map((entry) => {
        const active = entry.id === selected
        return (
          <li
            key={entry.id}
            className="border-b border-brand-edge last:border-b-0"
          >
            <Button
              variant="plain"
              type="button"
              data-entry={entry.id}
              aria-current={active ? 'true' : undefined}
              onClick={() => onPick(entry.id)}
              className={cn(
                'list-row grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5 px-4 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-running focus-visible:ring-inset',
                active && 'row-selected',
              )}
            >
              <span className="pt-1">
                <Led tone={toneOf(entry.level)} size={10} />
              </span>
              <span className="line-clamp-2 text-body leading-snug text-brand-text">
                {entry.message}
              </span>
              <span className="pt-0.5 font-mono text-meta text-brand-label tabular-nums">
                {clockOf(entry.ts)}
              </span>
              {entry.category ? (
                <span className="col-start-2 truncate text-meta text-brand-label">
                  {entry.category}
                </span>
              ) : null}
            </Button>
          </li>
        )
      })}
    </ul>
  )
}

function EntryDetail({
  entry,
  onTrace,
}: {
  entry: Entry
  onTrace: (trace: string) => void
}) {
  const { t } = useLingui()
  const rows: Array<[string, string]> = [
    [t`Time`, entry.ts],
    [t`Level`, entry.level],
    [t`Category`, entry.category],
    [t`Source`, entry.source],
    [t`Trace`, entry.trace],
  ]
  return (
    <div className="grid gap-4 pb-4">
      <div className="flex items-start gap-2">
        <span className="pt-1.5">
          <Led tone={toneOf(entry.level)} size={11} />
        </span>
        <h2 className="text-heading leading-snug font-semibold break-words md:text-heading">
          {entry.message}
        </h2>
      </div>
      <FieldList>
        {rows
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <Field key={label} label={label} value={value} mono />
          ))}
      </FieldList>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={() => {
            void copyText(entry.raw).then(() => toast(t`Copied the raw line`))
          }}
        >
          <Copy size={14} aria-hidden />
          {t`Copy raw line`}
        </Button>
        {entry.trace ? (
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => onTrace(entry.trace)}
          >
            <Search size={14} aria-hidden />
            {t`Only this trace`}
          </Button>
        ) : null}
      </div>
      <pre className="overflow-auto rounded-xl bg-brand-deck p-3 font-mono text-meta leading-relaxed whitespace-pre-wrap text-brand-muted [overflow-wrap:anywhere]">
        {entry.raw}
      </pre>
    </div>
  )
}
