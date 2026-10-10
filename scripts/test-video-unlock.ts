/**
 * Self-check for the catalogue-side paywall rule — the one that decides whether a
 * listed video draws a lock, mirroring what `requirePlayableVideo` decides on
 * playback.
 *
 * Run: npm run test:video-unlock
 *
 * `isUnlocked` lives in a module importing only other import-free modules precisely
 * so this can run under plain `node --experimental-strip-types`, which resolves
 * neither the `@/` alias nor Mongoose. Same arrangement as `test-tier-access.ts`.
 *
 * This rule used to exist as two hand-maintained copies, in `listVideos` and in the
 * channel page. Nothing checked that they agreed, and nothing checked either of them
 * without a database. Both are now this function, and these are the cases where a
 * disagreement would have been visible to a viewer.
 */
import assert from 'node:assert/strict'
import { isUnlocked, type UnlockInput } from '../src/server/lib/video-unlock.ts'
import type { VideoVisibility } from '../src/lib/video-visibility.ts'

const silver = { id: 'silver', rank: 1 }
const gold = { id: 'gold', rank: 2 }

/** A stranger: signed in or not, paying nothing, owning nothing. */
function viewer(visibility: VideoVisibility, over: Partial<UnlockInput> = {}): UnlockInput {
  return {
    visibility,
    isOwner: false,
    subscribed: false,
    heldTier: null,
    requiredTier: null,
    purchased: false,
    ...over,
  }
}

// --- public: open to everyone, which is the whole meaning of the state ------------
assert.equal(isUnlocked(viewer('public')), true)
assert.equal(isUnlocked(viewer('public', { subscribed: true })), true)

// --- private: nothing opens it but ownership -------------------------------------
assert.equal(isUnlocked(viewer('private')), false)
assert.equal(isUnlocked(viewer('private', { subscribed: true })), false)
assert.equal(isUnlocked(viewer('private', { purchased: true })), false)
assert.equal(isUnlocked(viewer('private', { isOwner: true })), true)

// --- subscriber: paying at all, and then high enough on the ladder ----------------
assert.equal(isUnlocked(viewer('subscriber')), false, 'a stranger sees a lock')
assert.equal(
  isUnlocked(viewer('subscriber', { subscribed: true })),
  true,
  'an ungated premium video opens for any subscriber',
)
assert.equal(
  isUnlocked(viewer('subscriber', { subscribed: true, heldTier: silver, requiredTier: gold })),
  false,
  'Silver does not reach a Gold gate',
)
assert.equal(
  isUnlocked(viewer('subscriber', { subscribed: true, heldTier: gold, requiredTier: silver })),
  true,
  'Gold outranks a Silver gate',
)
assert.equal(
  isUnlocked(viewer('subscriber', { subscribed: false, heldTier: gold, requiredTier: silver })),
  false,
  'holding a tier without an active subscription opens nothing',
)

// A gate naming a tier that has since been deleted fails closed — the rank comparison
// has no position to work with, so only the exact tier id can open it. Pinned here as
// well as in `test-tier-access.ts` because this is the path a viewer actually meets.
assert.equal(
  isUnlocked(
    viewer('subscriber', {
      subscribed: true,
      heldTier: gold,
      requiredTier: { id: 'deleted', rank: null },
    }),
  ),
  false,
  'a vanished tier gate is not outranked',
)

// --- buyer: bought it, and nothing else -------------------------------------------
assert.equal(isUnlocked(viewer('buyer')), false)
assert.equal(isUnlocked(viewer('buyer', { purchased: true })), true)

// The rule most likely to be broken by a refactor, and the reason `buyer` keeps its
// own branch: the subscription arm opens with "not a subscriber video", which is true
// of every pay-per-view row. Fold the two together and this returns true — the
// catalogue renders the video unlocked and clickable while the player refuses it.
assert.equal(
  isUnlocked(viewer('buyer', { subscribed: true, heldTier: gold })),
  false,
  'a channel subscription does not include a pay-per-view video',
)
assert.equal(
  isUnlocked(viewer('buyer', { subscribed: true, heldTier: gold, requiredTier: silver })),
  false,
  'nor does a subscription that outranks an unrelated tier gate',
)

// --- the owner clears every gate on their own channel, without paying -------------
for (const visibility of ['public', 'subscriber', 'buyer', 'private'] as const) {
  assert.equal(
    isUnlocked(viewer(visibility, { isOwner: true })),
    true,
    `the creator can watch their own ${visibility} video`,
  )
}

// And specifically without the caller having to also report them as subscribed.
// `getChannelAccess` does report exactly that, but relying on it made "a creator can
// watch their own video" an invariant held a module away.
assert.equal(
  isUnlocked(viewer('subscriber', { isOwner: true, subscribed: false, requiredTier: gold })),
  true,
  'ownership alone clears a tier gate',
)

console.log('video unlock: all checks passed')
