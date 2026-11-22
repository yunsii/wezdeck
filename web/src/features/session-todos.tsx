// Repo to-dos (待办) on the phone: the follow-ups of the repository a session
// runs in, kept by the host (scripts/runtime/todo.py, SQLite `todos`) so they
// outlive the conversation. The session page opens them as a toolbar panel —
// add, mark done, or put one into the composer to hand it to this agent;
// 会话 lists every open one under 待跟进. Writes are signed (`todo`), reads
// are not (`todos`).
import { useLingui } from '@lingui/react/macro'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, CornerDownLeft, RotateCcw, X } from 'lucide-react'
import { useState } from 'react'

import { remoteLink } from '#/lib/remote-link'

export type Todo = {
  id: number
  repo_key: string
  repo_label: string
  repo_root: string
  text: string
  done: boolean
  source: 'agent' | 'phone'
  session_id: string | null
  created_at: number
  done_at: number | null
}

type TodoList = { repo: { repo_label: string } | null; todos: Array<Todo> }

const key = (scope: string) => ['remote', 'todos', scope]

export function useTodos(session: string | null, enabled = true) {
  return useQuery({
    queryKey: key(session ?? 'all'),
    enabled: enabled && typeof window !== 'undefined',
    refetchInterval: 15_000,
    queryFn: async () =>
      (await remoteLink.rpc(
        'todos',
        session ? { session } : { all: true },
      )) as TodoList,
  })
}

function useTodoWrite() {
  const client = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (args: Record<string, unknown>) => {
    setBusy(true)
    setError('')
    try {
      await remoteLink.write('todo', args)
      await client.invalidateQueries({ queryKey: ['remote', 'todos'] })
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }
  return { run, busy, error }
}

export function TodoPanel({
  session,
  writable,
  onUse,
  onClose,
}: {
  session: string
  writable: boolean
  /** put a to-do into the composer, to hand it to this session's agent */
  onUse: (text: string) => void
  onClose: () => void
}) {
  const { t } = useLingui()
  const list = useTodos(session)
  const write = useTodoWrite()
  const [text, setText] = useState('')
  const [showDone, setShowDone] = useState(false)
  const todos = list.data?.todos ?? []
  const open = todos.filter((todo) => !todo.done)
  const done = todos.filter((todo) => todo.done)
  const doneCount = done.length
  const repo = list.data?.repo?.repo_label
  const add = async () => {
    if (await write.run({ op: 'add', session, text })) setText('')
  }
  return (
    <div
      data-write
      data-testid="todo-panel"
      className="grid grid-cols-[minmax(0,1fr)] gap-2 rounded-[16px] bg-brand-surface p-2"
    >
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="min-w-0 truncate text-[11.5px] text-brand-label">
          {repo
            ? t`To-dos of ${repo}: they stay with the repo, any session can pick them up`
            : t`To-dos of this repo`}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t`Close to-dos`}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-brand-muted"
        >
          <X size={14} aria-hidden />
        </button>
      </div>
      {writable ? (
        // not a <form>: this panel renders inside the composer's form, and a
        // nested form's submit would send the message instead
        <div className="flex gap-1.5">
          <label htmlFor="todo-input" className="sr-only">
            {t`New to-do`}
          </label>
          <input
            id="todo-input"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
              event.preventDefault()
              if (text.trim() && !write.busy) void add()
            }}
            placeholder={t`A big change to follow up later…`}
            className="min-w-0 flex-1 rounded-[10px] bg-brand-deck px-3 py-2 text-[15px] outline-none placeholder:text-brand-label"
          />
          <button
            type="button"
            onClick={() => void add()}
            disabled={!text.trim() || write.busy}
            className="key-press shrink-0 rounded-[10px] bg-brand-text px-3 text-[14px] font-medium text-brand-deck disabled:opacity-40"
          >
            {t`Add`}
          </button>
        </div>
      ) : null}
      {write.error ? (
        <p role="alert" className="px-1 text-xs text-brand-error">
          {write.error}
        </p>
      ) : null}
      {list.isError ? (
        <p className="px-1 text-xs text-brand-muted">
          {String(list.error.message)}
        </p>
      ) : null}
      <ul className="grid max-h-64 grid-cols-[minmax(0,1fr)] gap-1 overflow-y-auto">
        {open.length === 0 && !list.isPending ? (
          <li className="px-1 py-2 text-[13px] text-brand-muted">
            {t`Nothing to follow up in this repo.`}
          </li>
        ) : null}
        {open.map((todo) => (
          <li
            key={todo.id}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-1 rounded-[10px] bg-brand-deck px-2.5 py-2"
          >
            <span className="text-[14px] leading-snug break-words">
              {todo.text}
            </span>
            <span className="flex gap-1">
              <button
                type="button"
                onClick={() => onUse(todo.text)}
                aria-label={t`Put into the message`}
                title={t`Put into the message for this agent`}
                className="inline-flex size-8 items-center justify-center rounded-full text-brand-muted"
              >
                <CornerDownLeft size={15} aria-hidden />
              </button>
              {writable ? (
                <button
                  type="button"
                  disabled={write.busy}
                  onClick={() => void write.run({ op: 'done', id: todo.id })}
                  aria-label={t`Mark done`}
                  className="inline-flex size-8 items-center justify-center rounded-full text-brand-done disabled:opacity-40"
                >
                  <Check size={16} aria-hidden />
                </button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {done.length ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
          <button
            type="button"
            onClick={() => setShowDone(!showDone)}
            className="px-1 text-left text-[12px] text-brand-label"
          >
            {showDone ? t`Hide done` : t`Done (${doneCount})`}
          </button>
          {showDone
            ? done.slice(0, 20).map((todo) => (
                <div
                  key={todo.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1 px-2.5 text-[13px] text-brand-muted line-through"
                >
                  <span className="break-words">{todo.text}</span>
                  {writable ? (
                    <button
                      type="button"
                      disabled={write.busy}
                      onClick={() =>
                        void write.run({ op: 'reopen', id: todo.id })
                      }
                      aria-label={t`Reopen`}
                      className="inline-flex size-7 items-center justify-center rounded-full no-underline"
                    >
                      <RotateCcw size={13} aria-hidden />
                    </button>
                  ) : null}
                </div>
              ))
            : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * 会话 › 待跟进: every open to-do, grouped by repo. To act on one, open any
 * session of that repo and use its 待办 panel (the noting session may be gone).
 */
export function OpenTodos() {
  const { t } = useLingui()
  const list = useTodos(null)
  const todos = (list.data?.todos ?? []).filter((todo) => !todo.done)
  if (todos.length === 0) return null
  const repos = new Map<string, Array<Todo>>()
  for (const todo of todos)
    repos.set(todo.repo_label, [...(repos.get(todo.repo_label) ?? []), todo])
  return (
    <section
      className="grid grid-cols-[minmax(0,1fr)] gap-2"
      data-testid="open-todos"
    >
      <h2 className="text-[19px] font-bold">{t`To follow up`}</h2>
      <ul className="overflow-hidden rounded-[16px] bg-brand-surface">
        {[...repos].map(([repo, items]) => (
          <li
            key={repo}
            className="grid gap-1 border-b border-brand-edge px-4 py-3 last:border-b-0"
          >
            <span className="text-[13px] font-semibold text-brand-muted">
              {repo}
            </span>
            {items.map((todo) => (
              <span
                key={todo.id}
                className="text-[15px] leading-snug break-words"
              >
                {todo.text}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </section>
  )
}
