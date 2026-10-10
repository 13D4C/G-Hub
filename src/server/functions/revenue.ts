import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { AD_CPM_CENTS } from '@/lib/ad-revenue'
import {
  AD_TRACKING_SINCE,
  PAY_PER_VIEW_TRACKING_SINCE,
  SUBSCRIPTION_INVOICE_TRACKING_SINCE,
  TIP_TRACKING_SINCE,
} from '@/lib/revenue-tracking'
import { requireUserId } from '@/server/auth/require-user'
import {
  adImpressions,
  subscriptionInvoices,
  tips,
  users,
  videoPurchases,
  type LedgerEntry,
} from '@/server/data'
import { yearMonthOf } from '@/server/lib/revenue-buckets'
import {
  buildRevenueSeries,
  currentRevenueYear,
  type ImpressionBucket,
  type MoneyBucket,
  type RevenueSeries,
} from '@/server/lib/revenue-series'

/**
 * The creator revenue report: what one channel has earned, by month and by source.
 *
 * Separate from `getCreatorDashboard` rather than folded into it, because this one is
 * polled: the revenue page refetches on a timer, and sharing a payload would drag the
 * whole video table along on every tick for a page that never shows it.
 *
 * Like the dashboard, it needs no creator argument — every account is a channel and
 * identity comes from the session, so there is no `creatorId` to tamper with. That is
 * the access control.
 */

const revenueSchema = z.object({
  /** Omitted means the current UTC year, resolved here so the client never needs a clock. */
  year: z.number().int().min(2000).max(2100).optional(),
})

export type CreatorRevenue = RevenueSeries & {
  channelName: string
  /** The rate behind the ad estimate, so the page can explain the number it shows. */
  cpmCents: number
  /** When these figures were read, so a polled view can show its own freshness. */
  asOf: string
}


/**
 * Group a creator's ledger rows into calendar months.
 *
 * Bucketed in TypeScript rather than by the database, so the two storage backends
 * cannot disagree about which month a payment landed in. `yearMonthOf` is the single
 * place the timezone is applied.
 */
function toMoneyBuckets(rows: Array<LedgerEntry>): Array<MoneyBucket> {
  const buckets = new Map<string, MoneyBucket>()

  for (const row of rows) {
    const { year, month } = yearMonthOf(row.at)
    const currency = row.currency || 'usd'
    const key = `${year}-${month}-${currency}`
    const existing = buckets.get(key)
    if (existing) existing.cents += row.amountCents
    else buckets.set(key, { year, month, currency, cents: row.amountCents })
  }

  return [...buckets.values()]
}

function toImpressionBuckets(rows: Array<{ at: Date }>): Array<ImpressionBucket> {
  const buckets = new Map<string, ImpressionBucket>()

  for (const row of rows) {
    const { year, month } = yearMonthOf(row.at)
    const key = `${year}-${month}`
    const existing = buckets.get(key)
    if (existing) existing.count += 1
    else buckets.set(key, { year, month, count: 1 })
  }

  return [...buckets.values()]
}

export const getCreatorRevenue = createServerFn({ method: 'GET' })
  .validator(revenueSchema)
  .handler(async ({ data }): Promise<CreatorRevenue> => {
    const creatorId = await requireUserId()
    const year = data.year ?? currentRevenueYear(new Date())

    // ponytail: these read a creator's whole ledger on every poll, which is the price
    // of the all-time total. Fine at this scale; if a channel's history ever outgrows
    // it, add a rolling window here and keep a stored all-time rollup instead.
    const [creatorDoc, tipRows, saleRows, invoiceRows, impressionRows] = await Promise.all([
      users.findById(creatorId),
      tips.listByCreator(creatorId),
      videoPurchases.listByCreator(creatorId),
      subscriptionInvoices.listByCreator(creatorId),
      adImpressions.listByCreator(creatorId),
    ])

    const impressionBuckets = toImpressionBuckets(impressionRows)

    const series = buildRevenueSeries({
      year,
      // The channel's canonical unit. Anything else is reported rather than converted;
      // there is no FX in this codebase.
      currency: creatorDoc?.channelCurrency || 'usd',
      cpmCents: AD_CPM_CENTS,
      tips: toMoneyBuckets(tipRows),
      payPerView: toMoneyBuckets(saleRows),
      subscriptions: toMoneyBuckets(invoiceRows),
      adImpressions: impressionBuckets,
      trackedSince: {
        ad: AD_TRACKING_SINCE,
        subscription: SUBSCRIPTION_INVOICE_TRACKING_SINCE,
        payPerView: PAY_PER_VIEW_TRACKING_SINCE,
        tip: TIP_TRACKING_SINCE,
      },
    })

    return {
      ...series,
      channelName: creatorDoc?.channelName || creatorDoc?.name || 'Your channel',
      cpmCents: AD_CPM_CENTS,
      asOf: new Date().toISOString(),
    }
  })
