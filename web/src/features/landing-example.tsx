import { useState } from 'react'
import { useLingui } from '@lingui/react/macro'

type AgentState = 'running' | 'waiting' | 'done'

type ExampleSession = {
  id: string
  repo: string
  worktree: string
  branch: string
  agent: string
  state: AgentState
}

const sessions: Array<ExampleSession> = [
  {
    id: 'wezterm-config',
    repo: 'wezterm-config',
    worktree: 'primary',
    branch: 'master',
    agent: 'Claude',
    state: 'running',
  },
  {
    id: 'team-stat',
    repo: 'team-stat',
    worktree: 'primary',
    branch: 'main',
    agent: 'Codex',
    state: 'waiting',
  },
  {
    id: 'coco-platform',
    repo: 'coco-platform',
    worktree: 'primary',
    branch: 'master',
    agent: 'Grok',
    state: 'done',
  },
]

const signals = ['Runtime', 'WSL', 'IME', 'Rime'] as const

export function WorkbenchExample() {
  const { t } = useLingui()
  const [activeId, setActiveId] = useState(sessions[0].id)
  const active =
    sessions.find((session) => session.id === activeId) ?? sessions[0]
  const stateLabels: Record<AgentState, string> = {
    running: t`running`,
    waiting: t`waiting`,
    done: t`done`,
  }
  const waitingCount = sessions.filter(
    (session) => session.state === 'waiting',
  ).length
  const runningCount = sessions.filter(
    (session) => session.state === 'running',
  ).length
  const doneCount = sessions.filter(
    (session) => session.state === 'done',
  ).length

  return (
    <figure className="landing-deck-figure">
      <div className="landing-deck-toolbar">
        <span className="landing-window-title">{t`Example`}</span>
        <span className="landing-deck-live">
          <span />
          {t`${waitingCount} waiting`}, {t`${runningCount} running`},{' '}
          {t`${doneCount} done`}
        </span>
      </div>
      <div
        className="landing-deck-tabs"
        role="tablist"
        aria-label={t`Example agent sessions`}
      >
        {sessions.map((session) => {
          const selected = session.id === active.id
          return (
            <button
              key={session.id}
              type="button"
              role="tab"
              id={`landing-session-${session.id}`}
              className={`landing-deck-tab is-${session.state}`}
              aria-selected={selected}
              aria-controls="landing-session-detail"
              onClick={() => setActiveId(session.id)}
            >
              <span className="landing-deck-state" />
              <strong>{session.repo}</strong>
              <span>{stateLabels[session.state]}</span>
            </button>
          )
        })}
      </div>
      <div
        className="landing-deck-detail"
        id="landing-session-detail"
        role="tabpanel"
        aria-labelledby={`landing-session-${active.id}`}
      >
        <p className="landing-deck-crumb">
          {t`work`}
          <span>/</span>
          {active.repo}
          <span>/</span>
          {active.worktree}
          <span>/</span>
          {active.branch}
        </p>
        <dl>
          <div>
            <dt>{t`Agent`}</dt>
            <dd>{active.agent}</dd>
          </div>
          <div>
            <dt>{t`Status`}</dt>
            <dd>{stateLabels[active.state]}</dd>
          </div>
          <div>
            <dt>{t`Branch`}</dt>
            <dd>{active.branch}</dd>
          </div>
        </dl>
      </div>
      <figcaption>
        {t`An example. Select a session to see where you would jump back.`}
      </figcaption>
    </figure>
  )
}

export function ConsoleExample() {
  const { t } = useLingui()
  const labels: Record<(typeof signals)[number], string> = {
    Runtime: t`Runtime`,
    WSL: t`WSL bridge`,
    IME: t`Input method`,
    Rime: t`Rime`,
  }
  const values: Record<(typeof signals)[number], string> = {
    Runtime: t`Ready`,
    WSL: t`Ready`,
    IME: t`English`,
    Rime: t`128 today`,
  }

  return (
    <figure className="landing-console-figure">
      <div className="landing-window-bar">
        <span className="landing-window-dot" />
        <span className="landing-window-dot" />
        <span className="landing-window-dot" />
        <span className="landing-window-title">{t`Example`}</span>
      </div>
      <ul className="landing-signal-list">
        {signals.map((name) => (
          <li key={name}>
            <span className="landing-deck-state" />
            <span>{labels[name]}</span>
            <strong>{values[name]}</strong>
          </li>
        ))}
      </ul>
      <figcaption>{t`Sample signals. The live console reads your local Runtime.`}</figcaption>
    </figure>
  )
}
