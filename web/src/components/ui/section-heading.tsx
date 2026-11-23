import { cn } from '#/lib/utils'

/**
 * A section's heading in long, sectioned scrolling content (会话信息, 本机,
 * 交互调试…): it sticks to the top of the scroller while its section scrolls
 * under it, and the next heading pushes it away — so the nearest heading is
 * always in view, the way the conversation pins the user's message
 * (chat-sticky.tsx). A tap brings its section to the top. Interaction
 * convention: docs/web-pwa.md "Sticky context".
 *
 * `className` brings the surface's fill. A `before:` layer repeats that fill
 * past the heading's box — 8 px up (less than any gap between sections, so
 * it never covers the card above) and to the sides — because on a fast fling
 * the sticky box can trail the content by a frame and rows flashed through
 * the gaps around it.
 */
export function SectionHeading({
  as: Tag = 'h3',
  className,
  children,
}: {
  as?: 'h2' | 'h3'
  /** the fill of the surface it sits on: bg-brand-deck, bg-brand-key … */
  className?: string
  children: React.ReactNode
}) {
  return (
    <Tag
      className={cn(
        'sticky top-0 z-10 text-caption font-semibold text-brand-muted',
        "before:pointer-events-none before:absolute before:-inset-x-3 before:-top-2 before:bottom-0 before:-z-10 before:bg-inherit before:content-['']",
        className,
      )}
    >
      <button
        type="button"
        // the heading's section (its parent) to the top of the scroller
        onClick={(event) =>
          event.currentTarget.parentElement?.parentElement?.scrollIntoView({
            block: 'start',
            behavior: 'smooth',
          })
        }
        className="block w-full cursor-pointer px-1 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-running"
      >
        {children}
      </button>
    </Tag>
  )
}
