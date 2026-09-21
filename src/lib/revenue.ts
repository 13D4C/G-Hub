import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { Heart, Megaphone, Ticket, Users, type LucideIcon } from 'lucide-react'
import { getCreatorRevenue } from '@/server/functions/revenue'
import type { RevenueCategory } from '@/server/lib/revenue-series'

/**
 * Client-side glue for the revenue page: how often it refetches, what the four
 * categories are called, and the formatters the chart needs that `formatPrice` is
 * the wrong tool for.
 */

/**
 * How often the page refetches while it is open — the "real-time" in the report.
 *
 * A minute rather than seconds: every figure here is settled money arriving through
 * a Stripe webhook or an impression rollup, not a live counter, and each tick costs
 * four aggregations over a creator's whole ledger. Anything under ten seconds would
 * be a load test rather than a feature.
 */
export const REVENUE_REFETCH_MS = 30_000

/**
 * Its own query key, deliberately not the dashboard's: sharing one would make this
 * page's timer refetch the video table too, on a page that never shows it.
 */
export const revenueQueryOptions = (year: number | undefined) =>
  queryOptions({
    queryKey: ['revenue', year ?? 'current'] as const,
    queryFn: () => getCreatorRevenue({ data: { year } }),
    refetchInterval: REVENUE_REFETCH_MS,
    // A backgrounded tab must not run four aggregations a minute for nobody.
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    /**
     * Without this the observer refetches the instant it mounts: the router
     * dehydrates the loader-warmed cache into the HTML, and the app's QueryClient
     * takes no defaults, so `staleTime` would be 0 and the first paint would pay for
     * the same query twice.
     */
    staleTime: REVENUE_REFETCH_MS / 2,
    // Switching year dims the old numbers instead of blanking the page.
    placeholderData: keepPreviousData,
  })

export type RevenueCategoryMeta = {
  key: RevenueCategory
  label: string
  icon: LucideIcon
  /** The `--chart-N` slot this category owns, fixed so colours survive a year change. */
  color: string
  description: string
}

/**
 * The four categories in one place, in the order `REVENUE_CATEGORIES` declares.
 *
 * This single list drives the stack order, the tile row and the legend, so those
 * three can never disagree about which colour means which source.
 */
export const REVENUE_CATEGORY_META: ReadonlyArray<RevenueCategoryMeta> = [
  {
    key: 'ad',
    label: 'Ad revenue',
    icon: Megaphone,
    color: 'var(--chart-1)',
    description: 'Estimated from preroll impressions',
  },
  {
    key: 'subscription',
    label: 'Subscriptions',
    icon: Users,
    color: 'var(--chart-2)',
    description: 'Membership invoices actually collected',
  },
  {
    key: 'payPerView',
    label: 'Pay-per-view',
    icon: Ticket,
    color: 'var(--chart-3)',
    description: 'One-off video purchases',
  },
  {
    key: 'tip',
    label: 'Tipping',
    icon: Heart,
    color: 'var(--chart-4)',
    description: 'Tips and channel donations',
  },
]

/**
 * Month names as a fixed array rather than `toLocaleString`.
 *
 * Two reasons, both bugs avoided: a locale-dependent name is a hydration mismatch
 * for the same reason `formatPrice` pins `en-US`, and building a `Date` from a month
 * index to format it would shift the label back a month for any viewer west of UTC —
 * re-introducing in the UI exactly the boundary the server took care to avoid.
 */
export const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

/**
 * Compact money for an axis tick ("$1.2K"), where an exact figure would not fit.
 *
 * Not a replacement for `formatPrice`: every number a creator might act on — a tile,
 * a tooltip row, the cumulative total — still goes through that one, exactly.
 */
export function formatAxisMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(cents / 100)
}

/** "Mar 2026" from an ISO date, fixed-locale for the same reason as the month labels. */
export function formatTrackedSince(iso: string): string {
  const month = Number(iso.slice(5, 7))
  return `${MONTH_LABELS[month - 1] ?? '?'} ${iso.slice(0, 4)}`
}

/** A category's share of a total, as a rounded percentage string. */
export function sharePercent(part: number, total: number): string {
  if (!total) return '0%'
  return `${Math.round((part / total) * 100)}%`
}
