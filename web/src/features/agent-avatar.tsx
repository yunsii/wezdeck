// Chat-list avatar: known brand marks under public/icons/agents/;
// unknown agents and failed images use a neutral Bot glyph.
// with an optional corner badge for a non-default managed profile
// (claude_kimi → Kimi, claude_sub2api → gateway).
import { Bot } from 'lucide-react'
import { useState } from 'react'

import { cn } from '#/lib/utils'

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

export function AgentAvatar({
  agent,
  profile,
  size = 40,
  className,
  title,
}: {
  agent?: string
  profile?: string
  size?: number
  className?: string
  title?: string
}) {
  const family = agentFamily(agent, profile)
  const badge = agentProfileBadge(profile, family)
  const label = title || LABEL[family]
  const badgePx = Math.max(14, Math.round(size * 0.4))
  const src = AVATAR_SRC[family]
  const [failedSrc, setFailedSrc] = useState('')
  return (
    <span
      role="img"
      aria-label={badge ? `${label} · ${badge}` : label}
      title={badge ? `${label} · ${badge}` : label}
      data-testid="agent-avatar"
      data-agent={family}
      data-badge={badge || undefined}
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
