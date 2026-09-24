import { queryOptions } from '@tanstack/react-query'
import { getCreatorDashboard } from '@/server/functions/dashboard'
import { isTranscodeSettled } from '@/lib/transcode-status'

/**
 * Always the signed-in viewer's own numbers — the server takes no creator argument
 * — so the key needs no viewer id: signing out drops the cache with the session.
 */
/**
 * How often the table refetches while a video is still being transcoded.
 *
 * Five seconds is only tolerable because it is conditional: a creator who has just
 * uploaded is waiting on this, and the moment nothing is left encoding the timer stops
 * entirely. An unconditional interval here would re-run the whole dashboard — several
 * aggregations over a creator's ledger — forever, for a page that is usually idle.
 */
export const DASHBOARD_TRANSCODE_POLL_MS = 5_000

export const dashboardQueryOptions = queryOptions({
  queryKey: ['dashboard'],
  queryFn: () => getCreatorDashboard(),
  refetchInterval: (query) =>
    query.state.data?.videos.some((video) => !isTranscodeSettled(video.transcodeStatus))
      ? DASHBOARD_TRANSCODE_POLL_MS
      : false,
  // A backgrounded tab is nobody waiting.
  refetchIntervalInBackground: false,
})

/** Thousands separators, `en-US` fixed for the same reason as `formatPrice`. */
export function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}
