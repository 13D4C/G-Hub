import { VideoPlayer } from '@/components/video-player'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { listVideos } from '@/server/functions/videos'
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

const videoSearchSchema = z.object({
  src: z
    .string()
    .url()
    .default('https://vjs.zencdn.net/v/oceans.mp4'),
})

export const Route = createFileRoute('/video')({
  validateSearch: videoSearchSchema,
  loader: () => listVideos(),
  component: VideoPage,
})

function VideoPage() {
  const { src } = Route.useSearch()
  const videos = Route.useLoaderData()

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Video demo</CardTitle>
        </CardHeader>
        <CardContent>
          <VideoPlayer src={src} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Videos in DB</CardTitle>
          <CardDescription>
            {videos.length} record(s) from the `video` collection via the `listVideos` server function.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {videos.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No videos yet — insert a document into the `video` collection.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {videos.map((v) => (
                <li key={v.id} className="rounded-md border px-3 py-2">
                  <p className="font-medium">{v.title}</p>
                  <p className="text-sm text-muted-foreground break-all">{v.url}</p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
