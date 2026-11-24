/** Copy text; falls back to a hidden textarea where the async API is denied. */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.style.cssText = 'position:fixed;opacity:0'
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
}

/**
 * Copy text that is still being fetched. Safari and Firefox drop the click's
 * user activation across an await, so a later writeText is refused; a
 * ClipboardItem takes the promise and keeps the gesture. Rejects when the
 * text does.
 */
export async function copyTextLater(text: Promise<string>) {
  try {
    // no navigator.clipboard off a secure origin: the try covers that too
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': text.then((v) => new Blob([v], { type: 'text/plain' })),
      }),
    ])
    return
  } catch {
    // older engines without ClipboardItem promises, or the fetch's own
    // error (rethrown by the await below)
  }
  await copyText(await text)
}
