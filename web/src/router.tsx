import { createRouter as createTanStackRouter } from '@tanstack/react-router'

import { keepTabsFirst } from './lib/go-to-tab'
import { installHostDiag } from './lib/host-diag'
import { transitionTypes } from './lib/view-transition'
import { routeTree } from './route-tree'

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    defaultViewTransition: { types: transitionTypes },
  })
  keepTabsFirst(router)
  installHostDiag(router)

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
