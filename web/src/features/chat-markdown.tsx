// Claude's replies are Markdown, rendered with Vercel's Streamdown: a
// react-markdown replacement that renders half-written Markdown (an open
// code fence or table mid-stream) correctly, so a reply can stream in. Tables and code scroll sideways inside their own box so a
// wide block never widens the page; links open outside the app.
import { isValidElement } from 'react'
import { Streamdown, defaultRehypePlugins } from 'streamdown'
import type { Components, StreamdownProps } from 'streamdown'

import { decodeHostFileHash, rehypeHostFileLinks } from '#/lib/host-file-link'
import { cn } from '#/lib/utils'
import { HostFileLink } from './host-file-context'
import { MermaidBlock } from './mermaid-block'

const hardenEntry = defaultRehypePlugins.harden as [
  unknown,
  Record<string, unknown>,
]
// Rewrite valid `file://` links to `#wd-file:...` before sanitize/harden so
// SessionDetail can open host plans & source files via `session.file`, while
// keeping dangerous protocols (`javascript:`, `data:`, raw `file:`) blocked.
const rehypePlugins = [
  defaultRehypePlugins.raw,
  rehypeHostFileLinks,
  defaultRehypePlugins.sanitize,
  [hardenEntry[0], { ...hardenEntry[1], linkBlockPolicy: 'text-only' }],
] as StreamdownProps['rehypePlugins']

const components: Components = {
  p: ({ children }) => (
    <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>
  ),
  h1: ({ children }) => (
    <h3 className="mt-3 mb-1 text-title font-semibold first:mt-0">
      {children}
    </h3>
  ),
  h2: ({ children }) => (
    <h3 className="mt-3 mb-1 text-title font-semibold first:mt-0">
      {children}
    </h3>
  ),
  h3: ({ children }) => (
    <h4 className="mt-2.5 mb-1 text-body font-semibold first:mt-0">
      {children}
    </h4>
  ),
  h4: ({ children }) => (
    <h4 className="mt-2 mb-1 text-body font-semibold first:mt-0">{children}</h4>
  ),
  ul: ({ children }) => (
    <ul className="my-1.5 list-disc space-y-0.5 pl-5">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>
  ),
  li: ({ children }) => (
    <li className="pl-0.5 marker:text-brand-label">{children}</li>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  a: ({ children, href }) => {
    const hostFile = decodeHostFileHash(href)
    if (hostFile) {
      return <HostFileLink target={hostFile}>{children}</HostFileLink>
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-brand-running underline underline-offset-2"
      >
        {children}
      </a>
    )
  },
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-l-2 border-brand-edge pl-3 text-brand-muted">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-brand-edge" />,
  code: ({ children, className }) =>
    className ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded-lg bg-brand-soft px-1 py-px font-mono text-caption">
        {children}
      </code>
    ),
  pre: ({ children }) => {
    if (isValidElement<{ className?: string; children?: unknown }>(children)) {
      const className = children.props.className ?? ''
      if (/\blanguage-mermaid\b/.test(className)) {
        const raw = children.props.children
        const code = Array.isArray(raw) ? raw.join('') : String(raw ?? '')
        return <MermaidBlock code={code} />
      }
    }
    return (
      <pre className="my-2 overflow-x-auto rounded-xl border border-brand-edge bg-brand-deck p-2.5 font-mono text-meta leading-snug">
        {children}
      </pre>
    )
  },
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-xl border border-brand-edge">
      <table className="w-max min-w-full border-collapse text-caption">
        {children}
      </table>
    </div>
  ),
  // the row draws the rule, in the edge colour, none under the last row:
  // Streamdown's own row border has no colour (currentColor, black), and it
  // showed through wherever a cell dropped its border — `last:` on a cell
  // meant the last column, so a black line ran under every last cell
  tr: ({ children }) => (
    <tr className="border-b border-brand-edge [tbody>&:last-child]:border-b-0">
      {children}
    </tr>
  ),
  th: ({ children }) => (
    <th className="bg-brand-deck px-2.5 py-1.5 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="px-2.5 py-1.5 align-top">{children}</td>,
}

/**
 * New text fades in softly, batch by batch (Gemini-like): opacity only — a
 * blur or a lift on every word made the leading edge shimmer — long enough
 * to read as one calm motion, with a tiny stagger so a batch sweeps in from
 * the left, capped so it never trails the text.
 */
const reveal = {
  animation: 'fadeIn',
  duration: 650,
  easing: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
  sep: 'word',
  stagger: 6,
  maxBacklogMs: 260,
} as const

export function ChatMarkdown({
  text,
  streaming = false,
  className,
}: {
  text: string
  streaming?: boolean
  className?: string
}) {
  return (
    <div className={cn('text-body leading-relaxed break-words', className)}>
      <Streamdown
        components={components}
        rehypePlugins={rehypePlugins}
        animated={reveal}
        isAnimating={streaming}
      >
        {text}
      </Streamdown>
    </div>
  )
}
