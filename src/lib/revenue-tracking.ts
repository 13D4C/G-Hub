/**
 * When each revenue category started being recorded.
 *
 * Two of the four categories on the revenue dashboard are younger than the app.
 * Subscriptions were a current-state mirror with no per-charge history until the
 * invoice ledger landed, and ads left no trace at all until impressions were
 * recorded. Months before those dates hold *no data*, which is not the same as
 * holding *no revenue* — and a chart that renders the two identically is lying
 * confidently.
 *
 * These dates are what let the series mark those months `null` instead of `0`, so
 * the page can say "not recorded" where it would otherwise draw a flat zero.
 *
 * No imports, on purpose — same reason as `ad-revenue.ts`.
 */

/**
 * Set once, when the revenue ledger ships. Not derived from the earliest row: the
 * first invoice a channel happens to receive says when *that creator* earned
 * something, not when the app began recording, and using it would mark every month
 * before a creator's first sale as "untracked" rather than as the genuine zero it is.
 */
export const SUBSCRIPTION_INVOICE_TRACKING_SINCE = '2026-09-21'

/** Same reasoning, for the impression collection. */
export const AD_TRACKING_SINCE = '2026-09-21'

/**
 * Tips and pay-per-view have a complete history — both have written one row per
 * payment since the features existed — so they have no cutover and `null` says so.
 */
export const TIP_TRACKING_SINCE = null
export const PAY_PER_VIEW_TRACKING_SINCE = null
