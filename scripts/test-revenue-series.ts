/**
 * Self-check for the revenue dashboard arithmetic. No database and no Stripe: the
 * point is the monthly buckets, the cumulative total, and the two distinctions the
 * page would otherwise get quietly wrong — a month that was never recorded versus a
 * month that earned nothing, and a year-to-date figure versus an all-time one.
 *
 * Run with `npm run test:revenue-series`.
 */
import assert from 'node:assert/strict'
import {
  adRevenueCents,
  buildRevenueSeries,
  currentRevenueYear,
  type MoneyBucket,
  type RevenueInput,
  type TrackedSince,
} from '../src/server/lib/revenue-series.ts'

const YEAR = 2026
const CPM = 250

/** Nothing has a cutover unless a case sets one. */
const TRACKED_ALL: TrackedSince = { ad: null, subscription: null, payPerView: null, tip: null }

function money(month: number, cents: number, over: Partial<MoneyBucket> = {}): MoneyBucket {
  return { year: YEAR, month, currency: 'usd', cents, ...over }
}

function input(over: Partial<RevenueInput> = {}): RevenueInput {
  return {
    year: YEAR,
    currency: 'usd',
    cpmCents: CPM,
    tips: [],
    payPerView: [],
    subscriptions: [],
    adImpressions: [],
    trackedSince: TRACKED_ALL,
    ...over,
  }
}

/** The month entry for a 1-12 month number. */
function monthOf(series: ReturnType<typeof buildRevenueSeries>, month: number) {
  const found = series.months.find((m) => m.month === month)
  assert.ok(found, `month ${month} missing from the series`)
  return found
}

// --- an empty channel still has a shape ---
{
  const series = buildRevenueSeries(input())

  assert.equal(series.months.length, 12, 'a year is always twelve months, never a gap')
  assert.deepEqual(
    series.months.map((m) => m.month),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    'months are January first, in order',
  )
  assert.equal(series.yearTotals.totalCents, 0)
  assert.equal(series.allTimeTotals.totalCents, 0)
  assert.deepEqual(series.excludedCurrencies, [])
  assert.deepEqual(
    series.years,
    [YEAR],
    'the selected year is an option even when nothing happened in it',
  )
}

// --- one bucket per category lands where it should ---
{
  const series = buildRevenueSeries(
    input({
      tips: [money(3, 500)],
      payPerView: [money(3, 200)],
      subscriptions: [money(3, 999)],
      adImpressions: [{ year: YEAR, month: 3, count: 4000 }],
    }),
  )

  const march = monthOf(series, 3)
  assert.equal(march.tip, 500)
  assert.equal(march.payPerView, 200)
  assert.equal(march.subscription, 999)
  assert.equal(march.ad, 1000, '4000 impressions at a 250c CPM is 1000c')

  assert.equal(series.yearTotals.totalCents, 500 + 200 + 999 + 1000)
  assert.equal(series.yearTotals.adImpressions, 4000)
  assert.equal(
    series.allTimeTotals.totalCents,
    series.yearTotals.totalCents,
    'with one year of data the two totals agree',
  )
}

// --- a gap month is a zero, not a hole ---
{
  const series = buildRevenueSeries(input({ tips: [money(1, 100), money(3, 100)] }))

  assert.equal(monthOf(series, 2).tip, 0, 'a month between two earning months reads zero')
  assert.notEqual(monthOf(series, 2).tip, null, 'a tracked empty month is 0, never null')
  assert.equal(series.yearTotals.tip, 200)
}

// --- the cumulative total is all-time, and the year total is not ---
{
  const series = buildRevenueSeries(
    input({
      tips: [money(5, 700), money(5, 300, { year: 2025 })],
    }),
  )

  assert.equal(series.yearTotals.tip, 700, 'last year stays out of this year')
  assert.equal(series.allTimeTotals.tip, 1000, 'but is counted in the cumulative figure')
  assert.equal(
    monthOf(series, 5).tip,
    700,
    'and never leaks into a month of the selected year',
  )
  assert.deepEqual(series.years, [2026, 2025], 'both years are offered, newest first')
}

// --- ad rounding is consistent: the bars add up to the total beside them ---
{
  // One impression a month at 250c/1000 is 0.25c, which rounds to 0 — three such
  // months sum to 0, where rounding the sum instead would produce 1. The chart must
  // not disagree with its own total.
  const series = buildRevenueSeries(
    input({
      adImpressions: [1, 2, 3].map((month) => ({ year: YEAR, month, count: 1 })),
    }),
  )

  const summed = series.months.reduce((total, m) => total + (m.ad ?? 0), 0)
  assert.equal(series.yearTotals.ad, summed, 'the year total is the sum of the months shown')
  assert.equal(series.allTimeTotals.ad, summed, 'and so is the all-time total')
  assert.equal(series.yearTotals.adImpressions, 3, 'the impressions themselves are not lost')
}

{
  // The rate itself, at the boundaries.
  assert.equal(adRevenueCents(0, CPM), 0)
  assert.equal(adRevenueCents(1000, CPM), 250)
  assert.equal(adRevenueCents(1500, CPM), 375)
  assert.equal(adRevenueCents(100, 0), 0, 'a zero CPM earns nothing rather than NaN')
}

// --- a foreign currency is reported, never added ---
{
  const series = buildRevenueSeries(
    input({
      tips: [money(4, 500), money(4, 900, { currency: 'eur' })],
    }),
  )

  assert.equal(monthOf(series, 4).tip, 500, 'only the channel currency reaches the chart')
  assert.equal(series.yearTotals.tip, 500)
  assert.equal(series.allTimeTotals.tip, 500)
  assert.deepEqual(
    series.excludedCurrencies,
    [{ currency: 'eur', cents: 900 }],
    'the excluded money is surfaced, so a broken upstream is visible rather than silent',
  )
}

// --- untracked is not zero ---
{
  const series = buildRevenueSeries(
    input({
      trackedSince: { ...TRACKED_ALL, ad: '2026-04-15' },
      adImpressions: [{ year: YEAR, month: 5, count: 4000 }],
    }),
  )

  assert.equal(monthOf(series, 3).ad, null, 'a month before the cutover was never recorded')
  assert.equal(
    monthOf(series, 4).ad,
    0,
    'the month containing the cutover holds real, if partial, data',
  )
  assert.equal(monthOf(series, 5).ad, 1000)
  assert.equal(monthOf(series, 3).tip, 0, 'a category with no cutover is unaffected')
}

{
  // Money recorded before the cutover must still be shown: hiding collected money
  // would be worse than admitting the cutover date is imprecise.
  const series = buildRevenueSeries(
    input({
      trackedSince: { ...TRACKED_ALL, subscription: '2026-06-01' },
      subscriptions: [money(2, 1200)],
    }),
  )

  assert.equal(monthOf(series, 2).subscription, 1200, 'real data always wins over a cutover')
  assert.equal(monthOf(series, 3).subscription, null, 'while an empty earlier month stays null')
  assert.equal(series.yearTotals.subscription, 1200)
}

// --- the default year reads UTC ---
{
  assert.equal(currentRevenueYear(new Date('2026-01-01T00:00:00Z')), 2026)
  assert.equal(
    currentRevenueYear(new Date('2025-12-31T23:59:59Z')),
    2025,
    'the boundary is UTC, matching the timezone the aggregation groups on',
  )
}

console.log('revenue series: all checks passed')
