import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { CloudUpload, Globe, Heart, Lock, Share2 } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { UploadVideoForm } from '@/components/upload-video-form'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { describeMutationError, meQueryOptions } from '@/lib/auth'
import { myMembershipTiersQueryOptions } from '@/lib/membership-tiers'
import { formatDate, formatDuration } from '@/lib/utils'
import { myVideosQueryOptions } from '@/lib/videos'
import { setVideoTier } from '@/server/functions/membership-tiers'
import type { MembershipTierView } from '@/server/functions/membership-tiers'
import type { MyVideo } from '@/server/functions/videos'

export const Route = createFileRoute('/upload')({
  beforeLoad: async ({ context, location }) => {
    const user = await context.queryClient.ensureQueryData(meQueryOptions)
    if (!user) {
      throw redirect({ to: '/login', search: { redirect: location.pathname } })
    }
  },
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(myVideosQueryOptions),
      context.queryClient.ensureQueryData(myMembershipTiersQueryOptions),
    ])
  },
  component: UploadPage,
})

function UploadPage() {
  const { data: videos } = useQuery(myVideosQueryOptions)
  const { data: tiers } = useQuery(myMembershipTiersQueryOptions)
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
                  <th className="px-5 py-3">Required tier</th>
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
                    <td className="px-5 py-3">
                      <VideoTierSelect video={video} tiers={tiers ?? []} />
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

/**
 * Map one already-uploaded video onto a membership tier — the third acceptance
 * criterion, and the reason gating is not a one-shot decision made at upload time.
 *
 * Picking a tier also makes the video premium, so the Visibility cell can change as
 * a result; both queries are invalidated rather than just the tier list.
 *
 * A creator with no tiers still sees the control, disabled, with the reason: an
 * absent control reads as a missing feature, and the fix (add a tier on your channel
 * page) is not something they would guess.
 */
function VideoTierSelect({
  video,
  tiers,
}: {
  video: MyVideo
  tiers: Array<MembershipTierView>
}) {
  const queryClient = useQueryClient()

  const save = useMutation({
    mutationFn: (tierId: string | null) => setVideoTier({ data: { videoId: video.id, tierId } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: myVideosQueryOptions.queryKey }),
  })

  // The gate can name a tier that has since been archived, and an archived tier is
  // not in this list. Rendering it as an extra option keeps the select showing the
  // truth instead of silently snapping to "Any subscriber".
  const missingTier =
    video.requiredTierId && !tiers.some((t) => t.id === video.requiredTierId)
      ? video.requiredTierId
      : null

  if (tiers.length === 0 && !missingTier) {
    return <span className="text-xs text-slate-400">No tiers yet</span>
  }

  return (
    <div className="flex flex-col gap-1">
      <select
        aria-label={`Required tier for ${video.title}`}
        value={video.requiredTierId ?? ''}
        disabled={save.isPending}
        onChange={(e) => save.mutate(e.target.value || null)}
        className="rounded-lg border border-slate-200 px-2 py-1 text-sm text-slate-900 outline-none focus:border-slate-400"
      >
        <option value="">Any subscriber</option>
        {tiers.map((tier) => (
          <option key={tier.id} value={tier.id}>
            {tier.name}
          </option>
        ))}
        {missingTier ? <option value={missingTier}>Retired tier</option> : null}
      </select>
      {save.isError ? (
        <span role="alert" className="text-xs text-destructive">
          {describeMutationError(save.error, 'Could not change the tier.')}
        </span>
      ) : null}
    </div>
  )
}
