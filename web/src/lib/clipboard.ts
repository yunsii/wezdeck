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
