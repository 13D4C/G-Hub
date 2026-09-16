import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { CloudUpload, Heart, Share2 } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { UploadVideoForm } from '@/components/upload-video-form'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { describeMutationError, meQueryOptions } from '@/lib/auth'
import { formatPrice } from '@/lib/channels'
import { myMembershipTiersQueryOptions } from '@/lib/membership-tiers'
import { formatDate, formatDuration } from '@/lib/utils'
import { myVideosQueryOptions } from '@/lib/videos'
import {
  VIDEO_PRICE_DEFAULT_CENTS,
  VIDEO_PRICE_MAX_CENTS,
  VIDEO_PRICE_MIN_CENTS,
  parseVideoPrice,
} from '@/lib/video-price'
import {
  VIDEO_VISIBILITIES,
  VIDEO_VISIBILITY_LABELS,
  type VideoVisibility,
} from '@/lib/video-visibility'
import { VISIBILITY_ICONS } from '@/lib/video-visibility-icons'
import { updateVideoAccess } from '@/server/functions/membership-tiers'
import type { MembershipTierView } from '@/server/functions/membership-tiers'
import type { MyVideo } from '@/server/functions/videos'

/** The three settings that move together on every save. See `VideoAccessControls`. */
type VideoAccessChange = {
  visibility: VideoVisibility
  tierId: string | null
  priceCents: number | null
}

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
                  <th className="px-5 py-3">Who can watch</th>
                  <th className="px-5 py-3">Required tier</th>
                  <th className="px-5 py-3">Price</th>
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
                      <VideoAccessControls video={video} tiers={tiers ?? []} field="visibility" />
                    </td>
                    <td className="px-5 py-3">
                      <VideoAccessControls video={video} tiers={tiers ?? []} field="tier" />
                    </td>
                    <td className="px-5 py-3">
                      <VideoAccessControls video={video} tiers={tiers ?? []} field="price" />
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
 * Change who can watch one already-uploaded video, and — when that is `subscriber` —
 * which membership tier it needs, or — when it is `buyer` — what it sells for.
 * Together these are the third acceptance criterion, and the reason gating is not a
 * one-shot decision made at upload time.
 *
 * Rendered as three cells of the same row but backed by one mutation, because the
 * settings constrain each other: the server clears the tier for anything that is not
 * `subscriber` and the price for anything that is not `buyer`, so sending them
 * separately could momentarily describe a video that is public *and* tier-gated, or a
 * pay-per-view one with no price. `field` picks which of the three this instance
 * draws, and every save carries all three.
 */
function VideoAccessControls({
  video,
  tiers,
  field,
}: {
  video: MyVideo
  tiers: Array<MembershipTierView>
  field: 'visibility' | 'tier' | 'price'
}) {
  const queryClient = useQueryClient()

  const save = useMutation({
    mutationFn: (next: {
      visibility: VideoVisibility
      tierId: string | null
      priceCents: number | null
    }) => updateVideoAccess({ data: { videoId: video.id, ...next } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: myVideosQueryOptions.queryKey }),
  })

  const error = save.isError ? (
    <span role="alert" className="text-xs text-destructive">
      {describeMutationError(save.error, 'Could not change who can watch this.')}
    </span>
  ) : null

  if (field === 'visibility') {
    const Icon = VISIBILITY_ICONS[video.visibility]
    return (
      <div className="flex flex-col gap-1">
        <span className="inline-flex items-center gap-1.5">
          <Icon
            className={
              video.visibility === 'public' ? 'size-3.5 text-sky-700' : 'size-3.5 text-slate-500'
            }
          />
          <select
            aria-label={`Who can watch ${video.title}`}
            value={video.visibility}
            disabled={save.isPending}
            onChange={(e) =>
              save.mutate({
                visibility: e.target.value as VideoVisibility,
                // Both carried across so switching away from a paid state and back
                // does not silently drop the tier or the price the creator had
                // already chosen. The server clears whichever does not apply.
                tierId: video.requiredTierId,
                priceCents: video.priceCents ?? VIDEO_PRICE_DEFAULT_CENTS,
              })
            }
            className="rounded-lg border border-slate-200 px-2 py-1 text-sm text-slate-900 outline-none focus:border-slate-400"
          >
            {VIDEO_VISIBILITIES.map((option) => (
              <option key={option} value={option}>
                {VIDEO_VISIBILITY_LABELS[option]}
              </option>
            ))}
          </select>
        </span>
        {error}
      </div>
    )
  }

  if (field === 'price') {
    // A price only means anything for a `buyer` video, the same way a tier only means
    // anything for a `subscriber` one.
    if (video.visibility !== 'buyer') {
      return <span className="text-xs text-slate-400">—</span>
    }
    // Keyed on the saved price so a save — or a flip away from `buyer` and back —
    // remounts the field with the new value as its initial state. The alternative,
    // re-seeding from an effect, is a second render for something that is really just
    // "this is a different field now".
    return <VideoPriceInput key={video.priceCents} video={video} save={save} />
  }

  // A tier only means anything for a `subscriber` video, so the cell says why it is
  // inert rather than offering a control that would be discarded on save.
  if (video.visibility !== 'subscriber') {
    return <span className="text-xs text-slate-400">—</span>
  }

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
        onChange={(e) =>
          save.mutate({
            visibility: 'subscriber',
            tierId: e.target.value || null,
            priceCents: video.priceCents,
          })
        }
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
      {error}
    </div>
  )
}

/**
 * The price cell: a text field rather than a select, because a price is typed.
 *
 * It saves on blur and on Enter rather than on every keystroke — a `<select>` has one
 * commit per interaction and this does not, and firing a mutation per character would
 * both hammer the server and let a half-typed "4" land as a real $0.04 price.
 *
 * Held as a major-unit string, parsed by the same `parseVideoPrice` the upload form
 * and the server schema use, so the three cannot disagree about what is payable. A
 * value that will not parse is never sent: the field says so and keeps the last saved
 * price on record.
 */
function VideoPriceInput({
  video,
  save,
}: {
  video: MyVideo
  save: ReturnType<typeof useMutation<unknown, Error, VideoAccessChange>>
}) {
  const saved = video.priceCents
  // Seeded once per mount; the call site's `key` is what brings a newly saved price
  // back in, so there is no effect here re-synchronising state with a prop.
  const [draft, setDraft] = useState(() => (saved === null ? '' : (saved / 100).toFixed(2)))

  const parsed = parseVideoPrice(draft)
  const commit = () => {
    if (parsed === null || parsed === saved) return
    save.mutate({ visibility: 'buyer', tierId: video.requiredTierId, priceCents: parsed })
  }

  return (
    <div className="flex flex-col gap-1">
      <input
        aria-label={`Price for ${video.title}`}
        inputMode="decimal"
        value={draft}
        disabled={save.isPending}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.currentTarget.blur()
          }
        }}
        className="w-24 rounded-lg border border-slate-200 px-2 py-1 text-sm text-slate-900 outline-none focus:border-slate-400"
      />
      {draft.trim() && parsed === null ? (
        <span className="text-xs text-destructive">
          {formatPrice(VIDEO_PRICE_MIN_CENTS, 'usd')}–{formatPrice(VIDEO_PRICE_MAX_CENTS, 'usd')}
        </span>
      ) : null}
      {save.isError ? (
        <span role="alert" className="text-xs text-destructive">
          {describeMutationError(save.error, 'Could not change the price.')}
        </span>
      ) : null}
    </div>
  )
}
