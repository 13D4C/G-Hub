import { queryOptions } from '@tanstack/react-query'
import { getBillingStatus } from '@/server/functions/billing'

/**
 * The viewer's plan, shared by the billing page and the header link.
 *
 * Per-viewer, so signing out must not leave the previous viewer's status in the
 * cache — `AuthNav` already invalidates on sign-out, and this key is listed there.
 */
export const billingStatusQueryOptions = queryOptions({
  queryKey: ['billing', 'status'],
  queryFn: () => getBillingStatus(),
  staleTime: 60_000,
})

/** A renewal date, formatted identically on the server and in the browser (see `formatCommentTime`). */
export function formatPeriodEnd(iso: string): string {
  return iso.slice(0, 10)
}
