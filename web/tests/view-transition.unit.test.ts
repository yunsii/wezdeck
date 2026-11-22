import { describe, expect, it } from 'vitest'

import {
  isFirstLevel,
  routeRank,
  transitionTypes,
} from '../src/lib/view-transition'

const nav = (
  from: string | undefined,
  to: string,
  pathChanged = from !== to,
) => ({
  fromLocation: from ? { pathname: from } : undefined,
  toLocation: { pathname: to },
  pathChanged,
})
const navAt = (
  from: string,
  fromIndex: number,
  to: string,
  toIndex: number,
) => ({
  fromLocation: { pathname: from, state: { __TSR_index: fromIndex } },
  toLocation: { pathname: to, state: { __TSR_index: toIndex } },
  pathChanged: from !== to,
})

describe('page levels', () => {
  it('sections are first level with or without the locale prefix', () => {
    for (const p of [
      '/console',
      '/console/',
      '/zh/console/now',
      '/console/sessions',
      '/zh/console/me',
      '/console/collab',
    ])
      expect(isFirstLevel(p)).toBe(true)
    for (const p of [
      '/console/sessions/abc',
      '/zh/console/collab/req-1',
      '/',
      '/zh',
    ])
      expect(isFirstLevel(p)).toBe(false)
  })
  it('phone tabs rank left to right: now, tickets, sessions, me', () => {
    expect(routeRank('/zh/console/now')).toBeLessThan(
      routeRank('/zh/console/collab'),
    )
    expect(routeRank('/console/collab')).toBeLessThan(
      routeRank('/console/sessions'),
    )
    expect(routeRank('/console/sessions')).toBeLessThan(
      routeRank('/console/me'),
    )
  })
})

describe('transition direction', () => {
  it('into a detail is forward, out of it back', () => {
    expect(
      transitionTypes(nav('/zh/console/sessions', '/zh/console/sessions/s1')),
    ).toEqual(['forward'])
    expect(
      transitionTypes(nav('/zh/console/sessions/s1', '/zh/console/sessions')),
    ).toEqual(['back'])
  })
  it('between tabs follows the tab order and keeps the tab bar', () => {
    expect(
      transitionTypes(nav('/zh/console/now', '/zh/console/sessions')),
    ).toEqual(['forward', 'tabs'])
    expect(transitionTypes(nav('/zh/console/me', '/zh/console/now'))).toEqual([
      'back',
      'tabs',
    ])
  })
  it('the history position wins over depth', () => {
    expect(
      transitionTypes(navAt('/console/sessions/s1', 1, '/console/now', 0)),
    ).toEqual(['back'])
    expect(transitionTypes(navAt('/console/me', 0, '/console/now', 0))).toEqual(
      ['back', 'tabs'],
    )
  })
  it('same depth fades; first load, search-only and leaving the console do not animate', () => {
    expect(
      transitionTypes(nav('/console/sessions/a', '/console/sessions/b')),
    ).toEqual(['fade'])
    expect(transitionTypes(nav('/console/now', '/console/now', false))).toBe(
      false,
    )
    expect(transitionTypes(nav(undefined, '/console/now'))).toBe(false)
    expect(transitionTypes(nav('/zh', '/zh/console/now'))).toBe(false)
  })
})
