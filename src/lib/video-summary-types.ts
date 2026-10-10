import type { FeedReason } from './feed-reason.ts'
import type { VideoVisibility } from './video-visibility.ts'

/**
 * The shape of one video in a browsable list — the catalogue row, as opposed to the
 * playback payload.
 *
 * Kept in `src/lib/` rather than beside the server function that builds it because
 * the card renders it. `video-card.tsx` used to derive its props with
 * `Awaited<ReturnType<typeof listVideos>>[number]`, importing a Mongoose-backed
 * module for a type and relying on `import type` being erased to keep the bundle
 * clean. That works, but it makes the component's props whatever that handler
 * happens to return, so a change to the query silently retypes the UI and the error
 * surfaces in the component rather than at the call site. Naming the contract here
 * lets both sides be checked against it instead.
 *
 * Only import-free modules may be imported here — this file is reachable from the
 * client bundle and from `scripts/*.ts` under bare node.
 */

export type VideoChannel = {
  creatorId: string
  name: string
  /** What this creator prices in, so the tip dialog offers the right symbol. */
  currency: string
  avatarUrl: string
}

export type VideoSummary = {
  id: string
  title: string
  description: string
  /**
   * Empty for a row this viewer may not play. The url is the one real secret in this
   * shape; everything else is shop-window copy that a locked card still needs.
   */
  url: string
  durationSeconds: number
  visibility: VideoVisibility
  /** `visibility: 'subscriber'` — opened by a subscription, at a high enough tier. */
  premium: boolean
  /** `visibility: 'buyer'` — sold once, per video, and kept. */
  payPerView: boolean
  /** What it costs, for the price on a locked card. Null when it is not for sale. */
  priceCents: number | null
  /** False when this viewer may not play it, which is what draws the lock. */
  unlocked: boolean
  channel: VideoChannel | null
  /**
   * Why the personalized feed surfaced this row, for the line above the title.
   *
   * Optional, and absent on every row `listVideos` returns — the plain catalogue
   * makes no claim about why a video is in it. That optionality is what lets one
   * card component render both surfaces.
   */
  reason?: FeedReason
}
