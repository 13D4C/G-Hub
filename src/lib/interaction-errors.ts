/**
 * Messages the interaction server functions reject with. Mirrors
 * `src/lib/auth-errors.ts`: the client uses this to tell a deliberate rejection apart
 * from an unexpected server error, whose text (missing env vars, database outages,
 * ...) must never be rendered in the UI.
 */
export const INTERACTION_ERRORS = {
  videoNotFound: 'Video not found',
  // A private video is paywalled, not hidden: the point of the message is to tell the
  // viewer what to do about it. See `src/server/lib/entitlement.ts`.
  subscriptionRequired: 'This video requires an active subscription.',
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
