import { describe, expect, it } from 'vitest'

import {
  applyCompletion,
  completionEntries,
  completionQuery,
  matchCompletions,
} from '../src/features/skill-complete'

describe('completionQuery', () => {
  it('finds the token at the start or after whitespace', () => {
    expect(completionQuery('/adv', 4, '/')).toEqual({ start: 0, query: 'adv' })
    expect(completionQuery('请 /brain', 8, '/')).toEqual({
      start: 2,
      query: 'brain',
    })
    expect(completionQuery('/', 1, '/')).toEqual({ start: 0, query: '' })
  })
  it('ignores paths, urls and finished tokens', () => {
    expect(completionQuery('src/lib', 7, '/')).toBeNull()
    expect(completionQuery('see https://x/y', 15, '/')).toBeNull()
    expect(completionQuery('/run now', 8, '/')).toBeNull()
  })
  it('only reads up to the caret, and follows the trigger', () => {
    expect(completionQuery('/brainstorm x', 3, '/')).toEqual({
      start: 0,
      query: 'br',
    })
    expect(completionQuery('$img', 4, '$')).toEqual({ start: 0, query: 'img' })
    expect(completionQuery('/img', 4, '$')).toBeNull()
  })
  it('accepts plugin names', () => {
    expect(completionQuery('/anthropic-skills:pd', 20, '/')?.query).toBe(
      'anthropic-skills:pd',
    )
  })
})

describe('matchCompletions', () => {
  const entries = completionEntries(
    {
      trigger: '/',
      skills: [
        { name: 'adversarial-review', origin: 'wezdeck', description: '审查' },
        { name: 'code-review', origin: 'builtin' },
        { name: 'review-helper', origin: 'user' },
        { name: 'brainstorm', origin: 'wezdeck', description: 'ideas, review' },
      ],
    },
    [{ name: 'resume', description: 'pick one' }],
  )
  it('ranks prefix, then word, then substring, then description', () => {
    expect(matchCompletions(entries, 'rev').map((e) => e.name)).toEqual([
      'review-helper',
      'adversarial-review',
      'code-review',
      'brainstorm',
    ])
  })
  it('lists everything (up to the limit) for an empty query', () => {
    expect(matchCompletions(entries, '', 3).map((e) => e.name)).toEqual([
      'resume',
      'adversarial-review',
      'code-review',
    ])
  })
  it('is case-insensitive and matches description text', () => {
    expect(matchCompletions(entries, '审').map((e) => e.name)).toEqual([
      'adversarial-review',
    ])
  })
})

describe('completionEntries', () => {
  it('uses the agent trigger for skills, / for commands', () => {
    const got = completionEntries(
      { trigger: '$', skills: [{ name: 'imagegen', origin: 'builtin' }] },
      [{ name: 'compact', description: 'x' }],
    )
    expect(got.map((e) => [e.insert, e.kind])).toEqual([
      ['/compact', 'command'],
      ['$imagegen', 'builtin'],
    ])
  })
})

describe('applyCompletion', () => {
  it('replaces the token and adds one space', () => {
    expect(applyCompletion('/adv', 0, 4, '/adversarial-review')).toEqual({
      text: '/adversarial-review ',
      caret: 20,
    })
  })
  it('replaces the rest of a word the caret is inside, keeps text after', () => {
    expect(applyCompletion('先 /bra 看看', 2, 6, '/brainstorm')).toEqual({
      text: '先 /brainstorm 看看',
      caret: 14,
    })
    expect(applyCompletion('/brxyz end', 0, 3, '/brainstorm').text).toBe(
      '/brainstorm end',
    )
  })
})
