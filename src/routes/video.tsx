import { VideoComments } from '@/components/video-comments'
import { VideoInteractionBar } from '@/components/video-interaction-bar'
import { VideoPlayer } from '@/components/video-player'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { meQueryOptions } from '@/lib/auth'
import { INTERACTION_ERRORS } from '@/lib/interaction-errors'
import { commentsQueryOptions, interactionSummaryQueryOptions } from '@/lib/interactions'
import { getLockedVideo, getVideoById, listVideos } from '@/server/functions/videos'
import type { LockedVideo, PlaybackData } from '@/server/functions/videos'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Lock } from 'lucide-react'
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

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{playback?.video.title ?? locked?.title ?? 'Pick a video'}</CardTitle>
          {playback ? (
            <CardDescription>{playback.video.description}</CardDescription>
          ) : locked ? (
            <CardDescription>{locked.description}</CardDescription>
          ) : null}
          {(playback?.channel ?? locked?.channel) ? (
            <ChannelByline channel={(playback?.channel ?? locked?.channel)!} />
          ) : null}
        </CardHeader>
        <CardContent>
          {playback ? (
            <VideoPlayer src={playback.video.url} preroll={playback.preroll} />
          ) : locked ? (
            <Paywall locked={locked} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Choose a public video below to start watching (free, with a short ad).
            </p>
          )}
        </CardContent>
        {playback && (
          <CardFooter>
            <VideoInteractionBar videoId={playback.video.id} />
          </CardFooter>
        )}
      </Card>

      {playback && (
        <Card>
          <CardHeader>
            <CardTitle>Comments</CardTitle>
          </CardHeader>
          <CardContent>
            <VideoComments videoId={playback.video.id} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Public videos</CardTitle>
          <CardDescription>
            {videos.length} record(s) from the `video` collection.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {videos.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No videos yet — run the seed script to upload media and create records.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {videos.map((v) => (
                <li key={v.id}>
                  <Link
                    to="/video"
                    search={{ id: v.id }}
                    className="block rounded-md border px-3 py-2 hover:bg-accent"
                  >
                    <p className="font-medium">{v.title}</p>
                    <p className="text-sm text-muted-foreground">
                      {v.channel?.name ?? 'No channel'}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function ChannelByline({ channel }: { channel: { creatorId: string; name: string } }) {
  return (
    <Link
      to="/channel"
      search={{ id: channel.creatorId }}
      className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
    >
      {channel.name}
    </Link>
  )
}

/**
 * What a viewer sees instead of the player when they have not paid for a premium
 * video. The call to action is the channel, not a generic "upgrade": this paywall is
 * one creator's, and the price lives on their page.
 */
function Paywall({ locked }: { locked: LockedVideo }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-md border border-dashed p-6">
      <p className="flex items-center gap-2 font-medium">
        <Lock className="size-4" aria-hidden />
        Premium video
      </p>
      <p className="text-sm text-muted-foreground">
        {locked.channel
          ? `Subscribe to ${locked.channel.name} to watch this.`
          : 'This video is not available.'}
      </p>
      {locked.channel ? (
        <Button asChild>
          <Link to="/channel" search={{ id: locked.channel.creatorId }}>
            View subscription options
          </Link>
        </Button>
      ) : null}
    </div>
  )
}
