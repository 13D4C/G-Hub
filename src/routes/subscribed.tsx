import { createFileRoute, redirect } from '@tanstack/react-router'
import { Users } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { Card } from '@/components/ui/card'
import { VideoCard } from '@/components/video-card'
import { meQueryOptions } from '@/lib/auth'
import { listSubscribedVideos } from '@/server/functions/videos'

export const Route = createFileRoute('/subscribed')({
  beforeLoad: async ({ context, location }) => {
    const user = await context.queryClient.ensureQueryData(meQueryOptions)
    if (!user) {
      throw redirect({ to: '/login', search: { redirect: location.pathname } })
    }
  },
  loader: async () => listSubscribedVideos(),
  component: SubscribedPage,
})

function SubscribedPage() {
  const { hasSubscriptions, videos } = Route.useLoaderData()

  return (
    <Card variant="paper" className="flex flex-col gap-6 p-6">
      <h1 className="font-display text-2xl font-semibold text-slate-900">Subscribed</h1>
      {videos.length === 0 ? (
        <EmptyState
          icon={Users}
          message={
            hasSubscriptions
              ? 'Nothing new from your subscriptions yet.'
              : "You're not subscribed to any channels yet."
          }
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
