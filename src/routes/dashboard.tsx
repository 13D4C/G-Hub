import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { BarChart3, Eye, Heart, Ticket, Users } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { Card } from '@/components/ui/card'
import { meQueryOptions } from '@/lib/auth'
import { formatPrice } from '@/lib/channels'
import { dashboardQueryOptions, formatCount } from '@/lib/dashboard'
import { formatDate } from '@/lib/utils'
import { VIDEO_VISIBILITY_LABELS } from '@/lib/video-visibility'
import { VISIBILITY_ICONS } from '@/lib/video-visibility-icons'
import type { CreatorDashboard } from '@/server/functions/dashboard'

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
    await context.queryClient.ensureQueryData(dashboardQueryOptions)
  },
  component: DashboardPage,
})

function DashboardPage() {
  const { data: viewer } = useQuery(meQueryOptions)
  const { data } = useQuery(dashboardQueryOptions)

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
            <EmptyState icon={BarChart3} message="Upload a video to start collecting stats." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                  <th className="px-5 py-3">Title</th>
                  <th className="px-5 py-3">Visibility</th>
                  <th className="px-5 py-3">Uploaded</th>
                  <th className="px-5 py-3 text-right">Views</th>
                  <th className="px-5 py-3 text-right">Likes</th>
                  <th className="px-5 py-3 text-right">Shares</th>
                  <th className="px-5 py-3 text-right">Tips</th>
                  <th className="px-5 py-3 text-right">Sales</th>
                </tr>
              </thead>
              <tbody>
                {data.videos.map((video) => (
                  <VideoRow key={video.id} video={video} currency={currency} />
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
      <span className="text-xs text-slate-500">{hint ?? ' '}</span>
    </Card>
  )
}

function VideoRow({
  video,
  currency,
}: {
  video: CreatorDashboard['videos'][number]
  currency: string
}) {
  const Icon = VISIBILITY_ICONS[video.visibility]

  return (
    <tr className="border-b border-slate-100 last:border-b-0">
      <td className="px-5 py-3 font-medium text-slate-900">
        <Link to="/video" search={{ id: video.id }} className="hover:underline">
          {video.title}
        </Link>
      </td>
      <td className="px-5 py-3">
        <span
          className={
            video.visibility === 'public'
              ? 'inline-flex items-center gap-1.5 text-sky-700'
              : 'inline-flex items-center gap-1.5 text-slate-500'
          }
        >
          {/* Through the shared map rather than a ternary chain. The chain that used
              to be here ended in an `else`, so a visibility it did not know about was
              silently drawn with the Private glyph beside its own label. */}
          <Icon className="size-3.5" />
          {VIDEO_VISIBILITY_LABELS[video.visibility]}
        </span>
      </td>
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
    </tr>
  )
}
