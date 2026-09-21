import { createServerFn } from '@tanstack/react-start'
import { Types } from 'mongoose'
import { z } from 'zod'
import { AD_CPM_CENTS } from '@/lib/ad-revenue'
import {
  AD_TRACKING_SINCE,
  PAY_PER_VIEW_TRACKING_SINCE,
  SUBSCRIPTION_INVOICE_TRACKING_SINCE,
  TIP_TRACKING_SINCE,
} from '@/lib/revenue-tracking'
import { requireUserId } from '@/server/auth/require-user'
import { AdImpressionModel } from '@/server/db/models/ad-impression'
import { SubscriptionInvoiceModel } from '@/server/db/models/subscription-invoice'
import { TipModel } from '@/server/db/models/tip'
import { UserModel } from '@/server/db/models/user'
import { VideoPurchaseModel } from '@/server/db/models/video-purchase'
import { connectToDatabase } from '@/server/db/mongoose'
import {
  buildRevenueSeries,
  currentRevenueYear,
  REVENUE_TIME_ZONE,
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

/** The `_id` of a money `$group`, which keys on the calendar month and the unit. */
type MoneyGroup = { _id: { year: number; month: number; currency: string }; cents: number }
type ImpressionGroup = { _id: { year: number; month: number }; count: number }

/**
 * Group one money collection into calendar months.
 *
 * `dateField` differs per collection — tips and purchases carry `createdAt`, an
 * invoice carries the date the money was actually collected — so the caller names it.
 *
 * There is deliberately **no date `$match`**: the buckets span every year the channel
 * has ever earned in. That buys the all-time cumulative total without a second round
 * trip, and it removes the year-boundary question entirely, since no range has to be
 * computed in any particular timezone.
 *
 * `$year`/`$month` default to UTC, so a tip at `2026-01-01T00:30Z` counts as January
 * even for a creator five hours west. The timezone is passed explicitly rather than
 * left implicit so that decision is visible in the code: the rest of the app has
 * already made the same call, pinning `en-US` in `formatPrice` and `formatCount`.
 * Because nothing here filters on a date, this constant is the only place the
 * boundary is decided — moving off UTC later is a one-line change with no range
 * arithmetic to get wrong.
 */
function monthlyMoneyPipeline(creatorId: Types.ObjectId, dateField: string, amountField: string) {
  return [
    { $match: { creatorId } },
    {
      $group: {
        _id: {
          year: { $year: { date: `$${dateField}`, timezone: REVENUE_TIME_ZONE } },
          month: { $month: { date: `$${dateField}`, timezone: REVENUE_TIME_ZONE } },
          currency: '$currency',
        },
        cents: { $sum: `$${amountField}` },
      },
    },
  ]
}

function toMoneyBuckets(groups: Array<MoneyGroup>): Array<MoneyBucket> {
  return groups.map((row) => ({
    year: row._id.year,
    month: row._id.month,
    currency: row._id.currency ?? 'usd',
    cents: row.cents,
  }))
}

export const getCreatorRevenue = createServerFn({ method: 'GET' })
  .validator(revenueSchema)
  .handler(async ({ data }): Promise<CreatorRevenue> => {
    const creatorId = await requireUserId()
    await connectToDatabase()

    // Aggregation does no schema casting, so this has to be a real ObjectId — a plain
    // string silently matches nothing and every figure on the page reads a confident
    // zero. Same gotcha as the dashboard's tip aggregate.
    const creator = new Types.ObjectId(creatorId)
    const year = data.year ?? currentRevenueYear(new Date())

    // ponytail: these scan a creator's whole ledger on every poll, which is the price
    // of the all-time total. Fine with the {creatorId, date} indexes at this scale; if
    // a channel's history ever outgrows it, add a rolling-window $match here and keep
    // a stored all-time rollup instead.
    const [creatorDoc, tipGroups, saleGroups, invoiceGroups, impressionGroups] = await Promise.all([
      UserModel.findById(creatorId).select('name channelName channelCurrency').lean(),
      TipModel.aggregate<MoneyGroup>(monthlyMoneyPipeline(creator, 'createdAt', 'amountCents')),
      VideoPurchaseModel.aggregate<MoneyGroup>(
        monthlyMoneyPipeline(creator, 'createdAt', 'amountCents'),
      ),
      SubscriptionInvoiceModel.aggregate<MoneyGroup>(
        monthlyMoneyPipeline(creator, 'paidAt', 'amountPaidCents'),
      ),
      // Impressions are counted, not summed, and carry no currency of their own: the
      // CPM is expressed in the channel's unit by fiat.
      AdImpressionModel.aggregate<ImpressionGroup>([
        { $match: { creatorId: creator } },
        {
          $group: {
            _id: {
              year: { $year: { date: '$shownAt', timezone: REVENUE_TIME_ZONE } },
              month: { $month: { date: '$shownAt', timezone: REVENUE_TIME_ZONE } },
            },
            count: { $sum: 1 },
          },
        },
      ]),
    ])

    const adImpressions: Array<ImpressionBucket> = impressionGroups.map((row) => ({
      year: row._id.year,
      month: row._id.month,
      count: row.count,
    }))

    const series = buildRevenueSeries({
      year,
      // The channel's canonical unit. Anything else is reported rather than converted;
      // there is no FX in this codebase.
      currency: creatorDoc?.channelCurrency || 'usd',
      cpmCents: AD_CPM_CENTS,
      tips: toMoneyBuckets(tipGroups),
      payPerView: toMoneyBuckets(saleGroups),
      subscriptions: toMoneyBuckets(invoiceGroups),
      adImpressions,
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
