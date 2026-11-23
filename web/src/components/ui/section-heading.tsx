import { cn } from '#/lib/utils'

/**
 * A section's heading in long, sectioned scrolling content (会话信息, 本机,
 * 交互调试…): it sticks to the top of the scroller while its section scrolls
 * under it, and the next heading pushes it away — so the nearest heading is
 * always in view, the way the conversation pins the user's message
 * (chat-sticky.tsx). Interaction convention: docs/web-pwa.md "Sticky
 * context". `className` brings the container's fill so rows don't show
 * through.
 */
export function SectionHeading({
  as: Tag = 'h3',
  className,
  children,
}: {
  as?: 'h2' | 'h3'
  /** the fill of the surface it sits on: bg-brand-deck, bg-brand-surface … */
  className?: string
  children: React.ReactNode
}) {
  return (
    <Tag
      className={cn(
        'sticky top-0 z-10 px-1 py-1.5 text-caption font-semibold text-brand-muted',
        className,
      )}
    >
      {children}
    </Tag>
  )
}
