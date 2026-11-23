import { trace } from '#/lib/client-trace'
import { cn } from '#/lib/utils'

/** the nearest ancestor that scrolls (the sheet body, the page) */
function scrollerOf(el: HTMLElement) {
  for (let node = el.parentElement; node; node = node.parentElement)
    if (/auto|scroll/.test(getComputedStyle(node).overflowY)) return node
  return document.scrollingElement as HTMLElement | null
}

/**
 * The heading's section (its parent's parent: heading > button) to the top
 * of its scroller. Traced as `section-jump` — scroller position and the
 * section's offset before and after — because it worked headless yet not on
 * a phone (2026-11-23): the next `wezdeck-wsl diag` shows what happened.
 */
function jumpToSection(button: HTMLElement) {
  const section = button.parentElement?.parentElement
  const box = scrollerOf(button)
  if (!section || !box) return
  const offset = () =>
    Math.round(
      section.getBoundingClientRect().top - box.getBoundingClientRect().top,
    )
  const before = { scrollTop: Math.round(box.scrollTop), offset: offset() }
  box.scrollBy({ top: offset(), behavior: 'smooth' })
  setTimeout(() => {
    trace('section-jump', {
      heading: button.textContent.slice(0, 30),
      scroller: `${box.tagName.toLowerCase()}${box.id ? `#${box.id}` : ''}`,
      before,
      after: { scrollTop: Math.round(box.scrollTop), offset: offset() },
    })
  }, 700)
}

/**
 * A section's heading in long, sectioned scrolling content (会话信息, 本机,
 * 交互调试…): it sticks to the top of the scroller while its section scrolls
 * under it, and the next heading pushes it away — so the nearest heading is
 * always in view, the way the conversation pins the user's message
 * (chat-sticky.tsx). A tap brings its section to the top. Interaction
 * convention: docs/web-pwa.md "Sticky context".
 *
 * `className` brings the surface's fill; `.section-cover` (styles/deck.css)
 * repeats it past the heading's box, because on a phone's fast fling the
 * sticky box can trail the content by a frame and rows flashed through the
 * gaps: to the sides always, 8 px up in place (less than any gap between
 * sections, so it never covers the card above), 32 px up once stuck
 * (`scroll-state(stuck: top)`), and the heading gets its own layer.
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
        'section-heading sticky top-0 z-10 text-caption font-semibold text-brand-muted',
        className,
      )}
    >
      <span aria-hidden className="section-cover" />
      <button
        type="button"
        data-section-heading
        onClick={(event) => jumpToSection(event.currentTarget)}
        className="block w-full cursor-pointer px-1 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-running"
      >
        {children}
      </button>
    </Tag>
  )
}
