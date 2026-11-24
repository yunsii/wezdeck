// A sent message's phone attachments (the host's note, remote_upload.go):
// what was typed, with each [图片N] as a chip that opens that picture, and
// the thumbnails below, each labelled 图片N to match.
import { ImageIcon } from 'lucide-react'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { ImageStrip } from './chat-images'

/**
 * First line of the note the host appends for attachments sent from the web
 * console (remote_upload.go): "[网页附件]"; older transcripts have
 * "[手机附件]", read the same.
 */
const ATTACHMENT_MARKS = ['[网页附件]', '[手机附件]']

/** where the host's attachment note starts in a sent message, if any */
export function noteAt(text: string) {
  for (const mark of ATTACHMENT_MARKS) {
    const at = text.indexOf(mark)
    if (at >= 0) return { at, mark }
  }
  return null
}

/** the message is the typed text (if any) followed by an attachment note */
export const endsWithNote = (text: string, typed: string) => {
  const note = noteAt(text)
  if (!note) return false
  return typed ? text.slice(0, note.at) === `${typed}\n\n` : note.at === 0
}

/** What the user typed, without the host's attachment note. */
export const typedText = (text: string) => splitAttachments(text).typed

/** Split a sent message into what was typed and its attachment lines. */
function splitAttachments(text: string) {
  const note = noteAt(text)
  if (!note) return { typed: text, files: [] }
  const { at, mark } = note
  const files = text
    .slice(at + mark.length)
    .split('\n')
    .map((line) => line.replace(/^- /, '').trim())
    .filter(Boolean)
    .map((line) => {
      const [label = '', path = ''] = line.split(/:\s+/, 2)
      return { label, name: path.split('/').at(-1) ?? path }
    })
  return { typed: text.slice(0, at).trim(), files }
}

const isPhoneImage = (name: string) =>
  /^img-.*\.(jpe?g|png|gif|webp)$/i.test(name)

/**
 * The typed text cut at its [图片N] tokens: strings, and { label, index }
 * for a token whose image was sent (index into the thumbnails). A token
 * with no such image stays text.
 */
export function splitTokens(text: string, labels: Array<string>) {
  return text
    .split(/(\[图片\d+\])/)
    .filter(Boolean)
    .map((part) => {
      const label = /^\[(图片\d+)\]$/.exec(part)?.[1]
      const index = label ? labels.indexOf(label) : -1
      return label && index >= 0 ? { label, index } : part
    })
}

/** the typed text with [图片N] as chips; a tap opens image N */
function TypedWithTokens({
  text,
  labels,
  onOpen,
}: {
  text: string
  labels: Array<string>
  onOpen: (index: number) => void
}) {
  return (
    <>
      {splitTokens(text, labels).map((part, i) => {
        if (typeof part === 'string') return part
        const { label, index } = part
        return (
          <Button
            key={i}
            variant="plain"
            size="none"
            type="button"
            onClick={() => onOpen(index)}
            className="mx-0.5 inline-flex items-center gap-1 rounded-md bg-brand-deck/20 px-1.5 align-baseline text-meta"
          >
            <ImageIcon size={12} aria-hidden />
            {label}
          </Button>
        )
      })}
    </>
  )
}

export function SentAttachments({ text }: { text: string }) {
  const { typed, files } = splitAttachments(text)
  const images = files.filter((file) => isPhoneImage(file.name))
  const others = files.filter((file) => !isPhoneImage(file.name))
  const [open, setOpen] = useState<number | null>(null)
  const labels = images.map((file) => file.label)
  return (
    <>
      <TypedWithTokens text={typed} labels={labels} onOpen={setOpen} />
      <ImageStrip
        sources={images.map((file) => ({ kind: 'upload', name: file.name }))}
        labels={labels}
        open={open}
        onOpenChange={setOpen}
      />
      {others.length ? (
        <span className="mt-1.5 flex flex-wrap gap-1">
          {others.map((file) => (
            <span
              key={file.name}
              title={file.name}
              className="rounded-full bg-brand-deck/15 px-2 py-0.5 text-meta"
            >
              {file.label}
            </span>
          ))}
        </span>
      ) : null}
    </>
  )
}
