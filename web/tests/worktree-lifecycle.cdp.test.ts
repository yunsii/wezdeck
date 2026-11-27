// covers: web/src/features/session-worktree-lifecycle.tsx
// covers: web/src/features/session-worktree-actions.ts
// covers: web/src/features/console-interactions-samples.ts
import { chromium } from '@playwright/test'
import { describe, expect, it } from 'vitest'

const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

describe('Worktree lifecycle controls', () => {
  it(
    'requires confirmation and enables actions only for idle workstations',
    { timeout: 45_000 },
    async () => {
      const browser = await chromium.launch()
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        locale: 'zh-CN',
        hasTouch: true,
      })
      try {
        await page.goto(`${base}/zh/console/me/interactions#status-bar`)
        const trigger = page.getByTestId('status-worktrees')
        await trigger.waitFor()
        if (
          !(await trigger.first().isVisible()) ||
          (await trigger.first().getAttribute('inert')) !== null
        )
          await page.getByTestId('statusbar-custom-more').click()
        await trigger.last().click()
        const sheet = page.getByTestId('worktree-manager')
        await sheet
          .getByRole('button', { name: '管理工作树: dev-agent' })
          .click()
        expect(
          await sheet.getByRole('button', { name: '回收工作树' }).isDisabled(),
        ).toBe(true)
        await sheet.getByRole('button', { name: '返回' }).click()
        await sheet
          .getByRole('button', { name: '管理工作树: dev-ready' })
          .click()
        await sheet.getByRole('button', { name: '回收工作树' }).click()
        if (process.env.WEZDECK_VISUAL_SHOTS)
          await page.screenshot({
            path: '/tmp/wezdeck-worktree-recycle-confirm.png',
          })
        await sheet.getByRole('button', { name: '取消' }).waitFor()
        await page.keyboard.press('Escape')
        await sheet.getByRole('button', { name: '回收工作树' }).waitFor()
        await sheet.getByRole('button', { name: '回收工作树' }).click()
        await sheet.getByRole('button', { name: '确认回收' }).click()
        await sheet.getByRole('button', { name: '移除工作树' }).click()
        await sheet.getByRole('button', { name: '确认移除' }).click()
        await sheet.getByTestId('status-worktree-list').waitFor()
        expect(
          await sheet
            .getByRole('button', { name: '管理工作树: dev-ready' })
            .count(),
        ).toBe(0)
      } finally {
        await page.close()
        await browser.close()
      }
    },
  )
})
