import { useLingui } from '@lingui/react/macro'
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { copyText } from '#/lib/clipboard'

/** 复制引用: the ticket as a block another agent can act on (reference.py), like a session's */
export function CopyReference({ text }: { text: string }) {
  const { t } = useLingui()
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="key"
      size="sm"
      type="button"
      data-testid="ticket-copy-reference"
      className="ml-auto flex items-center gap-1.5"
      onClick={() => {
        void copyText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1_500)
        })
      }}
    >
      {copied ? (
        <Check size={14} aria-hidden />
      ) : (
        <Copy size={14} aria-hidden />
      )}
      {copied ? t`Copied` : t`Copy reference`}
    </Button>
  )
}
