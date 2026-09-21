import { lazy, Suspense } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { Wallet } from 'lucide-react'
import { z } from 'zod'
import { EmptyState } from '@/components/empty-state'
import { Card } from '@/components/ui/card'
import { meQueryOptions } from '@/lib/auth'
import { formatPrice } from '@/lib/channels'
import { formatCount } from '@/lib/dashboard'
import {
  formatTrackedSince,
  revenueQueryOptions,
  REVENUE_CATEGORY_META,
  sharePercent,
  type RevenueCategoryMeta,
} from '@/lib/revenue'
import type { CreatorRevenue } from '@/server/functions/revenue'

/**
 * A creator's income, and nothing else.
 *
 * Separate from `/dashboard` on purpose: that page is an operations view — views,
 * likes, the video table, the upload and edit controls — which happens to carry a few
 * money tiles. This one answers a single question, "what has this channel earned and
 * from where", and is the only page that refetches on a timer to do it.
 *
 * Like the dashboard it takes no creator id: every account is a channel and the
 * server answers for the session.
 */

const revenueSearchSchema = z.object({
  /**
   * Absent means the current year, which the *server* resolves. Deliberately not
   * defaulted here: a `new Date().getFullYear()` during render is a hydration
   * mismatch waiting for New Year's Eve.
   */
  year: z.coerce.number().int().min(2000).max(2200).optional().catch(undefined),
})

// Recharts brings a redux runtime with it. Splitting it out lets the money figures
// paint first, and keeps the chart's DOM measurement off the server.
const RevenueChart = lazy(() => import('@/components/revenue-chart'))

export const Route = createFileRoute('/revenue')({
  validateSearch: revenueSearchSchema,
  loaderDeps: ({ search }) => ({ year: search.year }),
  beforeLoad: async ({ context, location }) => {
    const user = await context.queryClient.ensureQueryData(meQueryOptions)
    if (!user) {
      throw redirect({ to: '/login', search: { redirect: location.pathname } })
    }
  },
  loader: async ({ context, deps }) => {
    // Warmed rather than returned: the component reads the same options through
    // `useQuery` so the refetch timer has an observer to hang off.
    await context.queryClient.ensureQueryData(revenueQueryOptions(deps.year))
  },
  component: RevenuePage,
})

function RevenuePage() {
  const { year } = Route.useSearch()
  const navigate = useNavigate()
  const { data, isFetching } = useQuery(revenueQueryOptions(year))

  if (!data) return <EmptyState icon={Wallet} message="Loading your revenue…" />

  const { currency, allTimeTotals, yearTotals } = data
  // Gated on all-time rather than the selected year, so browsing an empty past year
  // does not greet an established creator with onboarding copy.
  const isNewCreator = allTimeTotals.totalCents === 0

  return (
    <Card variant="glass" className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold text-white">Revenue</h1>
          <p className="text-sm text-slate-300">{data.channelName}</p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`text-xs ${isFetching ? 'text-slate-200' : 'text-slate-400'}`}
            aria-live="polite"
          >
            {isFetching ? 'Updating…' : 'Live'}
          </span>
          <select
            aria-label="Revenue year"
            value={data.year}
            onChange={(e) =>
              navigate({
                to: '/revenue',
                search: { year: Number(e.target.value) },
                replace: true,
              })
            }
            className="rounded-lg border border-white/20 bg-white/10 px-2 py-1 text-sm text-white outline-none focus:border-white/50"
          >
            {data.years.map((option) => (
              <option key={option} value={option} className="text-slate-900">
                {option}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* The headline figure: everything, ever. Not the selected year — "cumulative"
          means the whole channel's life, and a year-to-date number under that label
          would collapse to nearly nothing every January and read as a bug. */}
      <Card className="flex flex-col gap-1 p-5">
        <span className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
          <Wallet className="size-3.5" />
          Total earned — all sources, all time
        </span>
        <span className="font-display text-4xl font-semibold text-slate-900">
          {formatPrice(allTimeTotals.totalCents, currency)}
        </span>
        <span className="text-xs text-slate-500">
          {data.year}: {formatPrice(yearTotals.totalCents, currency)}
        </span>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {REVENUE_CATEGORY_META.map((meta) => (
          <RevenueCategoryTile key={meta.key} meta={meta} revenue={data} />
        ))}
      </div>

      <Card className={`flex flex-col gap-3 p-5 ${isFetching ? 'opacity-70 transition-opacity' : ''}`}>
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-lg font-semibold text-slate-900">
            {data.year} by month
          </h2>
          <span className="text-xs text-slate-500">
            {formatPrice(yearTotals.totalCents, currency)} this year
          </span>
        </div>

        {isNewCreator ? (
          <EmptyState
            icon={Wallet}
            message="No earnings yet. Ad revenue, subscriptions, pay-per-view sales and tips will appear here as they arrive."
          />
        ) : (
          <Suspense
            fallback={<div className="h-[320px] animate-pulse rounded-xl bg-slate-100" />}
          >
            <RevenueChart revenue={data} />
          </Suspense>
        )}
      </Card>

      <PartialHistoryNote revenue={data} />

      {data.excludedCurrencies.length > 0 && (
        <p className="text-xs text-amber-200">
          Some earnings are recorded in another currency and are not included above:{' '}
          {data.excludedCurrencies
            .map((row) => formatPrice(row.cents, row.currency))
            .join(', ')}
          . This channel reports in {currency.toUpperCase()}.
        </p>
      )}

      <p className="text-xs text-slate-400">
        Ad revenue is an estimate: {formatCount(allTimeTotals.adImpressions)} impressions at{' '}
        {formatPrice(data.cpmCents, currency)} per thousand. Tips, pay-per-view and
        subscriptions are money Stripe actually collected. Refunds are not deducted.
      </p>
    </Card>
  )
}

function RevenueCategoryTile({
  meta,
  revenue,
}: {
  meta: RevenueCategoryMeta
  revenue: CreatorRevenue
}) {
  const Icon = meta.icon
  const allTime = revenue.allTimeTotals[meta.key]
  const since = revenue.trackedSince[meta.key]
  // Whether the whole year on screen predates this category being recorded at all.
  const untrackedThisYear = revenue.months.every((month) => month[meta.key] === null)

  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
        <span
          aria-hidden
          className="size-2.5 shrink-0 rounded-[2px]"
          style={{ backgroundColor: meta.color }}
        />
        <Icon className="size-3.5" />
        {meta.label}
      </span>
      <span className="font-display text-2xl font-semibold text-slate-900">
        {untrackedThisYear ? '—' : formatPrice(revenue.yearTotals[meta.key], revenue.currency)}
      </span>
      <span className="text-xs text-slate-500">
        {untrackedThisYear
          ? `Not tracked in ${revenue.year}`
          : `${sharePercent(revenue.yearTotals[meta.key], revenue.yearTotals.totalCents)} of ${revenue.year}`}
      </span>
      <span className="text-xs text-slate-400">
        {formatPrice(allTime, revenue.currency)} all time
        {since ? ` · since ${formatTrackedSince(since)}` : ''}
      </span>
    </Card>
  )
}

/**
 * Says plainly that the cumulative total is scoped, when it is.
 *
 * "Accurate" has to mean accurate *and* honest about what it covers: two of the four
 * categories only started being recorded when this page shipped, so the all-time
 * figure understates them and saying nothing would be the misleading option.
 */
function PartialHistoryNote({ revenue }: { revenue: CreatorRevenue }) {
  const partial = REVENUE_CATEGORY_META.filter((meta) => revenue.trackedSince[meta.key])
  if (partial.length === 0) return null

  return (
    <p className="text-xs text-slate-400">
      {partial
        .map(
          (meta) =>
            `${meta.label} has been recorded since ${formatTrackedSince(
              revenue.trackedSince[meta.key] as string,
            )}`,
        )
        .join(', and ')}
      . Anything earned before then was never recorded, so the all-time total
      understates {partial.length > 1 ? 'those sources' : 'that source'}.
    </p>
  )
}
