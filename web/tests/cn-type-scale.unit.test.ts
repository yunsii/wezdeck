import { describe, expect, it } from 'vitest'

import { cn } from '#/lib/utils'

describe('cn knows the type scale', () => {
  it('keeps a token size beside a colour', () => {
    expect(cn('text-meta', 'text-brand-label')).toBe(
      'text-meta text-brand-label',
    )
    expect(cn('text-caption text-brand-muted')).toBe(
      'text-caption text-brand-muted',
    )
  })
  it('a later size still replaces an earlier one', () => {
    expect(cn('text-meta', 'text-body')).toBe('text-body')
  })
})
