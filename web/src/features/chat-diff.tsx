// A tool call's body as code: Edit / Write diffs with line numbers and
// syntax colours, like the desk's TUI. The host sends either unified hunks
// (`@@ -a,b +c,d @@`, from Claude's structuredPatch once the call returned,
// native/wezdeck-wsl/tool_patch.go) or, before that and for other agents,
// "- old" / "+ new" lines. Anything else (commands, results) is plain.
import { useEffect, useState } from 'react'

import { highlightLines, langOf } from '#/lib/highlight'
import type { Token } from '#/lib/highlight'
import { cn } from '#/lib/utils'

export type Row = {
  kind: 'hunk' | 'del' | 'add' | 'ctx' | 'note'
  text: string
  /** the line number: old side for a removed line, new side otherwise */
  no?: number
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** body text → rows; `code` says whether the rows are source (worth colours) */
export function parseBody(text: string): { rows: Array<Row>; code: boolean } {
  const lines = text.split('\n')
  if (HUNK.test(lines[0] ?? '')) {
    let oldNo = 0
    let newNo = 0
    const rows = lines.map((line): Row => {
      const hunk = HUNK.exec(line)
      if (hunk) {
        oldNo = Number(hunk[1])
        newNo = Number(hunk[2])
        return { kind: 'hunk', text: line }
      }
      const mark = line[0]
      const body = line.slice(1)
      if (mark === '-') return { kind: 'del', text: body, no: oldNo++ }
      if (mark === '+') return { kind: 'add', text: body, no: newNo++ }
      if (mark === ' ') {
        oldNo++
        return { kind: 'ctx', text: body, no: newNo++ }
      }
      return { kind: 'note', text: line } // "… (+N lines)", "\ No newline"
    })
    return { rows, code: true }
  }
  const diff = lines.some((l) => l.startsWith('- ') || l.startsWith('+ '))
  if (diff)
    return {
      rows: lines.map((line): Row => {
        if (line.startsWith('- ')) return { kind: 'del', text: line.slice(2) }
        if (line.startsWith('+ ')) return { kind: 'add', text: line.slice(2) }
        return { kind: 'note', text: line }
      }),
      code: true,
    }
  return {
    rows: lines.map((line) => ({ kind: 'ctx', text: line })),
    code: false,
  }
}

/** colours for the code rows, once the grammar loaded (plain until then) */
function useTokens(rows: Array<Row>, lang: string | null) {
  const [tokens, setTokens] = useState<Array<Array<Token>> | null>(null)
  const key = rows.map((row) => row.text).join('\n')
  useEffect(() => {
    if (!lang) return
    let live = true
    const code = rows.filter(
      (row) => row.kind !== 'hunk' && row.kind !== 'note',
    )
    void highlightLines(
      code.map((row) => row.text),
      lang,
    ).then((out) => {
      if (live) setTokens(out)
    })
    return () => {
      live = false
    }
  }, [key, lang])
  return tokens
}

const ROW_TONE: Record<Row['kind'], string> = {
  del: 'bg-brand-error/12',
  add: 'bg-brand-done/12',
  ctx: '',
  hunk: 'text-brand-label',
  note: 'text-brand-label',
}
const MARK: Record<Row['kind'], string> = {
  del: '-',
  add: '+',
  ctx: ' ',
  hunk: '',
  note: '',
}

export function ToolBody({ text, file }: { text: string; file?: string }) {
  const { rows, code } = parseBody(text)
  // a Write body is the file itself: colour it too
  const lang = code || file ? langOf(file) : null
  const tokens = useTokens(rows, lang)
  const numbered = rows.some((row) => row.no !== undefined)
  const width = String(Math.max(0, ...rows.map((row) => row.no ?? 0))).length
  let at = 0 // index into tokens (code rows only)
  return (
    <pre
      className="max-h-80 max-w-full min-w-0 overflow-auto rounded-lg bg-brand-deck py-1.5 font-mono text-meta leading-snug"
      data-lang={lang ?? undefined}
    >
      {rows.map((row, index) => {
        const coded = row.kind !== 'hunk' && row.kind !== 'note'
        const line = coded ? tokens?.[at++] : undefined
        return (
          <div
            key={index}
            data-row={row.kind}
            className={cn('flex min-w-0', ROW_TONE[row.kind])}
          >
            {numbered ? (
              <span
                aria-hidden
                style={{ width: `${width + 1}ch` }}
                className="shrink-0 pr-1 text-right text-brand-label/70 tabular-nums select-none"
              >
                {row.no ?? ''}
              </span>
            ) : null}
            {code && coded ? (
              <span
                aria-hidden
                className={cn(
                  'w-[2ch] shrink-0 text-center select-none',
                  row.kind === 'del' && 'text-brand-error',
                  row.kind === 'add' && 'text-brand-done',
                )}
              >
                {MARK[row.kind]}
              </span>
            ) : null}
            <span className="min-w-0 flex-1 px-1 break-all whitespace-pre-wrap">
              {line
                ? line.map((token, i) => (
                    <span key={i} className="code-token" style={token.style}>
                      {token.content}
                    </span>
                  ))
                : row.text || ' '}
            </span>
          </div>
        )
      })}
    </pre>
  )
}
