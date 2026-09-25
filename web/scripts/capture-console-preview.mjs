import { chromium } from '@playwright/test'

const browserUrl = process.env.WEZDECK_CDP_URL || 'http://127.0.0.1:9222'
const pageUrl =
  process.env.WEZDECK_PREVIEW_URL || 'http://127.0.0.1:3000/console'

const browser = await chromium.connectOverCDP(browserUrl)
const page = await browser.contexts()[0].newPage()

async function removeDevelopmentOverlays() {
  await page.evaluate(() => {
    const fixedElements = [...document.querySelectorAll('body *')].filter(
      (element) => getComputedStyle(element).position === 'fixed',
    )
    for (const element of fixedElements) {
      let root = element
      while (root.parentElement && root.parentElement !== document.body) {
        root = root.parentElement
      }
      root.remove()
    }
  })
}

async function captureTheme(label, outputPath) {
  await page.goto(pageUrl, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: label }).click()
  await page.waitForFunction(() => document.body.innerText.includes('Online'))
  await removeDevelopmentOverlays()
  if (await page.locator('#tanstack_devtools').count()) {
    throw new Error('TanStack Devtools remained in the preview DOM')
  }
  await page.screenshot({ path: outputPath, fullPage: false })
}

try {
  await page.setViewportSize({ width: 1440, height: 920 })
  await captureTheme('Light theme', 'public/console-preview-light.png')
  await captureTheme('Dark theme', 'public/console-preview-dark.png')
  console.log('captured light and dark Runtime Console previews')
} finally {
  await page.close()
  await browser.close()
}
