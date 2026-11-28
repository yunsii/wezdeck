import { describe, expect, it } from 'vitest'

import {
  detectSoftKeyboardOpen,
  isHardwareOnlyKey,
  resolveEnterKeyHint,
  shouldEnterSend,
} from '#/features/composer-enter'
import type { EnterSendInput } from '#/features/composer-enter'
import { parseEnterMode } from '#/lib/enter-pref'

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

  it('tablet with touchpad keyboard (coarse primary + any-pointer fine): Enter sends unless soft keyboard is open', () => {
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
    // When soft keyboard is open on a tablet (e.g. stylus or folded cover),
    // Enter must insert a newline instead of sending.
    expect(shouldEnterSend({ ...tabletTrackpad, softKeyboardOpen: true })).toBe(
      false,
    )
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

  it('touch phone (narrow): Enter always inserts newline even with virtual fine pointer or soft-kb signals', () => {
    const phone: EnterSendInput = {
      ...base,
      coarsePrimary: true,
      anyFinePointer: false,
      wide: false,
      code: 'Enter',
      sawHardwareKey: false,
    }
    expect(shouldEnterSend(phone)).toBe(false)
    // Phone with virtual pointer (e.g. OPPO 互联 / stylus / OEM any-hover)
    expect(shouldEnterSend({ ...phone, anyFinePointer: true })).toBe(false)
    // Phone with floating soft keyboard or previously seen modifier
    expect(shouldEnterSend({ ...phone, sawHardwareKey: true })).toBe(false)
    expect(shouldEnterSend({ ...phone, ctrlKey: true })).toBe(true)
  })

  it('detects hardware-only keys without false positives from mobile soft keyboards', () => {
    expect(isHardwareOnlyKey({ code: 'ShiftLeft', key: 'Shift' })).toBe(true)
    expect(isHardwareOnlyKey({ shiftKey: true, key: 'Enter' })).toBe(true)
    expect(isHardwareOnlyKey({ code: 'ArrowUp', key: 'ArrowUp' })).toBe(true)
    expect(isHardwareOnlyKey({ code: 'Enter', key: 'Enter' })).toBe(false)
    expect(isHardwareOnlyKey({ code: '', key: 'a' })).toBe(false)
    // Soft keyboards emit shiftKey / key:'Shift' / Arrow without physical codes
    expect(isHardwareOnlyKey({ shiftKey: true, key: '?', code: '' })).toBe(
      false,
    )
    expect(isHardwareOnlyKey({ shiftKey: true, key: 'A', code: '' })).toBe(
      false,
    )
    expect(isHardwareOnlyKey({ key: 'Shift', code: '' })).toBe(false)
    expect(isHardwareOnlyKey({ key: 'ArrowLeft', code: '' })).toBe(false)
  })

  it('detectSoftKeyboardOpen catches both resizes-visual (iOS) and resizes-content (Android PWA)', () => {
    // Android Chrome / PWA (`interactive-widget=resizes-content`): innerHeight
    // and visualViewport.height shrink together from 714 → 431.
    expect(
      detectSoftKeyboardOpen({
        innerHeight: 431,
        vvHeight: 431,
        baselineHeight: 714,
      }),
    ).toBe(true)
    expect(
      detectSoftKeyboardOpen({
        innerHeight: 714,
        vvHeight: 714,
        baselineHeight: 714,
      }),
    ).toBe(false)
    // iOS Safari (`resizes-visual`): visualViewport shrinks below innerHeight.
    expect(
      detectSoftKeyboardOpen({
        innerHeight: 844,
        vvHeight: 520,
        baselineHeight: 844,
      }),
    ).toBe(true)
    // VirtualKeyboard API
    expect(
      detectSoftKeyboardOpen({
        vkHeight: 280,
        innerHeight: 714,
        vvHeight: 714,
        baselineHeight: 714,
      }),
    ).toBe(true)
  })

  it('per-device enter preference overrides plain Enter while preserving Shift/Ctrl/IME invariants', () => {
    const phone: EnterSendInput = {
      ...base,
      coarsePrimary: true,
      anyFinePointer: false,
      wide: false,
      softKeyboardOpen: true,
    }
    // mode='send': phone with a physical keyboard sends on plain Enter,
    // while Shift+Enter still breaks lines and IME composition never sends.
    expect(shouldEnterSend({ ...phone, mode: 'send' })).toBe(true)
    expect(shouldEnterSend({ ...phone, mode: 'send', shiftKey: true })).toBe(
      false,
    )
    expect(shouldEnterSend({ ...phone, mode: 'send', isComposing: true })).toBe(
      false,
    )
    // mode='newline': even desktop inserts a newline on plain Enter, while
    // Ctrl/⌘+Enter still sends.
    expect(shouldEnterSend({ ...base, mode: 'newline' })).toBe(false)
    expect(shouldEnterSend({ ...base, mode: 'newline', ctrlKey: true })).toBe(
      true,
    )
    expect(
      resolveEnterKeyHint({
        mode: 'send',
        coarsePrimary: true,
        anyFinePointer: false,
        wide: false,
        sawHardwareKey: false,
      }),
    ).toBe('send')
    expect(
      resolveEnterKeyHint({
        mode: 'newline',
        coarsePrimary: false,
        anyFinePointer: true,
        wide: true,
        sawHardwareKey: false,
      }),
    ).toBe('enter')
    expect(parseEnterMode('send')).toBe('send')
    expect(parseEnterMode('newline')).toBe('newline')
    expect(parseEnterMode('garbage')).toBe('auto')
    expect(parseEnterMode(null)).toBe('auto')
  })
})
