import { queryOptions } from '@tanstack/react-query'
import { getVideoTranscodeStatus, type VideoTranscodeStatus } from '@/server/functions/videos'
import { isTranscodeSettled } from '@/lib/transcode-status'

/**
 * Client-side glue for watching a transcode finish.
 *
 * Five seconds rather than the revenue page's thirty, and the difference is the point: those
 * figures are settled money nobody is sitting and watching, whereas a creator who has just
 * uploaded something is waiting on this exact answer.
 */
export const TRANSCODE_POLL_MS = 5_000

/**
 * Poll one video's transcode until it stops moving.
 *
 * Two things here are load-bearing rather than stylistic.
 *
 * First, it calls `getVideoTranscodeStatus` and never `getVideoById`. That other handler is
 * the only one that hands out a playable url, so it is also where a view is counted, a watch
 * record is written and an ad impression is minted. Polling it would inflate the view count
 * and the ad revenue on the `/revenue` page, every five seconds, per open tab.
 *
 * Second, `refetchInterval` is a function rather than a number, so the query turns its own
 * timer off the moment the answer can no longer change. A component that forgot to unmount,
 * or a status string from a newer deploy that this build does not recognise, would otherwise
 * poll a finished transcode forever — on the app's busiest route.
 */
export const transcodeStatusQueryOptions = (videoId: string, seed: VideoTranscodeStatus) =>
  queryOptions({
    queryKey: ['transcode-status', videoId] as const,
    queryFn: () => getVideoTranscodeStatus({ data: { videoId } }),
    refetchInterval: (query) =>
      isTranscodeSettled(query.state.data?.status) ? false : TRANSCODE_POLL_MS,
    // A backgrounded tab is nobody waiting.
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    /**
     * Seeded from loader data, which the route has already fetched. Without this the first
     * paint would either flash an empty state or pay for a request whose answer it was
     * handed a moment ago.
     */
    initialData: seed,
    staleTime: TRANSCODE_POLL_MS / 2,
  })
