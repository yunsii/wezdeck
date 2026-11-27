import { describe, expect, it } from 'vitest'

import { isHardwareOnlyKey, shouldEnterSend } from '#/features/composer-enter'
import type { EnterSendInput } from '#/features/composer-enter'

const base: EnterSendInput = {
  coarsePrimary: false,
  anyFinePointer: true,
  wide: true,
  sawHardwareKey: false,
  softKeyboardOpen: false,
  key: 'Enter',
  code: 'Enter',
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
  keyCode: 13,
}

describe('composer-enter', () => {
  it('desktop: Enter sends, Shift+Enter breaks line, IME composition does not send', () => {
    expect(shouldEnterSend(base)).toBe(true)
    expect(shouldEnterSend({ ...base, shiftKey: true })).toBe(false)
    expect(shouldEnterSend({ ...base, altKey: true })).toBe(false)
    expect(shouldEnterSend({ ...base, isComposing: true })).toBe(false)
    expect(shouldEnterSend({ ...base, keyCode: 229 })).toBe(false)
  })

  it('tablet with touchpad keyboard (coarse primary + any-pointer fine): Enter sends, Shift+Enter breaks line', () => {
    const tabletTrackpad: EnterSendInput = {
      ...base,
      coarsePrimary: true,
      anyFinePointer: true,
      wide: true,
      // even if OEM Android IME strips event.code
      code: '',
    }
    expect(shouldEnterSend(tabletTrackpad)).toBe(true)
    expect(shouldEnterSend({ ...tabletTrackpad, shiftKey: true })).toBe(false)
  })

  it('tablet with Bluetooth keyboard (no trackpad): Enter sends, Shift+Enter breaks line', () => {
    const tabletBt: EnterSendInput = {
      ...base,
      coarsePrimary: true,
      anyFinePointer: false,
      wide: true,
      code: 'Enter',
      softKeyboardOpen: false,
    }
    expect(shouldEnterSend(tabletBt)).toBe(true)
    expect(shouldEnterSend({ ...tabletBt, shiftKey: true })).toBe(false)
    // once Shift/Arrow/etc. was seen, even an IME stripping code still sends
    expect(
      shouldEnterSend({ ...tabletBt, code: '', sawHardwareKey: true }),
    ).toBe(true)
  })

  it('tablet without hardware keyboard (soft keyboard open or empty code): Enter inserts newline', () => {
    const androidTabletSoft: EnterSendInput = {
      ...base,
      coarsePrimary: true,
      anyFinePointer: false,
      wide: true,
      code: '',
      softKeyboardOpen: false,
    }
    const ipadSoft: EnterSendInput = {
      ...base,
      coarsePrimary: true,
      anyFinePointer: false,
      wide: true,
      code: 'Enter',
      softKeyboardOpen: true,
    }
    expect(shouldEnterSend(androidTabletSoft)).toBe(false)
    expect(shouldEnterSend(ipadSoft)).toBe(false)
    expect(shouldEnterSend({ ...ipadSoft, ctrlKey: true })).toBe(true)
  })

  it('touch phone (narrow, no hardware keyboard): Enter inserts newline, Ctrl+Enter sends', () => {
    const phone: EnterSendInput = {
      ...base,
      coarsePrimary: true,
      anyFinePointer: false,
      wide: false,
      code: 'Enter',
      sawHardwareKey: false,
    }
    expect(shouldEnterSend(phone)).toBe(false)
    expect(shouldEnterSend({ ...phone, ctrlKey: true })).toBe(true)
  })

  it('detects hardware-only keys', () => {
    expect(isHardwareOnlyKey({ code: 'ShiftLeft', key: 'Shift' })).toBe(true)
    expect(isHardwareOnlyKey({ shiftKey: true, key: 'Enter' })).toBe(true)
    expect(isHardwareOnlyKey({ code: 'ArrowUp', key: 'ArrowUp' })).toBe(true)
    expect(isHardwareOnlyKey({ code: 'Enter', key: 'Enter' })).toBe(false)
    expect(isHardwareOnlyKey({ code: '', key: 'a' })).toBe(false)
  })
})
