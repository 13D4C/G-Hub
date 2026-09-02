import { VideoPlayer } from '@/components/video-player'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { listVideos } from '@/server/functions/videos'
import { getVideoById } from '@/server/functions/playback'
import { createFileRoute, Link } from '@tanstack/react-router'
import { z } from 'zod'

const videoSearchSchema = z.object({
  id: z.string().optional(),
})

export const Route = createFileRoute('/video')({
  validateSearch: videoSearchSchema,
  loaderDeps: ({ search }) => ({ id: search.id }),
  loader: async ({ deps }) => {
    const videos = await listVideos()
    const playback = deps.id
      ? await getVideoById({ data: { videoId: deps.id } })
      : null
    return { videos, playback }
  },
  component: VideoPage,
})

function VideoPage() {
  const { videos, playback } = Route.useLoaderData()

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{playback ? playback.video.title : 'Pick a video'}</CardTitle>
          {playback && <CardDescription>{playback.video.description}</CardDescription>}
        </CardHeader>
        <CardContent>
          {playback ? (
            <VideoPlayer src={playback.video.url} preroll={playback.preroll} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Choose a public video below to start watching (free, with a short ad).
            </p>
          )}
        </CardContent>
      </Card>

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
