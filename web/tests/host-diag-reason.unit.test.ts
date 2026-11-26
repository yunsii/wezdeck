// covers: web/src/lib/host-diag.ts (toast copy + reason clip)
import { describe, expect, it } from 'vitest'

import { clipDiagReason, diagToastMessage } from '#/lib/host-diag'

describe('clipDiagReason', () => {
  it('trims, collapses spaces, and caps length', () => {
    expect(clipDiagReason('  发布网页  abc  ')).toBe('发布网页 abc')
    expect(clipDiagReason('x'.repeat(200)).length).toBe(120)
    expect(clipDiagReason(undefined)).toBe('')
  })
})

describe('diagToastMessage', () => {
  it('appends reason for diag snapshot and steps', () => {
    expect(diagToastMessage(true, 0, '', 'diag')).toBe(
      '已读取这个页面的诊断信息',
    )
    expect(diagToastMessage(true, 0, '核对设备 abc', 'diag')).toBe(
      '已读取这个页面的诊断信息 · 核对设备 abc',
    )
    expect(diagToastMessage(true, 2, '复现列表跳动', 'diag')).toBe(
      '调试中：正在这个页面复现问题（2 步） · 复现列表跳动',
    )
  })

  it('names a reload and keeps the reason for the post-reload toast', () => {
    expect(diagToastMessage(true, 1, '发布网页 e009ca40', 'reload')).toBe(
      '即将刷新到新版本 · 发布网页 e009ca40',
    )
    expect(diagToastMessage(false, 1, 'release-web e009ca40', 'reload')).toBe(
      'Reloading onto the new build · release-web e009ca40',
    )
  })
})
