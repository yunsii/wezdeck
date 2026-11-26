// Chat-list avatar: official brand marks under public/icons/agents/
// (claude.ai app icon, ChatGPT touch icon, x.ai favicon, kimi.com PWA icon)
// with an optional corner badge for a non-default managed profile
// (claude_kimi → Kimi, claude_sub2api → gateway).
import { cn } from '#/lib/utils'

const ICONS = '/icons/agents'

export type AgentFamily = 'claude' | 'codex' | 'grok' | 'agy' | 'agent'

/** official raster marks */
const AVATAR_SRC: Record<AgentFamily, string> = {
  claude: `${ICONS}/claude.png`,
  codex: `${ICONS}/codex.png`,
  grok: `${ICONS}/grok.png`,
  agy: `${ICONS}/agent.png`,
  agent: `${ICONS}/agent.png`,
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
      <img
        src={AVATAR_SRC[family]}
        alt=""
        width={size}
        height={size}
        draggable={false}
        className="size-full rounded-full object-cover"
      />
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
