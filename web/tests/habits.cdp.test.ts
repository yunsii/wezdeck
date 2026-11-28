// covers: web/src/features/me-habits.tsx web/src/features/me-schedule.tsx
// covers: native/wezdeck-wsl/habit_report.go native/wezdeck-wsl/habit_schedule.go
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const stack = process.env.WEZDECK_TEST_STACK_DIR || ''
const devicesFile = process.env.WEZDECK_TEST_DEVICES || ''
const habitDir = process.env.WEZDECK_TEST_HABIT_DIR || ''
const screenshotDir = process.env.WEZDECK_HABIT_SCREENSHOT_DIR || ''
const repo = join(import.meta.dirname, '..', '..')

function sample(period: string) {
  return {
    report: {
      generated_at: '2026-11-28T01:00:00Z',
      window: {
        start:
          period === 'last'
            ? '2026-11-16'
            : period === '14d'
              ? '2026-11-15'
              : '2026-11-23',
        end: period === 'last' ? '2026-11-22' : '2026-11-28',
      },
      work_focus: {
        ok: true,
        commits: 10,
        web_related: 8,
        areas: { web: 8, relay: 2, docs: 1 },
        daily: [{ day: '2026-11-28', commits: 10, web_related: 8 }],
      },
      concurrency: { max_running: 3 },
      agents: {
        verify: { cdp_calls: 4, iterate_after_cdp: 2 },
        session: { active_minutes_p50: 15, user_turns: 22 },
      },
      hotkeys: { total_hotkey_presses: 0, daily: [] },
      wakatime: { ok: true, totals: { text: '4h 20m' } },
    },
    markdown: '# 开发习惯周报\n\n## 工作重心\n\nWeb 相关提交 8/10。',
  }
}

describe.runIf(stack && devicesFile && habitDir)(
  'Development habits and schedule',
  () => {
    let browser: Browser

    beforeAll(async () => {
      if (screenshotDir) mkdirSync(screenshotDir, { recursive: true })
      rmSync(
        join(
          stack,
          'systemd-user',
          'wezdeck-habit-snapshot.timer.d',
          'schedule.conf',
        ),
        { force: true },
      )
      rmSync(join(stack, 'habit-refresh.log'), { force: true })
      writeFileSync(join(stack, 'habit-enabled'), '')
      mkdirSync(habitDir, { recursive: true })
      for (const period of ['this', 'last', '14d'])
        writeFileSync(
          join(habitDir, period + '.json'),
          JSON.stringify(sample(period)),
        )
      writeFileSync(devicesFile, JSON.stringify({ approved: [], pending: [] }))
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser.close()
    })

    it('shows reports and manages only the isolated habit timer', async () => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        locale: 'zh-CN',
      })
      const page = await context.newPage()
      await page.goto(base + '/zh/console/me/writing?remote=1#pair=' + token)
      await page.locator('main[data-remote-mode]').waitFor({ timeout: 20_000 })
      await page.getByRole('button', { name: '申请授权' }).click()
      const command = page.locator('code', { hasText: '--approve' })
      await command.waitFor({ timeout: 20_000 })
      const id = ((await command.textContent()) ?? '').trim().split(' ').at(-1)
      execFileSync(
        join(repo, 'scripts/dev/install-remote-relay.sh'),
        ['--approve', id ?? ''],
        {
          env: { ...process.env, WEZDECK_REMOTE_DEVICES: devicesFile },
        },
      )
      await page.getByRole('button', { name: '重新检查' }).click()
      await page.getByText(/^已获批。/).waitFor({ timeout: 15_000 })

      await page.goto(base + '/zh/console/me/habits?remote=1#pair=' + token)
      await page.getByTestId('habit-overview').waitFor({ timeout: 20_000 })
      if (screenshotDir)
        await page.screenshot({
          path: join(screenshotDir, 'habits-desktop.png'),
          fullPage: true,
        })
      expect(await page.getByText('80%').count()).toBeGreaterThan(0)
      await page.getByRole('radio', { name: '上周' }).click()
      await expect
        .poll(() => page.getByTestId('habit-page').textContent())
        .toContain('2026-11-16')
      expect(
        await page.getByRole('button', { name: '刷新' }).isDisabled(),
      ).toBe(true)
      await page.getByRole('radio', { name: '近 14 天' }).click()
      await expect
        .poll(() => page.getByTestId('habit-page').textContent())
        .toContain('2026-11-15')
      await page.getByRole('radio', { name: '完整报告' }).click()
      await page.getByText('Web 相关提交 8/10。').waitFor({ timeout: 10_000 })

      await page.goto(base + '/zh/console/me/schedule?remote=1#pair=' + token)
      await page.getByTestId('habit-schedule').waitFor({ timeout: 20_000 })
      if (screenshotDir)
        await page.screenshot({
          path: join(screenshotDir, 'schedule-desktop.png'),
          fullPage: true,
        })
      await page.getByLabel('午间').fill('13:15')
      await page.getByRole('button', { name: '保存时间' }).click()
      await expect
        .poll(() =>
          readFileSync(
            join(
              stack,
              'systemd-user',
              'wezdeck-habit-snapshot.timer.d',
              'schedule.conf',
            ),
            'utf8',
          ),
        )
        .toContain('13:15:00 Asia/Singapore')
      await page.getByRole('button', { name: '立即生成报告' }).click()
      await expect
        .poll(() => readFileSync(join(stack, 'habit-refresh.log'), 'utf8'))
        .toContain('started')
      await page.getByRole('checkbox').click()
      await expect
        .poll(() => existsSync(join(stack, 'habit-enabled')))
        .toBe(false)

      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(base + '/zh/console/me/habits?remote=1#pair=' + token)
      await page.getByTestId('habit-overview').waitFor({ timeout: 20_000 })
      if (screenshotDir)
        await page.screenshot({
          path: join(screenshotDir, 'habits-mobile.png'),
          fullPage: true,
        })
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true)
      await context.close()
    }, 90_000)
  },
)
