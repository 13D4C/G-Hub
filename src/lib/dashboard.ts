import { queryOptions } from '@tanstack/react-query'
import { getCreatorDashboard } from '@/server/functions/dashboard'

/**
 * Always the signed-in viewer's own numbers — the server takes no creator argument
 * — so the key needs no viewer id: signing out drops the cache with the session.
 */
export const dashboardQueryOptions = queryOptions({
  queryKey: ['dashboard'],
  queryFn: () => getCreatorDashboard(),
})

/** Thousands separators, `en-US` fixed for the same reason as `formatPrice`. */
export function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}
