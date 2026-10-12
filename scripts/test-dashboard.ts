/**
 * Self-check for the creator dashboard arithmetic. No database and no Stripe: the
 * point is the sums and the entitlement filter behind `monthlyCents`, which is the
 * only number on that page a creator could act on financially.
 *
 * Run with `npm run test:dashboard`.
 */
import assert from 'node:assert/strict'
import { summarizeTotals } from '../src/server/lib/dashboard-totals.ts'

const NOW = new Date('2026-01-15T00:00:00Z')
const future = new Date('2026-02-01T00:00:00Z')
const past = new Date('2026-01-01T00:00:00Z')

const empty = summarizeTotals([], [], [], [], NOW)
assert.deepEqual(empty, {
  videos: 0,
  views: 0,
  likes: 0,
  shares: 0,
  tipCents: 0,
  tipCount: 0,
  saleCents: 0,
  saleCount: 0,
  subscribers: 0,
  monthlyCents: 0,
})

const totals = summarizeTotals(
  [
    { viewCount: 10, likeCount: 3, shareCount: 1 },
    { viewCount: 5, likeCount: 0, shareCount: 2 },
    // A video from before view counting existed: `.lean()` skips defaults, so the
    // fields come back undefined and must count as zero, not NaN.
    {},
  ],
  [
    { amountCents: 200 },
    { amountCents: 300 },
    // The channel donation, which has no video row to appear under.
    { amountCents: 1000 },
  ],
  [
    // Pay-per-view sales. Unlike tips there is no videoless row: every sale is the
    // sale of some video, which is why the dashboard needs no "counted in the total
    // but not in any row" caveat for this column.
    { amountCents: 200 },
    { amountCents: 300 },
    { amountCents: 300 },
    { amountCents: 300 },
  ],
  [
    { status: 'active', currentPeriodEnd: future, priceCents: 499 },
    { status: 'trialing', currentPeriodEnd: null, priceCents: 999 },
    // Cancelled, and an active row whose paid period already lapsed: neither bills.
    { status: 'canceled', currentPeriodEnd: future, priceCents: 10_000 },
    { status: 'active', currentPeriodEnd: past, priceCents: 10_000 },
  ],
  NOW,
)

assert.equal(totals.videos, 3)
assert.equal(totals.views, 15)
assert.equal(totals.likes, 3)
assert.equal(totals.shares, 3)
assert.equal(totals.tipCents, 1500)
assert.equal(totals.tipCount, 3)
// Sales are summed apart from tips: a different product, and a creator who read one
// figure as the other would misjudge what their channel actually earns.
assert.equal(totals.saleCents, 1100)
assert.equal(totals.saleCount, 4)
assert.equal(totals.subscribers, 2)
assert.equal(totals.monthlyCents, 1498)

console.log('dashboard: all checks passed')
