// 工单's search box: always visible in the compact top bar (matching 会话's
// ChatSearch), with a clear button when text is entered.
import { useLingui } from '@lingui/react/macro'
import { Search, X } from 'lucide-react'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'

export function SearchBox({
  value,
  onChange,
  autoFocus = false,
}: {
  value: string
  onChange: (value: string) => void
  autoFocus?: boolean
}) {
  const { t } = useLingui()
  return (
    <label className="relative min-w-0 flex-1">
      <Search
        size={16}
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-brand-label"
      />
      <Input
        variant="field"
        data-search
        autoFocus={autoFocus}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t`Filter by title, repo or id`}
        aria-label={t`Filter tickets`}
        className="h-9 min-h-9 w-full pl-8 pr-8 text-caption"
      />
      {value ? (
        <Button
          type="button"
          variant="plain"
          size="none"
          aria-label={t`Clear search`}
          onClick={() => onChange('')}
          className="absolute top-1/2 right-1 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-brand-muted"
        >
          <X size={14} aria-hidden />
        </Button>
      ) : null}
    </label>
  )
}
