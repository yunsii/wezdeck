// Unified circular agent avatar used across the chat list (36-40 px),
// agent settings (36-44 px) and form selectors (24 px).
// Corner slots (fixed convention):
//   · top-left  — agent turn status (waiting ▲ / done ✓ / running ●); idle = empty
//   · bottom-right — backend / profile badge (kimi, gateway, …), scaled cleanly
//                    down for compact (<= 28 px) form selectors
// Brand marks share one circular geometry, inner optical scale (~64 %) and
// subtle inset hairline so every agent stays crisp on both light and dark ink.
import { Bot } from 'lucide-react'
import { useEffect, useState } from 'react'

import agyIcon from '#/assets/icons/agents/agy.png'
import { Led } from '#/components/deck/led'
import { cn } from '#/lib/utils'
import type { ChatTone } from './session-chats'

export type AgentFamily = 'claude' | 'codex' | 'grok' | 'agy' | 'agent'

// Keep the raster Agy bitmap decoded and pinned across route unmounts so
// returning to the session list never flashes a blank frame while re-decoding.
let warmedIcons: Array<HTMLImageElement> | null = null

function warmAvatarIcons() {
  if (warmedIcons || typeof Image === 'undefined') return
  const img = new Image()
  img.decoding = 'sync'
  img.src = agyIcon
  void img.decode().catch(() => undefined)
  warmedIcons = [img]
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

function ClaudeMark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 248 248"
      fill="none"
      aria-hidden
    >
      <path
        d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z"
        fill="currentColor"
      />
    </svg>
  )
}

function CodexMark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  )
}

function GrokMark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      aria-hidden
    >
      <path d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815" />
    </svg>
  )
}

function ProfileBadge({
  badge,
  size,
  compact,
}: {
  badge: 'kimi' | 'gateway'
  size: number
  compact: boolean
}) {
  return (
    <span
      aria-hidden
      data-testid="agent-avatar-badge"
      className={cn(
        'pointer-events-none absolute -right-0.5 -bottom-0.5 inline-flex items-center justify-center rounded-full ring-brand-surface',
        compact ? 'ring-1' : 'ring-2',
        badge === 'kimi' ? 'bg-[#12161f]' : 'bg-[#5b63f6]',
      )}
      style={{ width: size, height: size }}
    >
      {badge === 'kimi' ? (
        <svg viewBox="0 0 24 24" className="size-full" fill="none">
          <path
            d="M7 6.5h2.6v4.8l4.4-4.8h3.1l-4.7 5.1 5 5.9h-3.2l-3.7-4.5-.9 1v3.5H7V6.5Z"
            fill="#ffffff"
          />
          <circle cx="18.2" cy="7.2" r="2.1" fill="#2f8cff" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 24 24"
          className="size-[74%]"
          fill="none"
          stroke="#ffffff"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="5.5" r="2.2" />
          <circle cx="6.5" cy="12" r="2.2" />
          <circle cx="17.5" cy="12" r="2.2" />
          <circle cx="12" cy="18.5" r="2.2" />
          <path d="M10.4 7.3 8.1 10.2M8.7 12h6.6M15.9 13.8l-2.3 2.9" />
        </svg>
      )}
    </span>
  )
}

const PLATE_TONE: Record<Exclude<AgentFamily, 'agy' | 'agent'>, string> = {
  claude: 'bg-[#d97757] text-white ring-1 ring-inset ring-black/10',
  codex: 'bg-[#10a37f] text-white ring-1 ring-inset ring-black/10',
  grok: 'bg-[#171b24] text-white ring-1 ring-inset ring-white/15',
}

function AvatarCore({
  family,
  size,
  agyFailed,
  onAgyError,
}: {
  family: AgentFamily
  size: number
  agyFailed: boolean
  onAgyError: () => void
}) {
  const markPx = Math.max(12, Math.round(size * 0.64))
  if (family === 'claude' || family === 'codex' || family === 'grok') {
    return (
      <span
        className={cn(
          'flex size-full items-center justify-center rounded-full',
          PLATE_TONE[family],
        )}
      >
        {family === 'claude' ? (
          <ClaudeMark size={markPx} />
        ) : family === 'codex' ? (
          <CodexMark size={markPx} />
        ) : (
          <GrokMark size={Math.max(11, Math.round(size * 0.6))} />
        )}
      </span>
    )
  }
  if (family === 'agy' && !agyFailed) {
    return (
      <span className="flex size-full items-center justify-center overflow-hidden rounded-full bg-brand-soft ring-1 ring-inset ring-brand-text/12">
        <img
          src={agyIcon}
          alt=""
          width={size}
          height={size}
          decoding="sync"
          draggable={false}
          onError={onAgyError}
          className="size-full scale-[1.18] object-contain"
        />
      </span>
    )
  }
  return (
    <span
      data-testid="agent-avatar-fallback"
      className="flex size-full items-center justify-center rounded-full bg-brand-soft text-brand-muted ring-1 ring-inset ring-brand-edge"
    >
      <Bot size={Math.round(size * 0.56)} strokeWidth={1.9} aria-hidden />
    </span>
  )
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
  tone?: ChatTone | 'error'
}) {
  const family = agentFamily(agent, profile)
  const badge = agentProfileBadge(profile, family)
  const label = title || LABEL[family]
  const compact = size <= 28
  const badgePx = compact
    ? Math.max(10, Math.round(size * 0.42))
    : Math.max(14, Math.round(size * 0.4))
  const statusPx = compact
    ? Math.max(10, Math.round(size * 0.35))
    : Math.max(12, Math.round(size * 0.35))
  const [agyFailed, setAgyFailed] = useState(false)
  useEffect(() => {
    warmAvatarIcons()
  }, [])
  const statusLabel =
    tone === 'waiting'
      ? 'waiting'
      : tone === 'error'
        ? 'error'
        : tone === 'done'
          ? 'done'
          : tone === 'running'
            ? 'running'
            : ''
  const ledTone =
    tone === 'waiting'
      ? 'waiting'
      : tone === 'error'
        ? 'error'
        : tone === 'done'
          ? 'done'
          : 'running'
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
      <AvatarCore
        family={family}
        size={size}
        agyFailed={agyFailed}
        onAgyError={() => setAgyFailed(true)}
      />
      {tone !== 'idle' ? (
        <span
          data-testid="chat-status-dot"
          data-tone={tone}
          className="pointer-events-none absolute -top-0.5 -left-0.5 rounded-full bg-brand-surface p-px"
        >
          <Led tone={ledTone} size={statusPx} label={statusLabel} />
        </span>
      ) : null}
      {badge ? (
        <ProfileBadge badge={badge} size={badgePx} compact={compact} />
      ) : null}
    </span>
  )
}
