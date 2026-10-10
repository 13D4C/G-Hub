// Relative, `.ts`-suffixed import for the same reason as `entitlement.ts`:
// `scripts/test-dashboard.ts` loads this under plain `node
// --experimental-strip-types`, which resolves neither tsconfig paths nor
// extensionless specifiers. Nothing else may be imported here — Mongoose would
// break that script.
import { isEntitled, type EntitlementState } from './entitlement-status.ts'

/**
 * The arithmetic behind the creator dashboard, kept apart from the query that feeds
 * it so `npm run test:dashboard` can check it without a database.
 *
 * Every count is derived here rather than read from a stored total: these numbers
 * are reporting, not entitlement, so a stale denormalized copy would be a lie with
 * no upside.
 */

export type CountedVideo = { viewCount?: number; likeCount?: number; shareCount?: number }
export type TipGroup = { total: number; count: number }
/** Identical shape to a tip group — money and a count, grouped per video. */
export type SaleGroup = TipGroup
export type CountedSubscription = EntitlementState & { priceCents?: number }

export type DashboardTotals = {
  videos: number
  views: number
  likes: number
  shares: number
  tipCents: number
  tipCount: number
  /** Everything pay-per-view has earned, in minor units. */
  saleCents: number
  /** How many copies have been sold, across every pay-per-view video. */
  saleCount: number
  subscribers: number
  monthlyCents: number
}

export function summarizeTotals(
  videos: Array<CountedVideo>,
  tipGroups: Array<TipGroup>,
  saleGroups: Array<SaleGroup>,
  subs: Array<CountedSubscription>,
  now: Date = new Date(),
): DashboardTotals {
  // Only subscriptions that entitle someone right now bill anything, and the rule
  // for that lives in `isEntitled` — a lapsed row left in `monthlyCents` would show
  // a creator revenue nobody is paying.
  const active = subs.filter((sub) => isEntitled(sub, now))

  return {
    videos: videos.length,
    views: videos.reduce((sum, v) => sum + (v.viewCount ?? 0), 0),
    likes: videos.reduce((sum, v) => sum + (v.likeCount ?? 0), 0),
    shares: videos.reduce((sum, v) => sum + (v.shareCount ?? 0), 0),
    // Includes channel donations, whose group has no video to sit under.
    tipCents: tipGroups.reduce((sum, row) => sum + row.total, 0),
    tipCount: tipGroups.reduce((sum, row) => sum + row.count, 0),
    // Every sale has a video, unlike a tip, so these always add up to the rows.
    saleCents: saleGroups.reduce((sum, row) => sum + row.total, 0),
    saleCount: saleGroups.reduce((sum, row) => sum + row.count, 0),
    subscribers: active.length,
    monthlyCents: active.reduce((sum, sub) => sum + (sub.priceCents ?? 0), 0),
  }
}
