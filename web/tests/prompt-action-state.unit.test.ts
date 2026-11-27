import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import {
  PromptActionLabel,
  PromptActionStatus,
} from '#/features/prompt-action-state'

vi.mock('@lingui/react/macro', () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray) => strings.join(''),
  }),
}))

describe('PromptActionLabel', () => {
  it('overlays the spinner in the same grid cell while keeping label width in flow', () => {
    const idle = renderToStaticMarkup(
      createElement(PromptActionLabel, { loading: false, children: 'Allow' }),
    )
    const loading = renderToStaticMarkup(
      createElement(PromptActionLabel, { loading: true, children: 'Allow' }),
    )
    expect(idle).toContain('inline-grid')
    expect(idle).toContain('Allow')
    expect(idle).not.toContain('animate-spin')
    expect(loading).toContain('opacity-0')
    expect(loading).toContain('Allow')
    expect(loading).toContain('animate-spin')
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
