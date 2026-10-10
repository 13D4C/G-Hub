/**
 * The arithmetic behind the creator revenue dashboard, kept apart from the queries
 * that feed it so `npm run test:revenue-series` can check it without a database.
 *
 * No imports at all, on purpose — the same constraint `dashboard-totals.ts` and
 * `entitlement-status.ts` carry: the test script loads this under plain
 * `node --experimental-strip-types`, which resolves neither tsconfig paths nor
 * extensionless specifiers, and a single Mongoose import would break it. Everything
 * that varies — the clock, the CPM rate, the tracking cutovers — is passed in rather
 * than read, which is also what makes each of them pinnable in a test.
 */

/**
 * Months are bucketed in UTC, matching the `timezone` passed to `$year`/`$month` in
 * `getCreatorRevenue`. The constant lives here so the query and the arithmetic cannot
 * drift onto different calendars.
 */
export const REVENUE_TIME_ZONE = 'UTC'

/**
 * Fixed order, relied on by the chart's stack, the tile row and the legend alike.
 * Changing it re-colours the chart, so it is one list rather than three.
 */
export const REVENUE_CATEGORIES = ['ad', 'subscription', 'payPerView', 'tip'] as const
export type RevenueCategory = (typeof REVENUE_CATEGORIES)[number]

/** One `{year, month, currency}` group as `$group` hands it back, money already summed. */
export type MoneyBucket = { year: number; month: number; currency: string; cents: number }

/** Impressions are counted, not summed: ad revenue is a rate applied to a count. */
export type ImpressionBucket = { year: number; month: number; count: number }

/** ISO date per category, or null where the history is complete. */
export type TrackedSince = Record<RevenueCategory, string | null>

export type RevenueInput = {
  /** The year the twelve-month series covers. */
  year: number
  /** The channel's canonical currency. Buckets in any other unit are excluded, never converted. */
  currency: string
  /** Revenue per thousand impressions, in the channel's own minor units. */
  cpmCents: number
  tips: Array<MoneyBucket>
  payPerView: Array<MoneyBucket>
  subscriptions: Array<MoneyBucket>
  adImpressions: Array<ImpressionBucket>
  trackedSince: TrackedSince
}

export type RevenueTotals = Record<RevenueCategory, number> & {
  totalCents: number
  adImpressions: number
}

/**
 * One of exactly twelve.
 *
 * A category is `null` when that month predates the category's tracking cutover —
 * **not tracked, which is not the same as zero.** The chart skips a null rather than
 * drawing a zero-height segment, which is the whole point: a month nobody recorded
 * must not be rendered as a month that earned nothing.
 */
export type RevenueMonth = { month: number } & Record<RevenueCategory, number | null>

export type RevenueSeries = {
  year: number
  currency: string
  /** Always length 12, index 0 = January. */
  months: Array<RevenueMonth>
  /** Everything earned inside `year`. Sums `months` exactly. */
  yearTotals: RevenueTotals
  /** Everything earned ever, across every year — the headline cumulative number. */
  allTimeTotals: RevenueTotals
  /** Years with data, plus the selected one, newest first — the picker's options. */
  years: Array<number>
  trackedSince: TrackedSince
  /** Money seen in some other unit: reported rather than added. */
  excludedCurrencies: Array<{ currency: string; cents: number }>
}

/**
 * Ad revenue for a bucket of impressions, in whole minor units.
 *
 * Rounded here, once per bucket, so every caller rounds identically — see the note on
 * `buildRevenueSeries` about why the totals must sum already-rounded months.
 */
export function adRevenueCents(impressions: number, cpmCents: number): number {
  if (!impressions || !cpmCents) return 0
  return Math.round((impressions * cpmCents) / 1000)
}

/** The year to show when the caller names none. Clock injected; never `Date.now()`. */
export function currentRevenueYear(now: Date): number {
  return now.getUTCFullYear()
}

function emptyTotals(): RevenueTotals {
  return { ad: 0, subscription: 0, payPerView: 0, tip: 0, totalCents: 0, adImpressions: 0 }
}

function bucketKey(year: number, month: number): string {
  return `${year}:${month}`
}

/**
 * Whether a whole month falls before a category started being recorded.
 *
 * The month *containing* the cutover counts as tracked: it holds real, if partial,
 * data, and blanking it would hide money that was actually collected. The UI marks
 * that boundary with a reference line instead.
 */
function isUntracked(since: string | null, year: number, month: number): boolean {
  if (!since) return false
  const startYear = Number(since.slice(0, 4))
  const startMonth = Number(since.slice(5, 7))
  if (!Number.isFinite(startYear) || !Number.isFinite(startMonth)) return false
  return year < startYear || (year === startYear && month < startMonth)
}

/**
 * Fold the four grouped result sets into a year's worth of months plus the totals.
 *
 * The queries that produce the inputs carry no date filter, so these buckets already
 * span every year the channel has earned in. That is deliberate and buys two things:
 * the all-time cumulative total costs no extra round trip, and no `$match` boundary
 * has to be reasoned about across a year edge in a particular timezone.
 */
export function buildRevenueSeries(input: RevenueInput): RevenueSeries {
  const { year, currency, cpmCents, trackedSince } = input

  // Per (year, month), the money in the channel's own currency.
  const cents = new Map<string, Record<RevenueCategory, number>>()
  const impressions = new Map<string, number>()
  const excluded = new Map<string, number>()
  const seenYears = new Set<number>([year])

  function slot(key: string): Record<RevenueCategory, number> {
    let row = cents.get(key)
    if (!row) {
      row = { ad: 0, subscription: 0, payPerView: 0, tip: 0 }
      cents.set(key, row)
    }
    return row
  }

  function foldMoney(buckets: Array<MoneyBucket>, category: RevenueCategory): void {
    for (const bucket of buckets) {
      // Unlike units are never added together: there is no FX in this codebase, and
      // silently summing them would be wrong in a way nobody could see. They are
      // surfaced instead, so the day this is non-empty something upstream has broken.
      if (bucket.currency !== currency) {
        excluded.set(bucket.currency, (excluded.get(bucket.currency) ?? 0) + bucket.cents)
        continue
      }
      seenYears.add(bucket.year)
      slot(bucketKey(bucket.year, bucket.month))[category] += bucket.cents
    }
  }

  foldMoney(input.tips, 'tip')
  foldMoney(input.payPerView, 'payPerView')
  foldMoney(input.subscriptions, 'subscription')

  for (const bucket of input.adImpressions) {
    seenYears.add(bucket.year)
    const key = bucketKey(bucket.year, bucket.month)
    const total = (impressions.get(key) ?? 0) + bucket.count
    impressions.set(key, total)
    // Rounded per month, so the bars a reader can add up match the total beside them.
    slot(key).ad = adRevenueCents(total, cpmCents)
  }

  const allTimeTotals = emptyTotals()
  for (const [key, row] of cents) {
    for (const category of REVENUE_CATEGORIES) {
      allTimeTotals[category] += row[category]
      allTimeTotals.totalCents += row[category]
    }
    allTimeTotals.adImpressions += impressions.get(key) ?? 0
  }

  const yearTotals = emptyTotals()
  const months: Array<RevenueMonth> = []

  for (let month = 1; month <= 12; month += 1) {
    const key = bucketKey(year, month)
    const row = cents.get(key)
    const entry = { month } as RevenueMonth

    for (const category of REVENUE_CATEGORIES) {
      const value = row?.[category] ?? 0
      // A month with real data is always shown, even if it predates the cutover:
      // hiding money that was demonstrably collected would be the worse error.
      if (value === 0 && isUntracked(trackedSince[category], year, month)) {
        entry[category] = null
        continue
      }
      entry[category] = value
      yearTotals[category] += value
      yearTotals.totalCents += value
    }

    yearTotals.adImpressions += impressions.get(key) ?? 0
    months.push(entry)
  }

  return {
    year,
    currency,
    months,
    yearTotals,
    allTimeTotals,
    // The selected year is always an option even with nothing in it, or choosing an
    // empty year would drop it from the picker that just selected it.
    years: [...seenYears].sort((a, b) => b - a),
    trackedSince,
    excludedCurrencies: [...excluded]
      .map(([code, sum]) => ({ currency: code, cents: sum }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
  }
}
