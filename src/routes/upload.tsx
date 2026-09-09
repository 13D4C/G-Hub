import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { CloudUpload, Globe, Heart, Lock, Share2 } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { UploadVideoForm } from '@/components/upload-video-form'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { meQueryOptions } from '@/lib/auth'
import { formatDate, formatDuration } from '@/lib/utils'
import { myVideosQueryOptions } from '@/lib/videos'

export const Route = createFileRoute('/upload')({
  beforeLoad: async ({ context, location }) => {
    const user = await context.queryClient.ensureQueryData(meQueryOptions)
    if (!user) {
      throw redirect({ to: '/login', search: { redirect: location.pathname } })
    }
  },
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(myVideosQueryOptions)
  },
  component: UploadPage,
})

function UploadPage() {
  const { data: videos } = useQuery(myVideosQueryOptions)
  const [dialogOpen, setDialogOpen] = useState(false)

  return (
    <Card variant="glass" className="flex flex-col gap-6 p-6 sm:p-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-display text-3xl font-semibold text-white">Your videos</h1>

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button size="lg" className="gap-2">
              <CloudUpload className="size-4" />
              Upload video
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>Flush in a new video</DialogTitle>
            </DialogHeader>
            <UploadVideoForm onSuccess={() => setDialogOpen(false)} />
          </DialogContent>
        </Dialog>
      </div>

      <Card className="overflow-hidden p-0">
        {!videos || videos.length === 0 ? (
          <div className="p-10">
            <EmptyState
              icon={CloudUpload}
              message="You haven't uploaded anything yet — hit Upload video to get started."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                  <th className="px-5 py-3">Title</th>
                  <th className="px-5 py-3">Visibility</th>
                  <th className="px-5 py-3">Duration</th>
                  <th className="px-5 py-3">Uploaded</th>
                  <th className="px-5 py-3">Likes</th>
                  <th className="px-5 py-3">Shares</th>
                </tr>
              </thead>
              <tbody>
                {videos.map((video) => (
                  <tr key={video.id} className="border-b border-slate-100 last:border-b-0">
                    <td className="px-5 py-3 font-medium text-slate-900">{video.title}</td>
                    <td className="px-5 py-3">
                      <span
                        className={
                          video.visibility === 'public'
                            ? 'inline-flex items-center gap-1.5 text-sky-700'
                            : 'inline-flex items-center gap-1.5 text-slate-500'
                        }
                      >
                        {video.visibility === 'public' ? (
                          <Globe className="size-3.5" />
                        ) : (
                          <Lock className="size-3.5" />
                        )}
                        {video.visibility === 'public' ? 'Public' : 'Private'}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-slate-600">{formatDuration(video.durationSeconds)}</td>
                    <td className="px-5 py-3 text-slate-600">{formatDate(video.createdAt)}</td>
                    <td className="px-5 py-3 text-slate-600">
                      <span className="inline-flex items-center gap-1.5">
                        <Heart className="size-3.5" />
                        {video.likeCount}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-slate-600">
                      <span className="inline-flex items-center gap-1.5">
                        <Share2 className="size-3.5" />
                        {video.shareCount}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Card>
  )
}
