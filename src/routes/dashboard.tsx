import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { BarChart3, CloudUpload, Eye, Heart, Pencil, Ticket, Trash2, Users } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { UploadVideoForm } from '@/components/upload-video-form'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { meQueryOptions, describeMutationError } from '@/lib/auth'
import { formatPrice } from '@/lib/channels'
import { dashboardQueryOptions, formatCount } from '@/lib/dashboard'
import { myMembershipTiersQueryOptions } from '@/lib/membership-tiers'
import { formatDate, formatDuration } from '@/lib/utils'
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
import type { CreatorDashboard } from '@/server/functions/dashboard'
import { deleteVideo, updateVideoDetails } from '@/server/functions/videos'

type VideoAccessChange = {
  visibility: VideoVisibility
  tierId: string | null
  priceCents: number | null
}

/**
 * A creator's own numbers. Every account is a channel, so this route is the same
 * page for everyone and takes no id — the server answers for the session.
 */
export const Route = createFileRoute('/dashboard')({
  beforeLoad: async ({ context, location }) => {
    const user = await context.queryClient.ensureQueryData(meQueryOptions)
    if (!user) {
      throw redirect({ to: '/login', search: { redirect: location.pathname } })
    }
  },
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(dashboardQueryOptions),
      context.queryClient.ensureQueryData(myMembershipTiersQueryOptions),
    ])
  },
  component: DashboardPage,
})

function DashboardPage() {
  const { data: viewer } = useQuery(meQueryOptions)
  const { data } = useQuery(dashboardQueryOptions)
  const { data: tiers } = useQuery(myMembershipTiersQueryOptions)
  const [uploadOpen, setUploadOpen] = useState(false)

  if (!data) return <EmptyState icon={BarChart3} message="Loading your dashboard…" />

  const { totals, currency } = data

  return (
    <Card variant="glass" className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-3xl font-semibold text-white">{data.channelName}</h1>
          <p className="text-sm text-slate-300">
            {totals.videos === 0
              ? 'Nothing uploaded yet — your numbers start once you publish.'
              : `${formatCount(totals.videos)} video${totals.videos === 1 ? '' : 's'} published.`}
          </p>
        </div>

        <div className="flex items-center gap-4">
          {viewer ? (
            <Link
              to="/channel"
              search={{ id: viewer.id }}
              className="text-sm font-medium text-white/80 underline-offset-4 hover:text-white hover:underline"
            >
              {data.tiers.length > 0
                ? `${data.tiers.length} membership tier${data.tiers.length === 1 ? '' : 's'}, from ${formatPrice(
                    Math.min(...data.tiers.map((t) => t.priceCents)),
                    currency,
                  )}/month`
                : 'Add a membership tier →'}
            </Link>
          ) : null}

          <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
            <DialogTrigger asChild>
              <Button size="lg" className="gap-2">
                <CloudUpload className="size-4" />
                Upload video
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-3xl">
              <DialogHeader>
                <DialogTitle>Flush in a new video</DialogTitle>
              </DialogHeader>
              <UploadVideoForm onSuccess={() => setUploadOpen(false)} />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat icon={Eye} label="Views" value={formatCount(totals.views)} />
        <Stat
          icon={Heart}
          label="Likes"
          value={formatCount(totals.likes)}
          hint={`${formatCount(totals.shares)} shares`}
        />
        <Stat
          icon={Users}
          label="Subscribers"
          value={formatCount(totals.subscribers)}
          hint={
            totals.monthlyCents > 0
              ? `${formatPrice(totals.monthlyCents, currency)} / month`
              : undefined
          }
        />
        <Stat
          icon={Heart}
          label="Tips"
          value={formatPrice(totals.tipCents, currency)}
          hint={`${formatCount(totals.tipCount)} tip${totals.tipCount === 1 ? '' : 's'}`}
        />
        <Stat
          icon={Ticket}
          label="Sales"
          value={formatPrice(totals.saleCents, currency)}
          hint={`${formatCount(totals.saleCount)} pay-per-view sale${totals.saleCount === 1 ? '' : 's'}`}
        />
      </div>

      <Card className="overflow-hidden p-0">
        {data.videos.length === 0 ? (
          <div className="p-10">
            <EmptyState icon={CloudUpload} message="Upload a video to start collecting stats." />
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
                  <th className="px-5 py-3 text-right">Views</th>
                  <th className="px-5 py-3 text-right">Likes</th>
                  <th className="px-5 py-3 text-right">Shares</th>
                  <th className="px-5 py-3 text-right">Tips</th>
                  <th className="px-5 py-3 text-right">Sales</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {data.videos.map((video) => (
                  <VideoRow key={video.id} video={video} tiers={tiers ?? []} currency={currency} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Channel donations have no video to sit next to, so the rows above never add
          up to the tip total on their own — say so rather than let it look wrong. */}
      {totals.tipCents > 0 ? (
        <p className="text-xs text-slate-300">
          Tips sent from your channel page are counted in the total above, not in any row.
        </p>
      ) : null}
    </Card>
  )
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Eye
  label: string
  value: string
  hint?: string
}) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
        <Icon className="size-3.5" />
        {label}
      </span>
      <span className="font-display text-2xl font-semibold text-slate-900">{value}</span>
      <span className="text-xs text-slate-500">{hint ?? ' '}</span>
    </Card>
  )
}

function VideoRow({
  video,
  tiers,
  currency,
}: {
  video: CreatorDashboard['videos'][number]
  tiers: Array<MembershipTierView>
  currency: string
}) {
  return (
    <tr className="border-b border-slate-100 last:border-b-0">
      <td className="px-5 py-3 font-medium text-slate-900">
        <Link to="/video" search={{ id: video.id }} className="hover:underline">
          {video.title}
        </Link>
      </td>
      <td className="px-5 py-3">
        <VideoAccessControls video={video} tiers={tiers} field="visibility" />
      </td>
      <td className="px-5 py-3">
        <VideoAccessControls video={video} tiers={tiers} field="tier" />
      </td>
      <td className="px-5 py-3">
        <VideoAccessControls video={video} tiers={tiers} field="price" />
      </td>
      <td className="px-5 py-3 text-slate-600">{formatDuration(video.durationSeconds)}</td>
      <td className="px-5 py-3 text-slate-600">{formatDate(video.createdAt)}</td>
      <td className="px-5 py-3 text-right text-slate-600">{formatCount(video.viewCount)}</td>
      <td className="px-5 py-3 text-right text-slate-600">{formatCount(video.likeCount)}</td>
      <td className="px-5 py-3 text-right text-slate-600">{formatCount(video.shareCount)}</td>
      <td className="px-5 py-3 text-right text-slate-600">
        {video.tipCents > 0 ? formatPrice(video.tipCents, currency) : '—'}
      </td>
      <td className="px-5 py-3 text-right text-slate-600">
        {video.saleCount > 0 ? (
          <span title={`${formatCount(video.saleCount)} sold`}>
            {formatPrice(video.saleCents, currency)}
          </span>
        ) : (
          '—'
        )}
      </td>
      <td className="px-5 py-3">
        <div className="flex items-center justify-end gap-1.5">
          <EditVideoDialog video={video} />
          <DeleteVideoDialog video={video} />
        </div>
      </td>
    </tr>
  )
}

function EditVideoDialog({ video }: { video: CreatorDashboard['videos'][number] }) {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()

  const save = useMutation({
    mutationFn: (data: { title: string; description: string }) =>
      updateVideoDetails({ data: { videoId: video.id, ...data } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: dashboardQueryOptions.queryKey })
      setOpen(false)
    },
  })

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    save.mutate({
      title: String(form.get('title') ?? '').trim(),
      description: String(form.get('description') ?? '').trim(),
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon-sm" aria-label={`Edit ${video.title}`}>
          <Pencil className="size-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit video</DialogTitle>
          <DialogDescription>
            Change the title or description. Who can watch it and its price are set from the
            table, not here.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-title">Title</Label>
            <Input id="edit-title" name="title" defaultValue={video.title} maxLength={200} required />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-description">Description</Label>
            <Textarea
              id="edit-description"
              name="description"
              defaultValue={video.description}
              maxLength={5000}
              rows={4}
            />
          </div>

          {save.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {describeMutationError(save.error, 'Could not save your changes. Please try again.')}
            </p>
          ) : null}

          <Button type="submit" className="w-fit rounded-full" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeleteVideoDialog({ video }: { video: CreatorDashboard['videos'][number] }) {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()

  const remove = useMutation({
    mutationFn: () => deleteVideo({ data: { videoId: video.id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: dashboardQueryOptions.queryKey })
      setOpen(false)
    },
  })

  const soldSomething = video.saleCount > 0 || video.tipCents > 0

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="icon-sm"
          className="text-destructive hover:text-destructive"
          aria-label={`Delete ${video.title}`}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete "{video.title}"?</DialogTitle>
          <DialogDescription>
            This removes the video, its comments and its likes for good — there is no undoing
            this.
            {soldSomething
              ? ' Past purchases and tips on it stay on your books and still count toward your earnings above.'
              : null}
          </DialogDescription>
        </DialogHeader>

        {remove.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {describeMutationError(remove.error, 'Could not delete this video. Please try again.')}
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          <Button
            variant="destructive"
            className="w-fit rounded-full"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? 'Deleting…' : 'Delete video'}
          </Button>
          <DialogClose asChild>
            <Button variant="outline" className="w-fit rounded-full" disabled={remove.isPending}>
              Cancel
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function VideoAccessControls({
  video,
  tiers,
  field,
}: {
  video: CreatorDashboard['videos'][number]
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: dashboardQueryOptions.queryKey }),
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
    if (video.visibility !== 'buyer') {
      return <span className="text-xs text-slate-400">—</span>
    }
    return <VideoPriceInput key={video.priceCents} video={video} save={save} />
  }

  if (video.visibility !== 'subscriber') {
    return <span className="text-xs text-slate-400">—</span>
  }

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

function VideoPriceInput({
  video,
  save,
}: {
  video: CreatorDashboard['videos'][number]
  save: ReturnType<typeof useMutation<unknown, Error, VideoAccessChange>>
}) {
  const saved = video.priceCents
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
