// covers: web/src/features/session-statusbar.tsx
import { describe, expect, it } from 'vitest'

import { modelName, normalizeMode } from '#/features/session-statusbar'

describe('session statusbar helpers', () => {
  it('formats Claude and Gemini model ids cleanly', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
    expect(modelName('gemini-4-neon-high')).toBe('Gemini 4 Neon (high)')
    expect(modelName('gemini-2.5-pro')).toBe('Gemini 2.5 Pro')
    expect(modelName('')).toBe('')
  })

  it('normalizes execution / auto modes across agents', () => {
    expect(normalizeMode('auto')).toBe('auto')
    expect(normalizeMode('full-access')).toBe('full-access')
    expect(normalizeMode('bypassPermissions')).toBe('full-access')
    expect(normalizeMode('accept-edits')).toBe('accept-edits')
    expect(normalizeMode('acceptEdits')).toBe('accept-edits')
    expect(normalizeMode('plan')).toBe('plan')
    expect(normalizeMode('default')).toBe('default')
    expect(normalizeMode('custom')).toBe('other')
    expect(normalizeMode('')).toBe('')
  })
})
