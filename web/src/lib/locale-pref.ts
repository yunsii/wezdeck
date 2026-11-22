// The chosen language outlives the URL: the PWA starts at /console/sessions
// (manifest start_url, no locale prefix), so without this a phone switched to
// 中文 reopened in English. A language switch stores a cookie; the Worker
// (locale-redirect.ts, from server.ts) redirects a prefix-less /console request to /zh/… when the
// cookie says zh, or, with no cookie yet, when Accept-Language prefers zh.
export const LOCALE_COOKIE = 'wezdeck-locale'

export function rememberLocale(locale: 'en' | 'zh') {
  if (typeof document === 'undefined') return
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`
}
