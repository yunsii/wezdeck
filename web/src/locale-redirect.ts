// Worker side of lib/locale-pref.ts (no DOM here): a prefix-less /console
// request goes to /zh/… when the wezdeck-locale cookie says zh, or, with no
// cookie yet, when Accept-Language prefers zh.
/** where a prefix-less console request should go, or null */
export function localeRedirect(request: Request): string | null {
  const url = new URL(request.url)
  if (!/^\/console(\/|$)/.test(url.pathname)) return null
  const cookie = /(?:^|;\s*)wezdeck-locale=(en|zh)/.exec(
    request.headers.get('cookie') ?? '',
  )?.[1]
  const wanted =
    cookie ??
    (/^zh\b/i.test(request.headers.get('accept-language') ?? '') ? 'zh' : 'en')
  return wanted === 'zh' ? `/zh${url.pathname}${url.search}` : null
}
