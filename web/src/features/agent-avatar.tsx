// Chat-list avatar corner slots (fixed convention):
//   · top-left  — agent turn status (waiting ▲ / done ✓ / running ●); idle = empty
//   · bottom-right — backend / profile badge (kimi, gateway, …)
// Brand mark fills the circle; unknown agents and failed images use Bot.
import { Bot } from 'lucide-react'
import { useState } from 'react'

import { Led } from '#/components/deck/led'
import { cn } from '#/lib/utils'
import type { ChatTone } from './session-chats'

const ICONS = '/icons/agents'

export type AgentFamily = 'claude' | 'codex' | 'grok' | 'agy' | 'agent'

/** raster marks only for verified brands; Agy is from antigravity.google/press */
const AVATAR_SRC: Partial<Record<AgentFamily, string>> = {
  claude: `${ICONS}/claude.png`,
  codex: `${ICONS}/codex.png`,
  grok: `${ICONS}/grok.png`,
  agy: `${ICONS}/agy.png`,
}

const BADGE_SRC: Record<'kimi' | 'gateway', string> = {
  kimi: `${ICONS}/kimi.png`,
  gateway: `${ICONS}/gateway.png`,
}

/** family for the main mark: prefer the live agent, else the profile prefix */
export function agentFamily(agent?: string, profile?: string): AgentFamily {
  const a = (agent || '').replace(/\.real$/, '').toLowerCase()
  if (a === 'claude' || a === 'codex' || a === 'grok' || a === 'agy') return a
  const p = (profile || '').toLowerCase()
  if (p.startsWith('claude')) return 'claude'
  if (p.startsWith('codex')) return 'codex'
  if (p.startsWith('grok')) return 'grok'
  if (p.startsWith('agy')) return 'agy'
  return 'agent'
}

/**
 * Corner badge for a profile that is not just the bare family
 * (claude_kimi, claude_sub2api, …). Empty when the profile is the default
 * family itself or unknown.
 */
export function agentProfileBadge(
  profile?: string,
  family?: AgentFamily,
): 'kimi' | 'gateway' | '' {
  const p = (profile || '').toLowerCase()
  if (!p) return ''
  const fam = family || agentFamily('', p)
  if (p === fam) return ''
  if (p.includes('kimi')) return 'kimi'
  if (p.includes('sub2api') || p.includes('gateway')) return 'gateway'
  return ''
}

const LABEL: Record<AgentFamily, string> = {
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  agy: 'Antigravity',
  agent: 'Agent',
}

export function agentLabel(agent?: string, profile?: string): string {
  return LABEL[agentFamily(agent, profile)]
}

export function AgentAvatar({
  agent,
  profile,
  size = 40,
  className,
  title,
  tone = 'idle',
}: {
  agent?: string
  profile?: string
  size?: number
  className?: string
  title?: string
  /** turn status for the top-left LED; idle hides it */
  tone?: ChatTone
}) {
  const family = agentFamily(agent, profile)
  const badge = agentProfileBadge(profile, family)
  const label = title || LABEL[family]
  const badgePx = Math.max(14, Math.round(size * 0.4))
  const statusPx = Math.max(12, Math.round(size * 0.35))
  const src = AVATAR_SRC[family]
  const [failedSrc, setFailedSrc] = useState('')
  const statusLabel =
    tone === 'waiting'
      ? 'waiting'
      : tone === 'done'
        ? 'done'
        : tone === 'running'
          ? 'running'
          : ''
  const ledTone =
    tone === 'waiting' ? 'waiting' : tone === 'done' ? 'done' : 'running'
  const aria = [label, badge || null, statusLabel || null]
    .filter(Boolean)
    .join(' · ')
  return (
    <span
      role="img"
      aria-label={aria}
      title={aria}
      data-testid="agent-avatar"
      data-agent={family}
      data-badge={badge || undefined}
      data-tone={tone === 'idle' ? undefined : tone}
      className={cn('relative inline-flex shrink-0', className)}
      style={{ width: size, height: size }}
    >
      {src && failedSrc !== src ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          draggable={false}
          onError={() => setFailedSrc(src)}
          className={cn(
            'size-full rounded-full',
            family === 'agy'
              ? 'bg-brand-soft p-[9%] object-contain'
              : 'object-cover',
          )}
        />
      ) : (
        <span
          data-testid="agent-avatar-fallback"
          className="flex size-full items-center justify-center rounded-full border border-brand-edge bg-brand-soft text-brand-muted"
        >
          <Bot size={Math.round(size * 0.55)} aria-hidden />
        </span>
      )}
      {tone !== 'idle' ? (
        <span
          data-testid="chat-status-dot"
          data-tone={tone}
          className="pointer-events-none absolute -top-0.5 -left-0.5 rounded-full bg-brand-deck p-px"
        >
          <Led
            tone={ledTone}
            size={statusPx}
            label={statusLabel}
            className={cn(
              tone === 'running' &&
                'motion-safe:animate-[pulse_1.6s_ease-in-out_infinite]',
            )}
          />
        </span>
      ) : null}
      {badge ? (
        <img
          src={BADGE_SRC[badge]}
          alt=""
          width={badgePx}
          height={badgePx}
          draggable={false}
          data-testid="agent-avatar-badge"
          className="absolute -right-0.5 -bottom-0.5 rounded-full object-cover ring-2 ring-brand-deck"
          style={{ width: badgePx, height: badgePx }}
        />
      ) : null}
    </span>
  )
}
