import { useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { Input } from '#/components/ui/input'
import { Select } from '#/components/ui/select'
import { getDiagnostics } from '#/lib/runtime-client'
import type { DiagnosticsState } from '#/lib/runtime-contract'
import { useRuntimeData } from './console-data'
import { Inspector, Reading } from './inspector'

export function ConsoleDiagnosticsPage() {
  const { t } = useLingui()
  const [trace, setTrace] = useState('')
  const [category, setCategory] = useState('')
  const [level, setLevel] = useState('')
  const logs = useQuery({
    queryKey: ['runtime', 'diagnostics', trace],
    queryFn: () => getDiagnostics({ limit: 200, trace }),
    enabled: typeof window !== 'undefined',
    refetchInterval: 5_000,
  })
  const runtime = useRuntimeData()
  const categories = Object.keys(logs.data?.counts ?? {}).sort()
  const entries = (logs.data?.entries ?? []).filter(
    (entry) =>
      (!category || field(entry, 'category') === category) &&
      (!level || field(entry, 'level') === level),
  )
  const items = entries.map((entry, index) => ({
    id: String(index),
    name:
      field(entry, 'message') ||
      field(entry, 'raw') ||
      t`No matching log entries`,
    status: field(entry, 'level') || 'info',
    tone:
      field(entry, 'level') === 'error'
        ? ('error' as const)
        : field(entry, 'level') === 'warn'
          ? ('waiting' as const)
          : ('muted' as const),
    entry,
  }))
  const [selected, setSelected] = useState('0')
  const current = items.find((item) => item.id === selected) ?? items.at(0)

  return (
    <Inspector
      label={t`Log stream`}
      empty={
        logs.isPending
          ? t`Loading…`
          : runtime.connected
            ? t`No matching log entries`
            : t`Runtime diagnostics are unavailable while Runtime is offline.`
      }
      items={items}
      selected={current?.id ?? ''}
      onSelect={setSelected}
      toolbar={
        <div className="grid gap-2">
          <Input
            value={trace}
            aria-label={t`Trace ID or text`}
            placeholder={t`Trace ID or text`}
            onChange={(event) => setTrace(event.target.value.trim())}
          />
          <Select
            value={category}
            onValueChange={setCategory}
            aria-label={t`Category`}
            options={[
              { value: '', label: t`All categories` },
              ...categories.map((item) => ({ value: item, label: item })),
            ]}
          />
          <Select
            value={level}
            onValueChange={setLevel}
            aria-label={t`Level`}
            options={[
              { value: '', label: t`All levels` },
              { value: 'error', label: 'error' },
              { value: 'warn', label: 'warn' },
              { value: 'info', label: 'info' },
            ]}
          />
        </div>
      }
      reading={
        items.length > 0 && current ? (
          <Reading
            kicker={`${current.status} · ${field(current.entry, 'category') || 'uncategorized'}`}
            title={current.name}
            facts={[
              { label: 'time', value: field(current.entry, 'ts') || '—' },
              {
                label: 'source',
                value:
                  field(current.entry, 'stream') ||
                  field(current.entry, 'source') ||
                  '—',
              },
              {
                label: 'trace',
                value: field(current.entry, 'trace_id') || '—',
              },
              { label: t`Entries`, value: String(entries.length) },
            ]}
          >
            <pre className="overflow-auto border border-brand-border bg-brand-deck p-3 font-mono text-xs whitespace-pre-wrap text-brand-muted">
              {field(current.entry, 'raw') || current.name}
            </pre>
          </Reading>
        ) : (
          <Reading
            title={t`No matching log entries`}
            body={t`Try a different trace, category, or level.`}
          />
        )
      }
    />
  )
}

function field(entry: DiagnosticsState['entries'][number], name: string) {
  const record = entry as unknown as Record<string, unknown>
  const upper =
    name === 'trace_id' ? 'TraceId' : name[0].toUpperCase() + name.slice(1)
  return String(record[name] ?? record[upper] ?? '')
}
