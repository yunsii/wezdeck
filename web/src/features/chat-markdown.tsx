// Claude's replies are Markdown: render them for a phone instead of showing
// the raw syntax. Tables and code scroll sideways inside their own box so a
// wide block never widens the page; links open outside the app.
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const components: Components = {
  p: ({ children }) => (
    <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>
  ),
  h1: ({ children }) => (
    <h3 className="mt-3 mb-1 text-[16px] font-bold first:mt-0">{children}</h3>
  ),
  h2: ({ children }) => (
    <h3 className="mt-3 mb-1 text-[16px] font-bold first:mt-0">{children}</h3>
  ),
  h3: ({ children }) => (
    <h4 className="mt-2.5 mb-1 text-[15px] font-semibold first:mt-0">
      {children}
    </h4>
  ),
  h4: ({ children }) => (
    <h4 className="mt-2 mb-1 text-[15px] font-semibold first:mt-0">
      {children}
    </h4>
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
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-brand-running underline underline-offset-2"
    >
      {children}
    </a>
  ),
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
      <code className="rounded-[5px] bg-brand-soft px-1 py-px font-mono text-[13px]">
        {children}
      </code>
    ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-[10px] bg-brand-deck p-2.5 font-mono text-[12px] leading-snug">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-[10px] border border-brand-edge">
      <table className="w-max min-w-full border-collapse text-[13px]">
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-brand-edge bg-brand-deck px-2.5 py-1.5 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-brand-edge px-2.5 py-1.5 align-top last:border-b-0">
      {children}
    </td>
  ),
}

export function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="text-[15px] leading-relaxed break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
