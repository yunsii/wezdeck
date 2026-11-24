// ego-browser script (run by web-frame-probe.sh, which prepends
// `const CFG = {...}`): open the console in an ego task space, sample every
// animation frame in the page and every painted frame (trace screenshots) while it presses
// rows like a person (down, a beat, up). Prints `FRAME <n> <trace ts µs> <base64>`
// lines, one `SAMPLES <json>` line and one `SPACE <id>` line.
// Uses only the ego API (taskSpace / page.cdp / page.events / page.mouse).
const task = CFG.space
  ? await taskSpace(CFG.space)
  : await taskSpace(CFG.spaceName, { profileId: CFG.profile })
console.log('SPACE ' + task.spaceId)
const page = task.page('p1')
await page.cdp('Emulation.setDeviceMetricsOverride', {
  width: CFG.width,
  height: CFG.height,
  deviceScaleFactor: 1,
  mobile: CFG.mobile,
})
await page.goto(CFG.url, { timeout: 30000 })
// a status filter to pick first (tickets: 已结束 lists both targets)
if (CFG.filter) {
  await page.waitForFunction(() => document.querySelector('[role=radio]'), undefined, { timeout: 40000 })
  await page.evaluate((text) => {
    for (const el of document.querySelectorAll('[role=radio]'))
      if (el.textContent?.includes(text)) el.click()
  }, CFG.filter)
}
await page.waitForSelector(`loc=css:${CFG.rowSelector}`, { timeout: 40000 })
await page.waitForTimeout(CFG.settleMs)
// warm every target once (cached is the common case), back to the first
for (const target of CFG.warm) {
  await page.click(`loc=css:${target}`)
  await page.waitForTimeout(CFG.settleMs)
}

await page.evaluate((cfg) => {
  const w = window
  w.__probe = { frames: [], marks: [], vt: 0 }
  const start = document.startViewTransition?.bind(document)
  if (start)
    document.startViewTransition = (arg) => {
      w.__probe.vt += 1
      return start(arg)
    }
  const t0 = performance.now()
  w.__probe.t0 = t0
  const tick = () => {
    const el = document.querySelector(cfg.scroller)
    const row = document.querySelector(cfg.selectedSelector)
    const cs = row ? getComputedStyle(row) : null
    // the row being pressed, before and after it becomes the open one
    const target = w.__probe.target ? document.querySelector(w.__probe.target) : null
    const ts = target ? getComputedStyle(target) : null
    w.__probe.frames.push({
      t: Math.round(performance.now() - t0),
      title: (document.querySelector(cfg.titleSelector)?.textContent ?? '').slice(0, 40),
      scroll: Math.round(el?.scrollTop ?? -1),
      bottom: el ? Math.round(el.scrollHeight - el.clientHeight) : -1,
      sel: row?.getAttribute(cfg.idAttr) ?? '',
      rowBg: cs?.backgroundColor ?? '',
      rowShadow: cs?.boxShadow ?? '',
      tgt: w.__probe.target ?? '',
      targetBg: ts?.backgroundColor ?? '',
      // the row's tint layer (deck.css .list-row::after): its opacity
      targetTint: target ? Number(getComputedStyle(target, '::after').opacity) : -1,
      targetShadow: ts?.boxShadow ?? '',
      sticky: document.querySelector('[data-testid=sticky-prompt]') ? 1 : 0,
      loading: /^(Loading|加载中)/.test(document.querySelector(cfg.titleSelector)?.textContent ?? '') ? 1 : 0,
      vt: w.__probe.vt,
    })
    if (!w.__probe.stop) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}, CFG)

// pixels: the trace's screenshot category records every painted frame and
// needs no per-frame ack (Page.screencastFrameAck takes a sessionId, which
// ego's page.cdp refuses)
await page.events()
await page.cdp('Tracing.start', {
  traceConfig: {
    includedCategories: ['disabled-by-default-devtools.screenshot'],
    recordMode: 'recordAsMuchAsPossible',
  },
  transferMode: 'ReportEvents',
})

for (const target of CFG.presses) {
  const box = await page.evaluate((sel) => {
    const r = document.querySelector(sel)?.getBoundingClientRect()
    return r ? { x: r.x + Math.min(120, r.width / 2), y: r.y + Math.min(20, r.height / 2) } : null
  }, target)
  if (!box) throw new Error('target not on screen: ' + target)
  await page.evaluate((sel) => {
    window.__probe.target = sel
  }, target)
  await page.mouse.move(box.x, box.y)
  await page.waitForTimeout(150)
  await page.evaluate((sel) => {
    const p = window.__probe
    p.marks.push({ t: Math.round(performance.now() - p.t0), target: sel })
    p.target = sel
  }, target)
  await page.mouse.down()
  await page.waitForTimeout(120)
  await page.mouse.up()
  await page.waitForTimeout(CFG.afterMs)
}

await page.cdp('Tracing.end')
let n = 0
for (let round = 0; round < 40; round++) {
  let done = false
  for (const ev of await page.events()) {
    if (ev.method === 'Tracing.tracingComplete') done = true
    if (ev.method !== 'Tracing.dataCollected') continue
    for (const v of ev.params.value)
      if (v.name === 'Screenshot' && v.args?.snapshot)
        console.log(`FRAME ${n++} ${v.ts} ${v.args.snapshot}`)
  }
  if (done) break
  await page.waitForTimeout(250)
}
const samples = await page.evaluate(() => {
  window.__probe.stop = true
  return { frames: window.__probe.frames, marks: window.__probe.marks }
})
await page.cdp('Emulation.clearDeviceMetricsOverride')
console.log('SAMPLES ' + JSON.stringify(samples))
