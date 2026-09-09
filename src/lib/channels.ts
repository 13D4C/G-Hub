import { queryOptions } from '@tanstack/react-query'
import { getChannel } from '@/server/functions/channels'

/**
 * A channel as this viewer sees it. Per-viewer — `subscribed` and every `unlocked`
 * flag depend on who is asking — so the viewer's id belongs in the key, exactly as
 * it does for the interaction summary. Otherwise signing out would leave the
 * previous viewer's unlocked catalogue in the cache.
 */
export const channelKeys = {
  /** Prefix matching every viewer's view of one channel, for mutations to invalidate. */
  detailPrefix: (creatorId: string) => ['channel', creatorId] as const,
  detail: (creatorId: string, viewerId: string | null) =>
    ['channel', creatorId, viewerId ?? 'anon'] as const,
}

export const channelQueryOptions = (creatorId: string, viewerId: string | null) =>
  queryOptions({
    queryKey: channelKeys.detail(creatorId, viewerId),
    queryFn: () => getChannel({ data: { creatorId } }),
  })

/**
 * A channel's monthly fee, formatted identically on the server and in the browser.
 *
 * `Intl.NumberFormat` with an explicit `en-US` locale rather than the viewer's: the
 * default resolves to Node's ICU during SSR and to the browser's after hydration,
 * which is a guaranteed hydration mismatch (see `formatCommentTime`).
 */
export function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100)
}

/** A renewal date, formatted the same way on both sides. */
export function formatPeriodEnd(iso: string): string {
  return iso.slice(0, 10)
}
