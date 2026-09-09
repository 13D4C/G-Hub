import { EmptyState } from '@/components/empty-state'
import { Card } from '@/components/ui/card'
import { VideoCard } from '@/components/video-card'
import { listVideos } from '@/server/functions/videos'
import { createFileRoute } from '@tanstack/react-router'
import { Waves } from 'lucide-react'

export const Route = createFileRoute('/')({
  loader: async () => {
    const videos = await listVideos()
    return { videos }
  },
  component: HomePage,
})

function HomePage() {
  const { videos } = Route.useLoaderData()

  return (
    <Card variant="glass" className="flex flex-col gap-10 p-6">
      <div>
        <h1 className="font-display text-3xl font-semibold text-white sm:text-4xl">All videos</h1>
      </div>

      {videos.length === 0 ? (
        <EmptyState
          icon={Waves}
          message="No videos yet — run the seed script to upload media and create records."
        />
      ) : (
        <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          {videos.map((video) => (
            <VideoCard key={video.id} video={video} />
          ))}
        </div>
      )}
    </Card>
  )
}
