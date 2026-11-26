import { describe, expect, it } from 'vitest'

import {
  compactUrl,
  filterRepoLinks,
  groupRepoLinks,
  isSafeExternalUrl,
} from '#/features/repo-links-model'
import type { RepoLink } from '#/features/repo-links-model'

const LINKS: Array<RepoLink> = [
  {
    type: 'local',
    source: 'settings:links.resources',
    url: 'https://wezdeck.yuns.love/console/sessions',
    title: 'Web Console',
    description: 'Remote session deck',
  },
  {
    type: 'detected',
    source: 'detected:github',
    url: 'https://github.com/yunsii/wezterm-config',
    title: 'GitHub Repository',
  },
  {
    type: 'remote-shared',
    source: 'csv:#shared-links',
    url: 'https://docs.example.com/runbook/',
    title: 'Runbook',
  },
  {
    type: 'local',
    source: 'bad',
    url: 'javascript:alert(1)',
    title: 'Unsafe',
  },
  {
    type: 'custom',
    source: 'plugin',
    url: 'http://127.0.0.1:3000/',
    title: 'Local Preview',
  },
]

describe('repo-links-model', () => {
  it('allows only http(s) URLs with a host', () => {
    expect(isSafeExternalUrl('https://github.com/yunsii/wezterm-config')).toBe(
      true,
    )
    expect(isSafeExternalUrl('http://localhost:3000')).toBe(true)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeExternalUrl('not-a-url')).toBe(false)
  })

  it('filters out unsafe URLs and matches title, URL, source and type', () => {
    expect(filterRepoLinks(LINKS, '')).toHaveLength(4)
    expect(filterRepoLinks(LINKS, 'github').map((l) => l.title)).toEqual([
      'GitHub Repository',
    ])
    expect(filterRepoLinks(LINKS, 'runbook').map((l) => l.title)).toEqual([
      'Runbook',
    ])
    expect(filterRepoLinks(LINKS, 'settings:').map((l) => l.title)).toEqual([
      'Web Console',
    ])
    expect(filterRepoLinks(LINKS, 'session deck').map((l) => l.title)).toEqual([
      'Web Console',
    ])
    expect(filterRepoLinks(LINKS, 'unsafe')).toEqual([])
  })

  it('groups links in detected → local → remote-project → remote-shared → other order', () => {
    const safe = filterRepoLinks(LINKS, '')
    const groups = groupRepoLinks(safe)
    expect(groups.map((g) => g.type)).toEqual([
      'detected',
      'local',
      'remote-shared',
      'other',
    ])
    expect(groups[0].items[0].title).toBe('GitHub Repository')
  })

  it('compacts URLs cleanly for display', () => {
    expect(compactUrl('https://github.com/yunsii/wezterm-config/')).toBe(
      'github.com/yunsii/wezterm-config',
    )
    expect(compactUrl('http://localhost:3000///')).toBe('localhost:3000')
  })
})
