import { describe, expect, it } from 'vitest'

import { uaFallback } from '#/features/device-state'

describe('uaFallback (device names for --devices)', () => {
  it('Firefox on Android reports the real Android version', () => {
    expect(
      uaFallback(
        'Mozilla/5.0 (Android 16; Mobile; rv:162.0) Gecko/162.0 Firefox/162.0',
      ),
    ).toEqual({ browser: 'Firefox 162', os: 'Android 16', mobile: true })
  })
  it('Chrome without hints: the frozen UA still says Chrome', () => {
    expect(
      uaFallback(
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36',
      ),
    ).toEqual({ browser: 'Chrome 157', os: 'Android 10', mobile: true })
  })
  it('Safari on iPhone', () => {
    expect(
      uaFallback(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1',
      ),
    ).toEqual({ browser: 'Safari 19', os: 'iOS 19', mobile: true })
  })
  it('Edge on Windows: its UA carries "Chrome/" first, still Edge', () => {
    expect(
      uaFallback(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0',
      ),
    ).toEqual({
      browser: 'Microsoft Edge 157',
      os: 'Windows 10',
      mobile: false,
    })
  })
})
