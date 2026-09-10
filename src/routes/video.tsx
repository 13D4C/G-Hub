import { EmptyState } from '@/components/empty-state'
import { VideoCard } from '@/components/video-card'
import { VideoComments } from '@/components/video-comments'
import { VideoInteractionBar } from '@/components/video-interaction-bar'
import { VideoPlayer } from '@/components/video-player'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { meQueryOptions } from '@/lib/auth'
import { INTERACTION_ERRORS } from '@/lib/interaction-errors'
import { commentsQueryOptions, interactionSummaryQueryOptions } from '@/lib/interactions'
import { formatDate } from '@/lib/utils'
import { getLockedVideo, getVideoById, listVideos } from '@/server/functions/videos'
import type { LockedVideo, PlaybackData, VideoChannel } from '@/server/functions/videos'
import { createFileRoute, Link } from '@tanstack/react-router'
import { CalendarDays, Droplets, Lock } from 'lucide-react'
import { z } from 'zod'

const videoSearchSchema = z.object({
  id: z.string().optional(),
})

/**
 * Playback, or the paywall that stands in for it.
 *
 * `getVideoById` rejects a premium video the viewer has not paid for, and that
 * rejection is the *expected* path for a locked video rather than an error — so it
 * is caught here and turned into a subscribe prompt. Any other rejection (a missing
 * video, a database outage) is left to propagate to the router's error boundary.
 */
async function loadPlayback(
  videoId: string,
): Promise<{ playback: PlaybackData | null; locked: LockedVideo | null }> {
  try {
    return { playback: await getVideoById({ data: { videoId } }), locked: null }
  } catch (error) {
    const message = error instanceof Error ? error.message.trim() : ''
    if (message !== INTERACTION_ERRORS.subscriptionRequired) throw error
    return { playback: null, locked: await getLockedVideo({ data: { videoId } }) }
  }
}

export const Route = createFileRoute('/video')({
  validateSearch: videoSearchSchema,
  loaderDeps: ({ search }) => ({ id: search.id }),
  loader: async ({ deps, context }) => {
    const videos = await listVideos()
    const { playback, locked } = deps.id
      ? await loadPlayback(deps.id)
      : { playback: null, locked: null }

    // Only warm the interaction caches for a video the viewer can actually watch —
    // the interaction handlers apply the same paywall and would reject in the loader.
    if (playback) {
      // Deliberately NOT returned as loader data: that would force interaction
      // mutations to invalidate the loader, handing <VideoPlayer> a fresh `preroll`
      // object and restarting the video mid-playback.
      const viewer = await context.queryClient.ensureQueryData(meQueryOptions)
      await Promise.all([
        context.queryClient.ensureQueryData(
          interactionSummaryQueryOptions(playback.video.id, viewer?.id ?? null),
        ),
        context.queryClient.ensureQueryData(commentsQueryOptions(playback.video.id)),
      ])
    }

    return { videos, playback, locked }
  },
  component: VideoPage,
})

function VideoPage() {
  const { videos, playback, locked } = Route.useLoaderData()
  const currentId = playback?.video.id ?? locked?.id
  const moreVideos = videos.filter((video) => video.id !== currentId)

  return (
    <Card
      variant="glass"
      className="grid grid-cols-1 gap-10 p-6 sm:p-6 lg:grid-cols-[minmax(0,1fr)_360px]"
    >
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
                  {playback.channel ? <ChannelByline channel={playback.channel} /> : null}
                </div>
                <p className="whitespace-pre-line text-sm text-slate-700">
                  {playback.video.description || 'No description provided.'}
                </p>
                <VideoInteractionBar videoId={playback.video.id} />
              </Card>

              <Card className="flex flex-col gap-4 p-5">
                <h2 className="font-display text-sm font-semibold tracking-wide text-slate-500 uppercase">
                  Comments
                </h2>
                <VideoComments videoId={playback.video.id} />
              </Card>
            </div>
          </>
        ) : locked ? (
          <Paywall locked={locked} />
        ) : (
          <EmptyState icon={Droplets} message="Pick a video from the list to start watching" />
        )}
      </div>

      <aside className="flex flex-col gap-3">
        <h2 className="font-display text-sm font-semibold tracking-wide text-slate-300 uppercase">
          More videos
        </h2>
        {moreVideos.length === 0 ? (
          <EmptyState icon={Droplets} message="Nothing else here yet" />
        ) : (
          moreVideos.map((video) => <VideoCard key={video.id} video={video} variant="list" />)
        )}
      </aside>
    </Card>
  )
}

/** Links a video back to the channel that published it. */
function ChannelByline({ channel }: { channel: VideoChannel }) {
  return (
    <>
      <span aria-hidden>·</span>
      <Link
        to="/channel"
        search={{ id: channel.creatorId }}
        className="font-semibold text-slate-600 underline-offset-4 hover:text-slate-900 hover:underline"
      >
        {channel.name}
      </Link>
    </>
  )
}

/**
 * What a viewer sees instead of the player when they have not paid for a premium
 * video. The call to action is the channel, not a generic "upgrade": this paywall is
 * one creator's, and the price lives on their page.
 */
function Paywall({ locked }: { locked: LockedVideo }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex aspect-video flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-white/20 bg-black/40 p-8 text-center">
        <Lock className="size-10 text-white/80" aria-hidden />
        <div className="flex flex-col gap-1">
          <p className="font-display text-lg font-semibold text-white">Premium video</p>
          <p className="text-sm text-slate-300">
            {locked.channel
              ? `Subscribe to ${locked.channel.name} to watch this.`
              : 'This video is not available.'}
          </p>
        </div>
        {locked.channel ? (
          <Button asChild className="rounded-full">
            <Link to="/channel" search={{ id: locked.channel.creatorId }}>
              View subscription options
            </Link>
          </Button>
        ) : null}
      </div>

      <h1 className="font-display text-xl font-semibold text-white sm:text-2xl">{locked.title}</h1>
      {locked.description ? (
        <Card className="p-5">
          <p className="whitespace-pre-line text-sm text-slate-700">{locked.description}</p>
        </Card>
      ) : null}
    </div>
  )
}
