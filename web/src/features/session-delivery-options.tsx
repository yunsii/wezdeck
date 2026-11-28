import { useLingui } from '@lingui/react/macro'
import {
  Check,
  ChevronRight,
  SendHorizontal,
  Timer,
  UserRoundCheck,
} from 'lucide-react'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'

export type DeliveryPolicy = 'immediate' | 'after_turn' | 'after_review'

export function SessionSendTimingRow({
  value,
  onOpen,
  className,
}: {
  value: DeliveryPolicy
  onOpen: () => void
  className: string
}) {
  const { t } = useLingui()
  const label =
    value === 'immediate'
      ? t`Send now`
      : value === 'after_turn'
        ? t`Send when this turn ends`
        : t`Wait for my confirmation`
  const Icon =
    value === 'immediate'
      ? SendHorizontal
      : value === 'after_turn'
        ? Timer
        : UserRoundCheck
  return (
    <Button
      variant="plain"
      type="button"
      data-testid="send-timing-button"
      onClick={onOpen}
      className={className}
    >
      <Icon size={19} aria-hidden className="shrink-0 text-brand-muted" />
      <span className="min-w-0 flex-1">{t`Send timing`}</span>
      <span className="max-w-[50%] truncate text-meta text-brand-muted">
        {label}
      </span>
      <ChevronRight
        size={16}
        aria-hidden
        className="shrink-0 text-brand-label"
      />
    </Button>
  )
}

export function SessionDeliveryOptions({
  value,
  onChange,
}: {
  value: DeliveryPolicy
  onChange: (policy: DeliveryPolicy) => void
}) {
  const { t } = useLingui()
  const options = [
    { value: 'immediate', label: t`Send now`, icon: SendHorizontal },
    { value: 'after_turn', label: t`Send when this turn ends`, icon: Timer },
    {
      value: 'after_review',
      label: t`Wait for my confirmation`,
      icon: UserRoundCheck,
    },
  ] as const

  return (
    <fieldset aria-label={t`Send timing`} className="grid px-4">
      {options.map((option) => {
        const Icon = option.icon
        const selected = option.value === value
        return (
          <label
            key={option.value}
            className="flex min-h-12 cursor-pointer items-center gap-3 border-b border-brand-edge px-2 text-body text-brand-text last:border-b-0 has-[:focus-visible]:rounded-lg has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-running"
          >
            <Input
              variant="bare"
              type="radio"
              name="session-delivery-policy"
              value={option.value}
              checked={selected}
              onClick={() => {
                if (selected) onChange(option.value)
              }}
              onKeyDown={(event) => {
                if (event.key !== ' ' && event.key !== 'Enter') return
                event.preventDefault()
                onChange(option.value)
              }}
              onChange={() => {
                if (!selected) onChange(option.value)
              }}
              className="sr-only"
            />
            <Icon size={19} aria-hidden className="shrink-0 text-brand-muted" />
            <span className="min-w-0 flex-1 leading-snug break-words">
              {option.label}
            </span>
            {selected ? (
              <Check
                size={18}
                aria-hidden
                className="shrink-0 text-brand-running"
              />
            ) : (
              <span aria-hidden className="size-[18px] shrink-0" />
            )}
          </label>
        )
      })}
    </fieldset>
  )
}
