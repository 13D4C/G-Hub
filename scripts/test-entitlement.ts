/**
 * Self-check for the entitlement predicate — the one rule that decides whether a
 * paying viewer gets in and a lapsed one does not.
 *
 * Run: npm run test:entitlement
 *
 * `isEntitled` lives alone in a module with no imports precisely so this can run
 * under plain `node --experimental-strip-types`, which resolves neither the `@/`
 * alias nor Mongoose.
 */
import assert from 'node:assert/strict'
import { isEntitled } from '../src/server/lib/entitlement-status.ts'

const now = new Date('2026-01-15T00:00:00Z')
const future = new Date('2026-02-15T00:00:00Z')
const past = new Date('2026-01-01T00:00:00Z')

// No subscription row at all: an anonymous or never-subscribed viewer.
assert.equal(isEntitled(null, now), false)

// The two statuses that entitle.
assert.equal(isEntitled({ status: 'active', currentPeriodEnd: future }, now), true)
assert.equal(isEntitled({ status: 'trialing', currentPeriodEnd: future }, now), true)

// Everything else does not, however far in the future the period runs.
for (const status of ['incomplete', 'past_due', 'unpaid', 'canceled', 'paused', 'weird']) {
  assert.equal(isEntitled({ status, currentPeriodEnd: future }, now), false, status)
}

// Fail-closed backstop: an active row whose paid period has lapsed is not entitled,
// even if the webhook that should have moved it to `past_due` never arrived.
assert.equal(isEntitled({ status: 'active', currentPeriodEnd: past }, now), false)

// The boundary itself is exclusive: the instant the period ends, it is over.
assert.equal(isEntitled({ status: 'active', currentPeriodEnd: now }, now), false)

// Before Stripe has billed a first period there is no end date; the status carries it.
assert.equal(isEntitled({ status: 'active', currentPeriodEnd: null }, now), true)
assert.equal(isEntitled({ status: 'active' }, now), true)

console.log('entitlement: all checks passed')
