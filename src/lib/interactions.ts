import { queryOptions } from '@tanstack/react-query'
import { getVideoInteractions, listComments } from '@/server/functions/interactions'

const COMMENT_PAGE_SIZE = 20

/**
 * Query keys for viewer interactions.
 *
 * Interaction data is deliberately NOT returned as `/video` loader data. The player
 * re-creates its video.js instance whenever `preroll` changes identity (see the
 * effect deps in `src/components/video-player.tsx`) and the loader builds a fresh
 * `preroll` object on every run — so invalidating the loader restarts playback.
 * Mutations invalidate these keys instead, which never re-runs a loader.
 */
export const interactionKeys = {
  /**
   * Prefix matching every viewer's summary for one video. Mutations invalidate with
   * this, so they never need to know who is watching.
   */
  summaryPrefix: (videoId: string) => ['interactions', 'summary', videoId] as const,
  /**
   * `viewerHasLiked` is per-viewer, so the identity belongs in the key — otherwise
   * signing out would leave the previous viewer's filled heart in the cache.
   */
  summary: (videoId: string, viewerId: string | null) =>
    ['interactions', 'summary', videoId, viewerId ?? 'anon'] as const,
  /** Comment DTOs are viewer-independent, so one entry serves every viewer. */
  comments: (videoId: string) => ['interactions', 'comments', videoId] as const,
}

export const interactionSummaryQueryOptions = (videoId: string, viewerId: string | null) =>
  queryOptions({
    queryKey: interactionKeys.summary(videoId, viewerId),
    queryFn: () => getVideoInteractions({ data: { videoId } }),
  })

export const commentsQueryOptions = (videoId: string) =>
  queryOptions({
    queryKey: interactionKeys.comments(videoId),
    queryFn: () => listComments({ data: { videoId, limit: COMMENT_PAGE_SIZE } }),
  })

/**
 * A comment timestamp, formatted identically on the server and in the browser.
 *
 * `toLocaleString()` would use Node's ICU default during SSR and the viewer's locale
 * after hydration, which is a guaranteed hydration mismatch on every comment.
 */
export function formatCommentTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}
