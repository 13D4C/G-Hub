import { EmptyState } from '@/components/empty-state'
import { VideoCard } from '@/components/video-card'
import { VideoComments } from '@/components/video-comments'
import { VideoInteractionBar } from '@/components/video-interaction-bar'
import { VideoPlayer } from '@/components/video-player'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { meQueryOptions } from '@/lib/auth'
import { INTERACTION_ERRORS } from '@/lib/interaction-errors'
import { commentsQueryOptions, interactionSummaryQueryOptions } from '@/lib/interactions'
import { formatDate } from '@/lib/utils'
import { listVideos, getVideoById } from '@/server/functions/videos'
import { createFileRoute } from '@tanstack/react-router'
import { CalendarDays, Droplets } from 'lucide-react'
import { z } from 'zod'

const videoSearchSchema = z.object({
  id: z.string().optional(),
})

export const Route = createFileRoute('/video')({
  validateSearch: videoSearchSchema,
  loaderDeps: ({ search }) => ({ id: search.id }),
  loader: async ({ deps, context }) => {
    const videos = await listVideos()
    const playback = deps.id ? await getVideoById({ data: { videoId: deps.id } }) : null

    let playback = null
    let paywalled = false
    if (deps.id) {
      try {
        playback = await getVideoById({ data: { videoId: deps.id } })
      } catch (err) {
        // The paywall is a page state, not a failure: it renders a subscribe CTA
        // below. Everything else (missing video, database down) still throws through
        // to the router's error boundary.
        if (
          !(err instanceof Error) ||
          err.message !== INTERACTION_ERRORS.subscriptionRequired
        ) {
          throw err
        }
        paywalled = true
      }
    }

    if (deps.id && playback) {
      // Warm the interaction caches so the counts and comments are server-rendered
      // (a non-suspense `useQuery` does not fetch during SSR). They are deliberately
      // NOT returned as loader data: that would force interaction mutations to
      // invalidate the loader, handing <VideoPlayer> a fresh `preroll` object and
      // restarting the video mid-playback.
      const viewer = await context.queryClient.ensureQueryData(meQueryOptions)
      await Promise.all([
        context.queryClient.ensureQueryData(
          interactionSummaryQueryOptions(deps.id, viewer?.id ?? null),
        ),
        context.queryClient.ensureQueryData(commentsQueryOptions(deps.id)),
      ])
    }

    return { videos, playback, paywalled }
  },
  component: VideoPage,
})

function VideoPage() {
  const { videos, playback, paywalled } = Route.useLoaderData()
  const currentId = playback?.video.id
  const moreVideos = videos.filter((video) => video.id !== currentId)

  return (
    <Card variant="glass" className="grid grid-cols-1 gap-10 p-6 sm:p-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex flex-col gap-4">
        {playback ? (
          <>
            <VideoPlayer src={playback.video.url} preroll={playback.preroll} />
            <div className="flex flex-col gap-4">
              <h1 className="font-display text-xl font-semibold text-white sm:text-2xl">
                {playback.video.title}
              </h1>

              <Card className="flex flex-col gap-3 p-5">
                <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
                  <CalendarDays className="size-4" />
                  Uploaded {formatDate(playback.video.createdAt)}
                </div>
                <p className="whitespace-pre-line text-sm text-slate-700">
                  {playback.video.description || 'No description provided.'}
                </p>
                <VideoInteractionBar videoId={playback.video.id} />
              </Card>

              <Card className="flex flex-col gap-4 p-5">
                <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-slate-500">
                  Comments
                </h2>
                <VideoComments videoId={playback.video.id} />
              </Card>
            </div>
          </>
        ) : (
          <EmptyState icon={Droplets} message="Pick a video from the list to start watching" />
        )}
      </div>

      <div className="flex flex-col gap-4">
        <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-slate-300">
          More videos
        </h2>
        {moreVideos.length === 0 ? (
          <p className="text-sm text-slate-300">Nothing else in the tank yet.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {moreVideos.map((video) => (
              <VideoCard key={video.id} video={video} variant="list" />
            ))}
          </div>
        )}
      </div>
    </Card>
  )
}
