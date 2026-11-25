// covers: web/src/features/session-split.tsx
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The first paint of a session page (server HTML, before scripts run): on a
// desk the list column is already there beside the conversation — it used
// to paint the phone layout (no list) until hydration swapped in the split
// (a refresh showed the conversation alone, then the list popped in).
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

describe('Session page first paint', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  const paint = async (width: number) => {
    const context = await browser.newContext({
      viewport: { width, height: 800 },
      locale: 'zh-CN',
      javaScriptEnabled: false,
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/sessions/some-session`)
    const state = await page.evaluate(() => {
      const shown = (el: Element | null) =>
        Boolean(el && (el as HTMLElement).offsetWidth > 0)
      return {
        list: shown(
          document.querySelector('[data-testid=session-list-column]'),
        ),
        // the conversation (the pane is display: contents on a phone)
        pane: shown(document.querySelector('[data-testid=session-header]')),
      }
    })
    await context.close()
    return state
  }

  it('desk: the list column paints with the conversation', async () => {
    expect(await paint(1280)).toEqual({ list: true, pane: true })
  })

  it('phone: the conversation alone, no list behind it', async () => {
    expect(await paint(390)).toEqual({ list: false, pane: true })
  })
})
