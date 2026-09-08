import { EmptyState } from '@/components/empty-state'
import { Card } from '@/components/ui/card'
import { VideoPlayer } from '@/components/video-player'
import { VideoCard } from '@/components/video-card'
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
  loader: async ({ deps }) => {
    const videos = await listVideos()
    const playback = deps.id ? await getVideoById({ data: { videoId: deps.id } }) : null
    return { videos, playback }
  },
  component: VideoPage,
})

function formatUploadDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function VideoPage() {
  const { videos, playback } = Route.useLoaderData()
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

              <Card className="flex flex-col gap-3 p-5 shadow-lg">
                <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
                  <CalendarDays className="size-4" />
                  Uploaded {formatUploadDate(playback.video.createdAt)}
                </div>
                <p className="whitespace-pre-line text-sm text-slate-700">
                  {playback.video.description || 'No description provided.'}
                </p>
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
