// covers: web/src/features/ticket-proposals.tsx web/src/features/console-collab.tsx
// covers: native/wezdeck-wsl/remote_writes.go skills/agent-collab/lib/split.py
// covers: skills/agent-collab/lib/api.py
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// 拆分提案 on a parent ticket (skills/agent-collab/lib/split.py): the card,
// keyboard reject (Esc cancels, Ctrl+Enter sends), and 确认并开始 creating
// the children and starting the scheduler — whose dispatches the stack
// fakes (TICKET_COLLAB_RUN_CMD → fake-ticket-run), so no agent ever runs.
// Writes only the stack's copy of the ticket store.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const devicesFile = process.env.WEZDECK_TEST_DEVICES ?? ''
const stack = process.env.WEZDECK_TEST_STACK_DIR ?? ''
const repoRoot = join(import.meta.dirname, '..', '..')
const runSh = join(repoRoot, 'skills/agent-collab/run.sh')

const env = () => ({ ...process.env, TICKETS_ROOT: join(stack, 'tickets') })
const ticket = (args: Array<string>) =>
  JSON.parse(
    execFileSync(runSh, args, { env: env() })
      .toString()
      .trim()
      .split('\n')
      .at(-1) ?? '{}',
  ) as Record<string, unknown>
const target = () =>
  [
    ...readFileSync(join(stack, 'tickets', 'config.yml'), 'utf8').matchAll(
      /^ {2}([A-Za-z0-9_-]+):\s*$/gm,
    ),
  ].map((m) => m[1])[0]
const data = (id: string, file: string) =>
  join(stack, 'tickets', '_data', id, file)

/** a parent waiting in plan_review on draft p1 with two children */
const seedDraft = (title: string) => {
  const to = target()
  const contract = join(stack, `contract-${Date.now()}.md`)
  writeFileSync(contract, '# Contract\n\n- shared: `fmt()` lives in a/\n')
  const pid = String(
    ticket([
      'fanout',
      'plan',
      '--from',
      to,
      '--title',
      title,
      '--contract',
      contract,
    ]).id,
  )
  const items = [
    {
      key: 'a',
      to,
      title: '拆分甲：实现 fmt',
      effect: '做完后全站都能调用统一的格式化',
      observed: 'o',
      assumed: 'fmt() exists',
      scope: ['src/a/**'],
      depends_on: [],
    },
    {
      key: 'b',
      to,
      title: '拆分乙：接入 fmt',
      effect: '做完后 b 页面的数字格式一致',
      observed: 'o',
      assumed: 'b uses fmt',
      scope: ['src/b/**'],
      depends_on: ['a'],
    },
  ]
  writeFileSync(
    data(pid, 'proposals.json'),
    JSON.stringify([
      {
        id: 'p1',
        origin: 'draft',
        status: 'pending',
        items,
        warnings: [],
        created_at: '2026-11-25T00:00:00Z',
        summary: {
          problem: '各页面数字格式各写各的，经常不一致',
          approach: '先做统一的格式化，再让 b 页面接入',
        },
        status_check: [
          {
            item: '统一格式化',
            status: 'missing',
            evidence: 'src/a/ 无 fmt',
          },
          {
            item: '千分位',
            status: 'partial',
            evidence: 'src/num.ts:12',
            reuse: 'num.ts 的 group()',
          },
        ],
        risks: ['可能需要改全局配置'],
        outcome: {
          workers: 2,
          max_parallel: 1,
          stages: 2,
          mem_peak_mb: 3941,
          minutes_each: [22, 48],
          delivery: { [to]: `ticket/${pid}-integration` },
          pushes: false,
        },
      },
    ]),
  )
  ticket([
    'set-status',
    '--id',
    pid,
    '--status',
    'waiting_initiator',
    '--owner',
    'human',
    '--phase',
    'plan_review',
  ])
  return pid
}

const approveDevice = async (page: Page) => {
  await page.goto(`${base}/zh/console/me/writing?remote=1#pair=${token}`)
  await page
    .locator('[data-testid=remote-badge-compact], [data-testid=remote-badge]')
    .first()
    .waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: '申请授权' }).click()
  const command = page.locator('code', { hasText: '--approve' })
  await command.waitFor({ timeout: 20_000 })
  const id = ((await command.textContent()) ?? '').trim().split(' ').at(-1)
  execFileSync(
    join(repoRoot, 'scripts/dev/install-remote-relay.sh'),
    ['--approve', id ?? ''],
    {
      env: { ...process.env, WEZDECK_REMOTE_DEVICES: devicesFile },
    },
  )
  await page.getByRole('button', { name: '重新检查' }).click()
  await page.getByText(/^已获批。/).waitFor({ timeout: 15_000 })
}

describe.runIf(devicesFile && stack)('Split proposals on a parent', () => {
  let browser: Browser
  beforeAll(async () => {
    writeFileSync(devicesFile, JSON.stringify({ approved: [], pending: [] }))
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  it('shows the draft, rejects by keyboard, confirms and starts', async () => {
    if (!target()) return // a store without targets: nothing to seed
    const rejectMe = seedDraft('提案驳回')
    const confirmMe = seedDraft('提案确认')
    const context = await browser.newContext({
      locale: 'zh-CN',
      viewport: { width: 1280, height: 900 },
    })
    const page = await context.newPage()
    await approveDevice(page)

    // the card: heading, the four parts, contract one tap away, each child with its scope and order
    await page.goto(`${base}/zh/console/collab/${rejectMe}`)
    const card = page.getByRole('region', { name: '拆分提案 p1' })
    await card.waitFor({ timeout: 20_000 })
    await expect
      .poll(() => card.getByRole('heading', { level: 2 }).textContent())
      .toBe('拆分方案：2 张子单')
    // no money anywhere on the card (the user does not want quota estimates)
    expect(await card.getByText(/\$/).count()).toBe(0)
    // the four parts an approver reads, in order (skills/agent-collab SKILL.md)
    expect(
      await card.getByRole('heading', { level: 3 }).allTextContents(),
    ).toEqual(['要解决什么', '现状核对', '打算怎么做', '确认后会发生什么'])
    expect(await card.getByText('各页面数字格式各写各的').count()).toBe(1)
    expect(await card.getByText('部分实现 · 千分位').count()).toBe(1)
    expect(await card.getByText('复用 num.ts 的 group()').count()).toBe(1)
    expect(await card.getByText('做完后 b 页面的数字格式一致').count()).toBe(1)
    expect(
      await card.getByText('起 2 个后台工人，最多同时 1 个，分 2 批').count(),
    ).toBe(1)
    expect(
      await card.getByText(/每个约 22–48 分钟，内存峰值约 3\.8 GB/).count(),
    ).toBe(1)
    expect(await card.getByText(/不推送、不提 MR/).count()).toBe(1)
    expect(
      await card.getByText('可能停下来问你： 可能需要改全局配置').count(),
    ).toBe(1)
    expect(await card.getByText('确认之前不会建任何单。').count()).toBe(1)
    expect(await card.getByText('拆分乙：接入 fmt').count()).toBe(1)
    expect(
      await card.getByText(/src\/b\/\*\* · 依赖 拆分甲：实现 fmt/).count(),
    ).toBe(1)
    await card.getByRole('button', { name: '技术细节' }).click()
    await card.getByText(/fmt\(\)` lives in a\//).waitFor()
    // a parked parent answers here, not with the free-text reply box
    expect(await page.getByLabel('你的回复').count()).toBe(0)

    // reject: Esc backs out, Ctrl+Enter sends the reason
    await card.getByRole('button', { name: '驳回…' }).click()
    const reason = card.getByLabel('驳回理由')
    await expect
      .poll(() => reason.evaluate((el) => el === document.activeElement))
      .toBe(true)
    await page.keyboard.press('Escape')
    expect(await reason.count()).toBe(0)
    await card.getByRole('button', { name: '驳回…' }).click()
    await reason.fill('按层拆，不按模块')
    await page.keyboard.press('Control+Enter')
    await card.waitFor({ state: 'detached', timeout: 20_000 })
    const rejected = JSON.parse(
      readFileSync(data(rejectMe, 'proposals.json'), 'utf8'),
    ) as Array<{ status: string; reason: string }>
    expect(rejected[0]).toMatchObject({
      status: 'rejected',
      reason: '按层拆，不按模块',
    })
    expect(readFileSync(data(rejectMe, 'ticket.md'), 'utf8')).toMatch(
      /phase: plan_rejected/,
    )

    // confirm: children exist, the scheduler started and dispatched (faked)
    await page.goto(`${base}/zh/console/collab/${confirmMe}`)
    const card2 = page.getByRole('region', { name: '拆分提案 p1' })
    await card2.waitFor({ timeout: 20_000 })
    await card2.getByRole('button', { name: '确认并开始' }).click()
    await card2.waitFor({ state: 'detached', timeout: 30_000 })
    const props = JSON.parse(
      readFileSync(data(confirmMe, 'proposals.json'), 'utf8'),
    ) as Array<{ status: string; created: Record<string, string> }>
    expect(props[0].status).toBe('approved')
    const first = props[0].created.a
    expect(
      JSON.parse(readFileSync(data(props[0].created.b, 'meta.json'), 'utf8'))
        .depends_on,
    ).toEqual([first])
    // the children table shows them on the same page
    await page
      .getByRole('table', { name: '子单' })
      .getByText('拆分甲：实现 fmt')
      // its own row, and 乙's 依赖 column names it too
      .first()
      .waitFor({ timeout: 20_000 })
    const runs = join(stack, 'ticket-runs')
    await expect
      .poll(() => (existsSync(runs) ? readFileSync(runs, 'utf8') : ''), {
        timeout: 30_000,
      })
      .toContain(first)
    await context.close()
  }, 60_000)
})
