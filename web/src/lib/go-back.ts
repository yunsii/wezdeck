// Back from a detail page, the forge way (apps/web/src/components/TopBar.tsx
// useGoBack): came from inside the app → history.back(), so the list comes
// back where it was (scroll restoration); opened directly (shared link,
// refresh, PWA cold start, notification) → replace to the fallback, without
// adding a history entry. Never window.history.length: it counts pages from
// before the app and only grows, so "back" could leave the app entirely.
// useCanGoBack reads the router's in-app index kept in each entry's state.
import { useCanGoBack, useRouter } from '@tanstack/react-router'
import type { NavigateOptions } from '@tanstack/react-router'

export function useGoBack(fallback: NavigateOptions) {
  const router = useRouter()
  const canGoBack = useCanGoBack()
  return () => {
    if (canGoBack) router.history.back()
    else void router.navigate({ ...fallback, replace: true })
  }
}
