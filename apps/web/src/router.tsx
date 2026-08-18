import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,

    scrollRestoration: true,
    defaultPreload: 'intent',
    // A zero window made intent preloading self-defeating: hover fetched the
    // route, then click immediately fetched it again. Dashboards own their
    // live refresh cadence, so a short navigation cache is safe.
    defaultPreloadStaleTime: 30_000,
    defaultStaleTime: 15_000,
  })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
