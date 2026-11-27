import { describe, expect, it } from 'vitest'

import { isSafeToAutoReload } from '#/lib/pwa'

type MockEl = {
  tagName: string
  value?: string
  attrs?: Record<string, string>
  getAttribute: (name: string) => string | null
}

function makeEl(
  tag: string,
  opts: { value?: string; attrs?: Record<string, string> } = {},
): MockEl {
  return {
    tagName: tag.toUpperCase(),
    value: opts.value ?? '',
    attrs: opts.attrs ?? {},
    getAttribute(name: string) {
      return opts.attrs?.[name] ?? null
    },
  }
}

function makeDoc(opts: {
  active?: MockEl | null
  inputs?: Array<MockEl>
  matches?: Record<string, boolean>
}): Document {
  return {
    activeElement: opts.active ?? null,
    querySelectorAll: () => opts.inputs ?? [],
    querySelector: (selector: string) => {
      for (const [key, hit] of Object.entries(opts.matches ?? {})) {
        if (hit && selector.includes(key)) return {}
      }
      return null
    },
  } as unknown as Document
}

describe('isSafeToAutoReload', () => {
  it('allows reload when the page is idle with no drafts, dialogs or prompts', () => {
    expect(isSafeToAutoReload(makeDoc({}))).toBe(true)
  })

  it('blocks reload while an input, textarea, or contenteditable has focus', () => {
    expect(isSafeToAutoReload(makeDoc({ active: makeEl('textarea') }))).toBe(
      false,
    )
    expect(isSafeToAutoReload(makeDoc({ active: makeEl('input') }))).toBe(false)
    expect(
      isSafeToAutoReload(
        makeDoc({
          active: makeEl('div', { attrs: { contenteditable: 'true' } }),
        }),
      ),
    ).toBe(false)
  })

  it('blocks reload when an unfocused composer still has an unsent draft', () => {
    expect(
      isSafeToAutoReload(
        makeDoc({ inputs: [makeEl('textarea', { value: '草稿内容' })] }),
      ),
    ).toBe(false)
  })

  it('blocks reload when a dialog, prompt card, or in-flight send is active', () => {
    expect(
      isSafeToAutoReload(makeDoc({ matches: { '[role="dialog"]': true } })),
    ).toBe(false)
    expect(
      isSafeToAutoReload(
        makeDoc({ matches: { '[data-pending="sending"]': true } }),
      ),
    ).toBe(false)
    expect(
      isSafeToAutoReload(makeDoc({ matches: { 'permission-card': true } })),
    ).toBe(false)
    expect(
      isSafeToAutoReload(makeDoc({ matches: { 'elicitation-card': true } })),
    ).toBe(false)
  })
})
