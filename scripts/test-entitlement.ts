/**
 * Self-check for the entitlement predicate — the one piece of billing logic that
 * decides whether a viewer gets past the paywall, and the only one testable without
 * a Stripe account or a database.
 *
 * Run: node --experimental-strip-types scripts/test-entitlement.ts
 */
import assert from 'node:assert/strict'
import { isEntitled } from '../src/server/lib/entitlement-status.ts'

const now = new Date('2026-09-09T12:00:00Z')
const future = new Date('2026-10-09T12:00:00Z')
const past = new Date('2026-08-09T12:00:00Z')

// No plan at all.
assert.equal(isEntitled(null, now), false)

// A paid, current plan.
assert.equal(isEntitled({ status: 'active', currentPeriodEnd: future }, now), true)
assert.equal(isEntitled({ status: 'trialing', currentPeriodEnd: future }, now), true)

// Cancelled at period end is still paid for until that date — Stripe leaves the
// status `active` and only the date says it is winding down.
assert.equal(isEntitled({ status: 'active', currentPeriodEnd: past }, now), false)

// Statuses that must never entitle, even with time left on the clock.
for (const status of ['past_due', 'unpaid', 'incomplete', 'canceled', 'paused', 'none']) {
  assert.equal(isEntitled({ status, currentPeriodEnd: future }, now), false, status)
}

// A brand-new plan Stripe has not billed yet has no period end; the status carries it.
// `undefined` is the same case, reached through a `.lean()` read of an older row.
assert.equal(isEntitled({ status: 'active', currentPeriodEnd: null }, now), true)
assert.equal(isEntitled({ status: 'active' }, now), true)

// The boundary itself: the period end is exclusive, so the instant it arrives the
// plan is over. Anything else double-counts the last millisecond.
assert.equal(isEntitled({ status: 'active', currentPeriodEnd: now }, now), false)

console.log('entitlement: all checks passed')
