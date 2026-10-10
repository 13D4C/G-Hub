/**
 * How wide a video's audience is.
 *
 * Deliberately alone in a module with no imports: the Mongoose schema imports it
 * relatively (so `scripts/*.ts` can still load the model under plain `node
 * --experimental-strip-types`) and the client imports it through the `@/` alias.
 * One list, so the enum the database enforces and the buttons a creator sees cannot
 * drift apart.
 *
 * Ordered open to closed, which is also the order the pickers render. `buyer` sits
 * between `subscriber` and `private` because it is narrower than a channel-wide
 * subscription — it is sold one video at a time — but still on sale to anyone.
 */
export const VIDEO_VISIBILITIES = ['public', 'subscriber', 'buyer', 'private'] as const

export type VideoVisibility = (typeof VIDEO_VISIBILITIES)[number]

/**
 * `subscriber` and `buyer` are the two paywalled states, and they are alternatives
 * rather than a ladder: a subscription opens `subscriber` videos, and buying opens
 * one `buyer` video. Neither opens the other.
 *
 * `subscriber` used to be spelled `private`, which is why `private` now means
 * something else entirely; see `scripts/migrate-video-visibility.ts`.
 */
export const VIDEO_VISIBILITY_LABELS: Record<VideoVisibility, string> = {
  public: 'Public',
  subscriber: 'Subscribers',
  buyer: 'Pay-per-view',
  private: 'Private',
}

export const VIDEO_VISIBILITY_HINTS: Record<VideoVisibility, string> = {
  public: 'Anyone can watch, signed in or not.',
  subscriber: 'Active subscribers only. Pick a tier to narrow it further.',
  buyer: 'Anyone can buy this one video and keep it. A channel subscription does not include it.',
  private: 'Only you can watch. It stays out of every catalogue.',
}

/**
 * Whether this state is sold rather than given away — the two states a viewer can
 * be locked out of but shown, as opposed to `public` (open) and `private` (hidden).
 *
 * What a viewer has to *buy* differs between the two, so this answers "is there a
 * price on it", never "may this viewer watch". That question is
 * `requirePlayableVideo`'s alone.
 */
export function isPaywalled(visibility: VideoVisibility): boolean {
  return visibility === 'subscriber' || visibility === 'buyer'
}
