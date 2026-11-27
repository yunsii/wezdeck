// Claude's replies and host Markdown documents, rendered with Vercel's
// Streamdown. `variant="chat"` keeps compact bubble typography with streaming
// reveal; `variant="document"` renders spacious long-form Markdown with clear
// heading hierarchy, Shiki code blocks, responsive tables and fit-to-width
// Mermaid diagrams.
import { isValidElement } from 'react'
import { Streamdown, defaultRehypePlugins } from 'streamdown'
import type { Components, StreamdownProps } from 'streamdown'

import { decodeHostFileHash, rehypeHostFileLinks } from '#/lib/host-file-link'
import { cn } from '#/lib/utils'
import { DocCodeBlock } from './doc-code-block'
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

const renderLink: Components['a'] = ({ children, href }) => {
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
}

function extractFenceCode(children: React.ReactNode): {
  lang?: string
  code: string
} | null {
  if (!isValidElement<{ className?: string; children?: unknown }>(children)) {
    return null
  }
  const className = children.props.className ?? ''
  const langMatch = /\blanguage-([a-zA-Z0-9_+-]+)\b/.exec(className)
  const raw = children.props.children
  const code = Array.isArray(raw) ? raw.join('') : String(raw ?? '')
  return { lang: langMatch?.[1], code }
}

const chatComponents: Components = {
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
  a: renderLink,
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
    const fence = extractFenceCode(children)
    if (fence?.lang?.toLowerCase() === 'mermaid') {
      return <MermaidBlock code={fence.code} />
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

const documentComponents: Components = {
  p: ({ children }) => (
    <p className="my-3 leading-7 text-brand-text first:mt-0 last:mb-0">
      {children}
    </p>
  ),
  h1: ({ children }) => (
    <h1
      data-doc-heading
      className="mt-0 mb-5 scroll-mt-4 border-b border-brand-edge pb-3 text-heading font-semibold tracking-tight text-brand-text"
    >
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2
      data-doc-heading
      className="mt-8 mb-3 scroll-mt-4 border-b border-brand-edge/70 pb-1.5 text-title font-semibold text-brand-text first:mt-0"
    >
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3
      data-doc-heading
      className="mt-6 mb-2 scroll-mt-4 text-body font-semibold text-brand-text first:mt-0"
    >
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4
      data-doc-heading
      className="mt-4 mb-1.5 scroll-mt-4 text-caption font-semibold text-brand-muted first:mt-0"
    >
      {children}
    </h4>
  ),
  ul: ({ children }) => (
    <ul className="my-3 list-disc space-y-1.5 pl-5 leading-7">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-3 list-decimal space-y-1.5 pl-5 leading-7">{children}</ol>
  ),
  li: ({ children }) => (
    <li className="pl-1 marker:text-brand-label [&>ol]:my-1.5 [&>p]:my-1 [&>ul]:my-1.5">
      {children}
    </li>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-brand-text">{children}</strong>
  ),
  a: renderLink,
  blockquote: ({ children }) => (
    <blockquote className="my-4 rounded-r-xl border-l-4 border-brand-running/55 bg-brand-deck/80 px-4 py-3 text-caption leading-relaxed text-brand-muted [&>p]:my-1.5 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-7 border-brand-edge" />,
  code: ({ children, className }) =>
    className ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded-md border border-brand-edge/70 bg-brand-deck px-1.5 py-0.5 font-mono text-caption text-brand-text break-words">
        {children}
      </code>
    ),
  pre: ({ children }) => {
    const fence = extractFenceCode(children)
    if (fence?.lang?.toLowerCase() === 'mermaid') {
      return <MermaidBlock code={fence.code} />
    }
    if (fence) {
      return <DocCodeBlock code={fence.code} lang={fence.lang} />
    }
    return (
      <pre className="my-4 min-w-0 max-w-full overflow-x-auto rounded-xl border border-brand-edge bg-brand-deck p-3.5 font-mono text-meta leading-relaxed">
        {children}
      </pre>
    )
  },
  table: ({ children }) => (
    <div className="my-4 w-full min-w-0 max-w-full overflow-x-auto rounded-xl border border-brand-edge bg-brand-surface">
      <table className="w-full min-w-[30rem] border-collapse text-caption leading-relaxed">
        {children}
      </table>
    </div>
  ),
  tr: ({ children }) => (
    <tr className="border-b border-brand-edge transition-colors [tbody>&:hover]:bg-brand-soft/60 [tbody>&:last-child]:border-b-0">
      {children}
    </tr>
  ),
  th: ({ children }) => (
    <th className="bg-brand-deck/90 px-3 py-2 text-left text-meta font-semibold text-brand-muted">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-3 py-2.5 align-top text-brand-text">{children}</td>
  ),
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
  variant = 'chat',
  className,
}: {
  text: string
  streaming?: boolean
  variant?: 'chat' | 'document'
  className?: string
}) {
  const isDoc = variant === 'document'
  return (
    <div
      className={cn(
        'min-w-0 max-w-full text-body break-words',
        isDoc ? 'leading-7' : 'leading-relaxed',
        className,
      )}
    >
      <Streamdown
        components={isDoc ? documentComponents : chatComponents}
        rehypePlugins={rehypePlugins}
        animated={isDoc ? false : reveal}
        isAnimating={isDoc ? false : streaming}
      >
        {text}
      </Streamdown>
    </div>
  )
}
