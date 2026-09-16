// Relative, `.ts`-suffixed imports for the same reason as `dashboard-totals.ts`:
// `scripts/test-video-unlock.ts` loads this under plain `node
// --experimental-strip-types`, which resolves neither tsconfig paths nor
// extensionless specifiers. Only other import-free modules may be added here —
// Mongoose would break that script.
import { tierUnlocks, type TierRef } from './tier-access.ts'
import type { VideoVisibility } from '../../lib/video-visibility.ts'

/**
 * The listing-side mirror of `requirePlayableVideo`: may this viewer play this row?
 *
 * This rule previously existed as two hand-maintained copies, in `listVideos` and in
 * the channel page's catalogue, spelled differently enough that checking they agreed
 * meant reading both. It is the paywall, so it is worth one module and a test that
 * does not need a database.
 *
 * The authority is still `requirePlayableVideo` — it re-checks on playback and it is
 * the only thing standing between a viewer and a `url`. This answers the cheaper
 * question a catalogue asks: whether to draw a lock. The two must agree, and the
 * tests pin the cases where a disagreement would be visible.
 */

export type UnlockInput = {
  visibility: VideoVisibility
  /** The creator, who clears every gate on their own channel without paying. */
  isOwner: boolean
  /** An active subscription to this video's channel, at any tier. */
  subscribed: boolean
  /** The tier the subscription buys, or null for a channel-level one. */
  heldTier: TierRef | null
  /** The tier this video demands, or null when a subscription alone opens it. */
  requiredTier: TierRef | null
  /** A recorded pay-per-view purchase of this video by this viewer. */
  purchased: boolean
}

/**
 * Whether the viewer described by `input` may play the video described by `input`.
 *
 * The owner short-circuit is stated here rather than inherited. Both call sites this
 * replaced relied on `getChannelAccess` returning `subscribed: true` for the creator,
 * which it does — but that made "a creator can watch their own video" an invariant
 * held one module away, and one of the two copies then restated `isOwner` anyway in
 * case it did not hold. Checking it once, first, is the same answer without the
 * distance.
 *
 * `buyer` needs its own branch and must keep it: the subscription rule below opens
 * with `visibility !== 'subscriber'`, which is true of every pay-per-view video, so
 * folding the two together would render a for-sale row unlocked and clickable while
 * the player correctly refused it. A subscription deliberately does not open a
 * `buyer` video — the creator priced it separately from the membership, and honouring
 * the subscription here would give away the thing they just put a price on.
 *
 * `private` is the opposite: nothing opens it but ownership, which the short-circuit
 * above has already answered. Returning false explicitly rather than trusting that
 * `visibleToViewerFilter` kept it out of the caller's query is the fail-closed way
 * round — a listing that forgets the filter draws a lock instead of leaking a url.
 */
export function isUnlocked(input: UnlockInput): boolean {
  if (input.isOwner) return true

  switch (input.visibility) {
    case 'public':
      return true
    case 'private':
      return false
    case 'buyer':
      return input.purchased
    case 'subscriber':
      return input.subscribed && tierUnlocks(input.heldTier, input.requiredTier)
  }
}
