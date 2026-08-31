import { VideoPlayer } from '@/components/video-player'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
  component: VideoPage,
})

function VideoPage() {
  const { src } = Route.useSearch()

  return (
    <Card>
      <CardHeader>
        <CardTitle>Video demo</CardTitle>
      </CardHeader>
      <CardContent>
        <VideoPlayer src={src} />
      </CardContent>
    </Card>
  )
}
