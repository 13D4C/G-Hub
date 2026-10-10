/**
 * Messages the interaction server functions reject with. Mirrors
 * `src/lib/auth-errors.ts`: the client uses this to tell a deliberate rejection apart
 * from an unexpected server error, whose text (missing env vars, database outages,
 * ...) must never be rendered in the UI.
 */
export const INTERACTION_ERRORS = {
  videoNotFound: 'Video not found',
  // Premium video, no active subscription to its channel. Distinct from
  // `videoNotFound` on purpose: a paywall the viewer can open is not a secret.
  subscriptionRequired: 'Subscribe to this channel to watch this video.',
  // Subscribed, but on a rung of the ladder below the one this video is gated
  // behind. Distinct from `subscriptionRequired` because the fix is different: this
  // viewer is already paying and needs to upgrade, not to subscribe.
  tierRequired: 'This video needs a higher membership tier.',
  // Pay-per-view video the viewer has not bought. Distinct from
  // `subscriptionRequired` because the fix is a one-off purchase rather than a
  // subscription — and a subscriber of this very channel gets this message too, since
  // the two paywalled states are alternatives rather than a ladder.
  purchaseRequired: 'Buy this video to watch it.',
  // Deliberately does not distinguish "gone" from "not yours" — never leak whether
  // another viewer's comment exists.
  commentNotFound: 'That comment no longer exists.',
} as const

/** Kept in sync with `body.maxlength` in `src/server/db/models/video-comment.ts`. */
export const COMMENT_MAX_LENGTH = 1000

const USER_FACING = new Set<string>(Object.values(INTERACTION_ERRORS))

export function isUserFacingInteractionError(message: string): boolean {
  return USER_FACING.has(message)
}
