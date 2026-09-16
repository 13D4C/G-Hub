/**
 * Why the personalized feed surfaced a row, and the label that says so.
 *
 * Deliberately alone in a module with no imports, for the same reason as
 * `video-visibility.ts`: `scripts/test-feed-ranking.ts` loads it under plain `node
 * --experimental-strip-types`, which resolves neither the `@/` alias nor Mongoose,
 * while `video-card.tsx` imports it through the alias. One list, so the reason the
 * scorer assigns and the sentence a viewer reads cannot drift apart.
 *
 * Ordered most to least specific, which is also the order `rankFeed` tests them in:
 * a subscribed creator's upload is a better explanation than "you watched this
 * channel", which is better than "lots of people are watching".
 */
export const FEED_REASONS = ['subscription', 'affinity', 'trending', 'new'] as const

export type FeedReason = (typeof FEED_REASONS)[number]

/**
 * The line rendered above a feed card's title, or an empty string for no line.
 *
 * `new` is the absence of a reason rather than a reason of its own — a video that
 * is merely recent has nothing to explain — so it renders nothing. Callers should
 * branch on this return value rather than on the reason itself, which keeps `new`
 * from needing a second condition at every call site.
 *
 * `channelName` is optional because `video.uploadedBy` is: a video uploaded before
 * channels existed has no creator to name. The subscription label falls back to a
 * channel-less phrasing rather than interpolating "undefined" into a sentence; the
 * affinity label cannot arise without a creator (affinity is counted per creator)
 * but is given the same fallback rather than relying on that from a distance.
 */
export function feedReasonLabel(reason: FeedReason, channelName?: string | null): string {
  switch (reason) {
    case 'subscription':
      return channelName ? `New from ${channelName}` : 'New upload'
    case 'affinity':
      return channelName ? `Because you watched ${channelName}` : 'Based on your viewing'
    case 'trending':
      return 'Trending'
    case 'new':
      return ''
  }
}
