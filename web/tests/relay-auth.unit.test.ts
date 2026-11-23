import { describe, expect, it } from 'vitest'

import { hostAuthorized, safeEqual } from '#/relay/auth'

describe('relay host auth', () => {
  it('an unset host token lets nobody in', () => {
    expect(hostAuthorized('Bearer undefined', undefined)).toBe(false)
    expect(hostAuthorized('Bearer ', '')).toBe(false)
    expect(hostAuthorized('', undefined)).toBe(false)
  })
  it('the right bearer token passes, anything else fails', () => {
    expect(hostAuthorized('Bearer s3cret', 's3cret')).toBe(true)
    expect(hostAuthorized('Bearer s3cres', 's3cret')).toBe(false)
    expect(hostAuthorized('s3cret', 's3cret')).toBe(false)
    expect(hostAuthorized('Basic s3cret', 's3cret')).toBe(false)
  })
  it('safeEqual refuses empty sides', () => {
    expect(safeEqual('', '')).toBe(false)
    expect(safeEqual('a', 'a')).toBe(true)
  })
})
