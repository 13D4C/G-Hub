/**
 * How wide a video's audience is.
 *
 * Deliberately alone in a module with no imports: the Mongoose schema imports it
 * relatively (so `scripts/*.ts` can still load the model under plain `node
 * --experimental-strip-types`) and the client imports it through the `@/` alias.
 * One list, so the enum the database enforces and the buttons a creator sees cannot
 * drift apart.
 *
 * Ordered open to closed, which is also the order the pickers render.
 */
export const VIDEO_VISIBILITIES = ['public', 'subscriber', 'private'] as const

export type VideoVisibility = (typeof VIDEO_VISIBILITIES)[number]

/**
 * `subscriber` is the paywalled state — the one a membership tier can narrow
 * further. It used to be spelled `private`, which is why `private` now means
 * something else entirely; see `scripts/migrate-video-visibility.ts`.
 */
export const VIDEO_VISIBILITY_LABELS: Record<VideoVisibility, string> = {
  public: 'Public',
  subscriber: 'Subscribers',
  private: 'Private',
}

export const VIDEO_VISIBILITY_HINTS: Record<VideoVisibility, string> = {
  public: 'Anyone can watch, signed in or not.',
  subscriber: 'Active subscribers only. Pick a tier to narrow it further.',
  private: 'Only you can watch. It stays out of every catalogue.',
}

/** Whether this state is the paywalled one, and so can carry a tier. */
export function isPaywalled(visibility: VideoVisibility): boolean {
  return visibility === 'subscriber'
}
