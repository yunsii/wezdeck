import { useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { getCollab } from '#/lib/runtime-client'
import { useIsWide } from '#/lib/use-media'
import { cn } from '#/lib/utils'
import { num, pct, usd } from './console-collab-format'
import { Button } from '#/components/ui/button'
import { Disclosure } from '#/components/ui/disclosure'

export function RunDetail({
  run,
  poll,
  defaultOpenTranscript,
}: {
  run: string
  poll: number
  /** inside RunDetailSheet the user tapped a run to read it: open Transcript right away */
  defaultOpenTranscript?: boolean
}) {
  const { t } = useLingui()
  const detail = useQuery({
    queryKey: ['runtime', 'collab', 'run', run],
    queryFn: () => getCollab('run', { run }),
    refetchInterval: (query) => (query.state.data?.running ? poll : false),
  })
  const transcript = useQuery({
    queryKey: ['runtime', 'collab', 'transcript', run],
    queryFn: () => getCollab('transcript', { run, tail: 200 }),
    refetchInterval: () => (detail.data?.running ? poll : false),
  })
  const [showPrompt, setShowPrompt] = useState(false)
  const wide = useIsWide()
  const openLog = defaultOpenTranscript ?? wide
  const launch = detail.data?.launch
  const sha = launch?.prompt.store_sha256 ?? ''
  const prompt = useQuery({
    queryKey: ['runtime', 'collab', 'prompt', sha],
    queryFn: () => getCollab('prompt', { sha }),
    enabled: showPrompt && Boolean(sha),
  })
  if (!launch) return null
  const record = detail.data?.record
  const tokens = record?.tokens
  return (
    <section className="grid gap-3" aria-label={t`Run detail`}>
      {/* the agent's own output and the step log: open in the run sheet */}
      <Disclosure
        key={`t-${openLog}`}
        defaultOpen={openLog}
        className="grid gap-2"
        title={
          <span>
            {t`Transcript`}{' '}
            <span className="font-mono text-meta font-normal text-brand-label">
              {detail.data?.running ? t`live` : ''}{' '}
              {num(transcript.data?.total)}
            </span>
          </span>
        }
      >
        <ol
          className="grid max-h-96 gap-px overflow-auto border border-brand-border bg-brand-border font-mono text-meta"
          aria-label={t`Transcript`}
        >
          {(transcript.data?.lines ?? []).map((line, index) => {
            const row = line as Record<string, unknown>
            const text =
              line.kind === 'tool'
                ? `${String(row.name ?? '')} ${String(row.target ?? '')}`
                : line.kind === 'milestone'
                  ? String(row.text ?? '')
                  : line.kind === 'run_end'
                    ? `exit ${String(row.exit)} · ${pct(row.cache_hit_rate as number)} · ${usd(row.cost_usd as number)}`
                    : String(row.message ?? row.reuse ?? row.session_id ?? '')
            return (
              <li
                key={`${line.seq ?? index}`}
                className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2 bg-brand-deck px-2 py-1"
              >
                <span
                  className={cn(
                    line.kind === 'milestone' && 'text-brand-running',
                    line.kind === 'error' && 'text-brand-error',
                    'text-brand-label',
                  )}
                >
                  {line.kind}
                </span>
                <span className="break-all text-brand-muted">{text}</span>
              </li>
            )
          })}
        </ol>
      </Disclosure>
      {record?.final_text_tail ? (
        <Disclosure
          key={`o-${openLog}`}
          defaultOpen={openLog}
          className="grid gap-2"
          title={t`Final output`}
        >
          <pre className="max-h-96 overflow-auto border border-brand-border bg-brand-deck p-3 font-mono text-meta whitespace-pre-wrap text-brand-muted">
            {record.final_text_tail}
          </pre>
        </Disclosure>
      ) : null}
      {/* provenance for debugging: trigger, command, backend, tokens,
          prompt parts — two screens on a phone, so folded */}
      <Disclosure className="grid gap-3" title={t`Launch details`}>
        <div className="grid gap-3">
          <dl className="grid gap-px bg-brand-border sm:grid-cols-2">
            {[
              {
                label: t`Trigger`,
                value: `${launch.trigger?.source ?? '?'} · ${launch.trigger?.actor ?? ''}`,
              },
              {
                label: t`Origin session`,
                value: launch.trigger?.origin_session ?? '—',
              },
              { label: t`Command`, value: launch.trigger?.cmdline ?? '—' },
              {
                label: t`Session`,
                value: `${launch.session?.reuse ?? '?'} · ${launch.session?.reason ?? ''}${
                  launch.session?.from
                    ? ` ← ${launch.session.from.slice(0, 8)}`
                    : ''
                }`,
              },
              {
                label: t`Backend`,
                value: `${launch.invocation.backend} · ${record?.model ?? launch.invocation.model ?? ''} · ${launch.invocation.mode}`,
              },
              {
                label: t`Base commit`,
                value: launch.invocation.base_sha?.slice(0, 12) ?? '—',
              },
              {
                label: t`Initial prompt`,
                value: `${num(launch.prompt.est_tokens)} tok est · ${num(launch.prompt.bytes)} B${
                  launch.prompt.redactions?.length
                    ? ` · redacted ${launch.prompt.redactions.join(',')}`
                    : ''
                }`,
              },
              {
                label: t`Tokens in / cache r / cache w / out`,
                value: `${num(tokens?.input)} / ${num(tokens?.cache_read)} / ${num(tokens?.cache_write)} / ${num(tokens?.output)}`,
              },
            ].map((fact) => (
              <div key={fact.label} className="bg-brand-deck px-3 py-2">
                <dt className="text-meta text-brand-label">{fact.label}</dt>
                <dd className="mt-1 font-mono text-meta break-all">
                  {fact.value}
                </dd>
              </div>
            ))}
          </dl>
          <div className="overflow-x-auto border border-brand-border">
            <table
              className="w-full text-left font-mono text-meta"
              aria-label={t`Prompt composition`}
            >
              <thead className="bg-brand-deck text-brand-label">
                <tr>
                  <th className="px-2 py-1 font-normal">{t`Part`}</th>
                  <th className="px-2 py-1 font-normal">{t`Source`}</th>
                  <th className="px-2 py-1 font-normal">{t`Version`}</th>
                  <th className="px-2 py-1 font-normal">{t`Bytes`}</th>
                </tr>
              </thead>
              <tbody>
                {launch.composition.map((part, index) => (
                  <tr
                    key={`${part.kind}-${index}`}
                    className="border-t border-brand-border"
                  >
                    <td className="px-2 py-1">{part.kind}</td>
                    <td className="px-2 py-1 break-all">
                      {part.source ?? '—'}
                    </td>
                    <td className="px-2 py-1">
                      {(part.git_blob ?? part.sha256 ?? '').slice(0, 10) || '—'}
                    </td>
                    <td className="px-2 py-1">{num(part.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button
            variant="plain"
            type="button"
            className="justify-self-start border border-brand-border px-3 py-1.5 text-meta text-brand-muted hover:border-brand-running hover:text-brand-text focus-visible:ring-2 focus-visible:ring-brand-running focus-visible:outline-none"
            onClick={() => setShowPrompt((value) => !value)}
            aria-expanded={showPrompt}
          >
            {showPrompt ? t`Hide initial prompt` : t`Show initial prompt`}
          </Button>
          {showPrompt ? (
            <pre className="max-h-96 overflow-auto border border-brand-border bg-brand-deck p-3 font-mono text-meta whitespace-pre-wrap text-brand-muted">
              {prompt.data?.ok
                ? prompt.data.text
                : (prompt.data?.error?.message ?? t`Loading…`)}
            </pre>
          ) : null}
        </div>
      </Disclosure>
    </section>
  )
}
