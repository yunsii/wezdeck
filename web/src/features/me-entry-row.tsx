import { Link } from '@tanstack/react-router'
import {
  AppWindow,
  Bot,
  ChartNoAxesCombined,
  ChevronRight,
  FlaskConical,
  Monitor,
  Palette,
  ShieldCheck,
  Sparkles,
  Wifi,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { useLocale } from '#/lib/locale-context'
import { useIsWide } from '#/lib/use-media'
import { cn } from '#/lib/utils'
import type { MePage } from './console-me'

const ICONS: Record<MePage, LucideIcon> = {
  agents: Bot,
  autotitle: Sparkles,
  connection: Wifi,
  writing: ShieldCheck,
  usage: ChartNoAxesCombined,
  appearance: Palette,
  app: AppWindow,
  host: Monitor,
  interactions: FlaskConical,
}

export function EntryRow({
  page,
  title,
  value,
  active,
}: {
  page: MePage
  title: string
  value?: React.ReactNode
  active?: boolean
}) {
  const { locale } = useLocale()
  const wide = useIsWide()
  const Icon = ICONS[page]
  return (
    <li className="border-b border-brand-edge last:border-b-0">
      <Link
        to="/{-$locale}/console/me/$page"
        params={{ locale: locale === 'en' ? undefined : locale, page }}
        replace={wide}
        aria-current={active ? 'page' : undefined}
        data-me={page}
        className={cn(
          'key-press flex min-h-13 items-center gap-3 px-4 py-2.5',
          wide && 'list-row',
          active && (wide ? 'row-selected' : 'bg-brand-soft'),
        )}
      >
        <Icon size={18} aria-hidden className="shrink-0 text-brand-label" />
        <span className="min-w-0 flex-1 truncate text-body">{title}</span>
        <span className="max-w-[45%] min-w-0 truncate text-caption text-brand-muted">
          {value}
        </span>
        <ChevronRight
          size={18}
          aria-hidden
          className="shrink-0 text-brand-label"
        />
      </Link>
    </li>
  )
}
