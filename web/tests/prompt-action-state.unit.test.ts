import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import {
  PromptActionStatus,
  promptButtonClass,
} from '#/features/prompt-action-state'

vi.mock('@lingui/react/macro', () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray) => strings.join(''),
  }),
}))

describe('promptButtonClass', () => {
  it('highlights the chosen button and gently dims siblings on submit/cancel waits', () => {
    expect(promptButtonClass(null, 'allow', 'solid')).toBe('')
    const pending = {
      key: 'k',
      action: 'allow',
      phase: 'waiting' as const,
      kind: 'submit' as const,
    }
    expect(promptButtonClass(pending, 'allow', 'solid')).toContain(
      'disabled:opacity-100',
    )
    expect(promptButtonClass(pending, 'allow', 'solid')).toContain('ring-2')
    expect(promptButtonClass(pending, 'deny', 'key')).toBe(
      'disabled:opacity-55',
    )
    expect(
      promptButtonClass(
        { ...pending, action: 'deny', kind: 'cancel' },
        'deny',
        'key',
      ),
    ).toContain('border-brand-running')
  })

  it('keeps sibling buttons full opacity during quick multi-select toggles', () => {
    const toggle = {
      key: 'k',
      action: 'opt-0',
      phase: 'sending' as const,
      kind: 'toggle' as const,
    }
    expect(promptButtonClass(toggle, 'opt-1', 'key')).toBe(
      'disabled:opacity-100',
    )
  })
})

describe('PromptActionStatus', () => {
  it('always renders an invisible sizer in the same grid cell so card height never jumps', () => {
    const idleNoHint = renderToStaticMarkup(
      createElement(PromptActionStatus, { pending: null }),
    )
    expect(idleNoHint).toContain('col-start-1 row-start-1')
    expect(idleNoHint).toContain(
      'Action sent; waiting for the agent to continue…',
    )
    expect(idleNoHint).not.toContain('data-testid="prompt-action-loading"')
    expect(idleNoHint).not.toContain('animate-spin')

    const waiting = renderToStaticMarkup(
      createElement(PromptActionStatus, {
        pending: {
          key: 'k',
          action: 'allow',
          phase: 'waiting',
          kind: 'submit',
        },
        idle: 'Two-line idle hint',
      }),
    )
    expect(waiting).toContain('data-testid="prompt-action-loading"')
    expect(waiting).toContain('data-prompt-loading="waiting"')
    expect(waiting).toContain('Two-line idle hint')
    expect(waiting).toContain('opacity-0')
  })
})
