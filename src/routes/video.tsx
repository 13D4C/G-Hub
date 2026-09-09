import { VideoComments } from '@/components/video-comments'
import { VideoInteractionBar } from '@/components/video-interaction-bar'
import { VideoPlayer } from '@/components/video-player'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { meQueryOptions } from '@/lib/auth'
import { INTERACTION_ERRORS } from '@/lib/interaction-errors'
import { commentsQueryOptions, interactionSummaryQueryOptions } from '@/lib/interactions'
import { listVideos, getVideoById } from '@/server/functions/videos'
import { createFileRoute, Link } from '@tanstack/react-router'
import { z } from 'zod'

const videoSearchSchema = z.object({
  id: z.string().optional(),
})

export const Route = createFileRoute('/video')({
  validateSearch: videoSearchSchema,
  loaderDeps: ({ search }) => ({ id: search.id }),
  loader: async ({ deps, context }) => {
    const videos = await listVideos()

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

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>
            {playback ? playback.video.title : paywalled ? 'Subscribers only' : 'Pick a video'}
          </CardTitle>
          {playback && <CardDescription>{playback.video.description}</CardDescription>}
        </CardHeader>
        <CardContent>
          {playback ? (
            <VideoPlayer src={playback.video.url} preroll={playback.preroll} />
          ) : paywalled ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted-foreground">
                {INTERACTION_ERRORS.subscriptionRequired} Subscribers also watch without
                ads.
              </p>
              <Button asChild>
                <Link to="/billing">Go ad-free</Link>
              </Button>
            </div>
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
                    <p className="text-sm text-muted-foreground break-all">{v.url}</p>
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
