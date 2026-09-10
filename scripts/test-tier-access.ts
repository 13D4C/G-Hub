/**
 * Self-check for the membership-ladder predicate — the rule that decides which
 * premium video a paying subscriber may watch, once `isEntitled` has decided they
 * are paying at all.
 *
 * Run: npm run test:tier-access
 *
 * `tierUnlocks` lives alone in a module with no imports precisely so this can run
 * under plain `node --experimental-strip-types`, which resolves neither the `@/`
 * alias nor Mongoose. Same arrangement as `test-entitlement.ts`.
 */
import assert from 'node:assert/strict'
import { tierUnlocks } from '../src/server/lib/tier-access.ts'

const silver = { id: 'silver', rank: 1 }
const gold = { id: 'gold', rank: 2 }
const vip = { id: 'vip', rank: 3 }

// An ungated premium video: any subscriber, on any rung or none at all.
assert.equal(tierUnlocks(null, null), true)
assert.equal(tierUnlocks(silver, null), true)

// A channel-level subscription (no tier) against a tier gate: fail closed.
assert.equal(tierUnlocks(null, silver), false)

// A tier always opens its own gate.
assert.equal(tierUnlocks(silver, silver), true)
assert.equal(tierUnlocks(vip, vip), true)

// Higher unlocks lower — the entire point of a ladder.
assert.equal(tierUnlocks(gold, silver), true)
assert.equal(tierUnlocks(vip, silver), true)
assert.equal(tierUnlocks(vip, gold), true)

// Lower does not unlock higher.
assert.equal(tierUnlocks(silver, gold), false)
assert.equal(tierUnlocks(silver, vip), false)
assert.equal(tierUnlocks(gold, vip), false)

// Equal ranks are equal access: two names for the same level is a legitimate thing
// for a creator to sell.
assert.equal(tierUnlocks({ id: 'gold-annual', rank: 2 }, gold), true)

// A gate naming a tier that no longer exists can only be opened by that exact tier.
const vanished = { id: 'deleted', rank: null }
assert.equal(tierUnlocks(vip, vanished), false, 'a vanished gate is not outranked')
assert.equal(tierUnlocks({ id: 'deleted', rank: 1 }, vanished), true, 'exact id still opens it')

// ...and a subscription holding a vanished tier is in the same position.
assert.equal(tierUnlocks({ id: 'deleted', rank: null }, silver), false)
assert.equal(tierUnlocks({ id: 'deleted', rank: null }, vanished), true)

// Rank 0 is a real rung, not "absent": it opens gates at rank 0 and nothing above.
const bronze = { id: 'bronze', rank: 0 }
assert.equal(tierUnlocks(bronze, bronze), true)
assert.equal(tierUnlocks(bronze, silver), false)
assert.equal(tierUnlocks(silver, bronze), true)

console.log('tier access: all checks passed')
