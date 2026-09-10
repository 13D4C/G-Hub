import { createServerFn } from '@tanstack/react-start'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { CHANNEL_ERRORS } from '@/lib/channel-errors'
import { VIDEO_ERRORS } from '@/lib/video-errors'
import { VIDEO_VISIBILITIES, type VideoVisibility } from '@/lib/video-visibility'
import { connectToDatabase } from '@/server/db/mongoose'
import { getUserId, requireUserId } from '@/server/auth/require-user'
import { MembershipTierModel } from '@/server/db/models/membership-tier'
import { UserModel } from '@/server/db/models/user'
import { VideoModel } from '@/server/db/models/video'
import { pickPrerollAd, type PrerollAd } from '@/server/lib/ad-decision'
import { uploadObject } from '@/server/storage/seaweed'
import {
  getChannelAccess,
  loadTierRanks,
  requirePlayableVideo,
  tierRefOf,
  tierUnlocks,
  visibleToViewerFilter,
} from '@/server/lib/entitlement'

/**
 * Server functions only ever run on the server, so `mongoose` never reaches the
 * client bundle. Call these from a route loader or a React Query hook.
 */

export type VideoChannel = {
  creatorId: string
  name: string
}

function channelFrom(creator: { _id: unknown; name?: string; channelName?: string }): VideoChannel {
  return {
    creatorId: String(creator._id),
    name: creator.channelName || creator.name || 'Untitled channel',
  }
}

/**
 * The channel a video belongs to, or null for videos uploaded before channels
 * existed. `uploadedBy` is the channel: a channel has no identity of its own.
 *
 * Assumes the caller has already connected to the database.
 */
async function channelOf(uploadedBy: unknown): Promise<VideoChannel | null> {
  if (!uploadedBy) return null

  const creator = await UserModel.findById(uploadedBy).select('name channelName').lean()
  return creator ? channelFrom(creator) : null
}

/**
 * A gated video's tier name, for the copy that tells a viewer what would open it.
 *
 * Archived tiers are looked up too — a gate outlives the tier leaving the shop
 * window, and an unexplained lock is worse than one that names a tier no longer
 * sold.
 *
 * Assumes the caller has already connected to the database.
 */
async function tierNameOf(requiredTierId: unknown): Promise<string> {
  if (!requiredTierId) return ''

  const tier = await MembershipTierModel.findById(requiredTierId).select('name').lean()
  return tier?.name ?? ''
}

/**
 * The browsable catalogue, seen through this viewer's entitlement.
 *
 * `subscriber` videos are listed alongside public ones — that is the point of a
 * paywall: you can see what you would be buying. An *unlocked* one (the viewer
 * subscribes, or uploaded it) is a normal playable card, so paying for a channel
 * makes its videos watchable from here rather than only from the channel page.
 * `url` is the one real secret and is withheld from a locked row; playback still
 * goes through `getVideoById`, which re-checks.
 *
 * `private` videos are the opposite case and are filtered out in the query: they are
 * not being sold, so listing one would leak its title to advertise something nobody
 * can buy. The uploader still sees their own.
 */
export const listVideos = createServerFn({ method: 'GET' }).handler(async () => {
  const viewerId = await getUserId()
  await connectToDatabase()

  const videos = await VideoModel.find(visibleToViewerFilter(viewerId))
    .sort({ createdAt: -1 })
    .limit(50)
    .lean()

  // One `$in` for every creator on the page rather than a lookup per row — the same
  // shape `listComments` uses for author names, and for the same reason.
  // Filter before stringifying: a video with no `uploadedBy` would otherwise become
  // the literal string "undefined", which survives `Boolean` and makes the `$in` a
  // CastError that takes the whole home page down.
  const creatorIds = [...new Set(videos.filter((v) => v.uploadedBy).map((v) => String(v.uploadedBy)))]
  const creators = await UserModel.find({ _id: { $in: creatorIds } })
    .select('name channelName')
    .lean()
  const channelById = new Map(creators.map((c) => [String(c._id), channelFrom(c)]))

  // Asked once per *channel* that actually sells something on this page, not once
  // per row, and through the shared helper so the rule (a creator is entitled to
  // their own channel) is not restated here.
  const premiumCreators = [
    ...new Set(
      videos
        .filter((v) => v.visibility === 'subscriber' && v.uploadedBy)
        .map((v) => String(v.uploadedBy)),
    ),
  ]
  const accessEntries = await Promise.all(
    premiumCreators.map(async (id) => [id, await getChannelAccess(viewerId, id)] as const),
  )
  const accessTo = new Map(accessEntries)

  // Every tier this page has to compare — the ones the viewer holds and the ones the
  // rows demand — resolved in one query rather than two per premium row.
  const ranks = await loadTierRanks([
    ...accessEntries.map(([, access]) => access.tierId),
    ...videos.map((v) => v.requiredTierId),
  ])

  return videos.map((v) => {
    const creatorId = v.uploadedBy ? String(v.uploadedBy) : null
    const visibility = v.visibility as VideoVisibility
    const premium = visibility === 'subscriber'
    const access = creatorId ? accessTo.get(creatorId) : undefined
    // Subscribed at all, and then high enough on the ladder — the same two-part rule
    // `requirePlayableVideo` applies when the viewer actually presses play. A
    // `private` row only survived the query for its owner, so it is always unlocked
    // by the time it gets here.
    const unlocked =
      !premium ||
      (!!access &&
        access.subscribed &&
        (access.isOwner ||
          tierUnlocks(tierRefOf(access.tierId, ranks), tierRefOf(v.requiredTierId, ranks))))

    return {
      id: String(v._id),
      title: v.title,
      description: v.description,
      url: unlocked ? v.url : '',
      durationSeconds: v.durationSeconds,
      visibility,
      premium,
      /** False when this viewer may not play it, which is what draws the lock. */
      unlocked,
      channel: creatorId ? (channelById.get(creatorId) ?? null) : null,
    }
  })
})

const getVideoByIdSchema = z.object({ videoId: z.string() })

export type PlaybackData = {
  video: {
    id: string
    title: string
    description: string
    url: string
    durationSeconds: number
    createdAt: string
  }
  channel: VideoChannel | null
  /** True when the viewer subscribes to this video's channel (or owns it). */
  subscribed: boolean
  visibility: VideoVisibility
  premium: boolean
  /** The tier that gates this video, empty when any subscriber may watch it. */
  requiredTierName: string
  preroll: PrerollAd | null
}

/**
 * Return a video for playback plus a preroll ad to show before it.
 *
 * Public videos are open to everyone; `subscriber` ones require an active
 * subscription to the video's channel, and one gated behind a membership tier
 * requires that tier or higher. `requirePlayableVideo` throws `subscriptionRequired`
 * or `tierRequired` otherwise — the two messages the `/video` route turns into a
 * subscribe prompt and an upgrade prompt — and reports a `private` video as missing.
 * A subscriber of any tier watches that channel ad-free, which is the other half of
 * what they paid for.
 */
export const getVideoById = createServerFn({ method: 'GET' })
  .validator(getVideoByIdSchema)
  .handler(async ({ data }): Promise<PlaybackData> => {
    const viewerId = await getUserId()
    await connectToDatabase()

    const { video, subscribed } = await requirePlayableVideo(data.videoId, viewerId)
    const preroll = video.adsEnabled && !subscribed ? await pickPrerollAd() : null

    return {
      video: {
        id: String(video._id),
        title: video.title,
        description: video.description,
        url: video.url,
        durationSeconds: video.durationSeconds,
        createdAt: video.createdAt.toISOString(),
      },
      channel: await channelOf(video.uploadedBy),
      subscribed,
      visibility: video.visibility as VideoVisibility,
      premium: video.visibility === 'subscriber',
      requiredTierName: await tierNameOf(video.requiredTierId),
      preroll,
    }
  })

const lockedVideoSchema = z.object({ videoId: z.string() })

export type LockedVideo = {
  id: string
  title: string
  description: string
  channel: VideoChannel | null
  /** The tier that would open it, empty when a plain subscription suffices. */
  requiredTierName: string
}

/**
 * The little a viewer may see about a video they cannot play: enough to name what is
 * behind the paywall and link to the channel that sells the key.
 *
 * Deliberately never returns `url`. Called by the `/video` route only after
 * `getVideoById` has already rejected, so it grants no access `getVideoById` denied.
 */
export const getLockedVideo = createServerFn({ method: 'GET' })
  .validator(lockedVideoSchema)
  .handler(async ({ data }): Promise<LockedVideo | null> => {
    await connectToDatabase()

    const video = await VideoModel.findById(data.videoId)
      .select('title description uploadedBy requiredTierId visibility')
      .lean()
    if (!video) return null
    // Unreachable today — the `/video` route only calls this after a paywall
    // rejection, and a private video reports as missing instead. Belt and braces, so
    // a future caller cannot turn this into the one endpoint that names a private
    // video to a stranger.
    if (video.visibility === 'private') return null

    return {
      id: String(video._id),
      title: video.title,
      description: video.description,
      channel: await channelOf(video.uploadedBy),
      requiredTierName: await tierNameOf(video.requiredTierId),
    }
  })

export type MyVideo = {
  id: string
  title: string
  description: string
  url: string
  durationSeconds: number
  visibility: VideoVisibility
  /** The tier gating it, or null for "any active subscriber". */
  requiredTierId: string | null
  likeCount: number
  shareCount: number
  createdAt: string
}

export const listMyVideos = createServerFn({ method: 'GET' }).handler(
  async (): Promise<MyVideo[]> => {
    const userId = await requireUserId()
    await connectToDatabase()

    const videos = await VideoModel.find({ uploadedBy: userId })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean()

    return videos.map((v) => ({
      id: String(v._id),
      title: v.title,
      description: v.description,
      url: v.url,
      durationSeconds: v.durationSeconds,
      visibility: v.visibility as VideoVisibility,
      requiredTierId: v.requiredTierId ? String(v.requiredTierId) : null,
      likeCount: v.likeCount ?? 0,
      shareCount: v.shareCount ?? 0,
      createdAt: v.createdAt.toISOString(),
    }))
  },
)

export const createVideo = createServerFn({ method: 'POST' })
  .validator((data: unknown) => {
    if (!(data instanceof FormData)) throw new Error('Invalid form submission')
    return data
  })
  .handler(async ({ data }): Promise<{ id: string }> => {
    const userId = await requireUserId()

    const file = data.get('file')
    const title = String(data.get('title') ?? '').trim()
    const description = String(data.get('description') ?? '').trim()
    // Anything unrecognised falls back to `public` rather than rejecting, matching
    // how this handler already treats every other field it reads off the form.
    const requested = String(data.get('visibility') ?? '')
    const visibility: VideoVisibility = (VIDEO_VISIBILITIES as readonly string[]).includes(
      requested,
    )
      ? (requested as VideoVisibility)
      : 'public'
    // Only meaningful on a `subscriber` upload; a tier sent alongside any other
    // visibility is dropped rather than honoured, so the two controls cannot
    // disagree in the database.
    const requestedTierId =
      visibility === 'subscriber' ? String(data.get('requiredTierId') ?? '').trim() : ''

    if (!(file instanceof File) || !file.type.startsWith('video/')) {
      throw new Error(VIDEO_ERRORS.invalidFile)
    }
    if (!title) {
      throw new Error(VIDEO_ERRORS.titleRequired)
    }

    await connectToDatabase()

    // Checked before the upload, not after: a rejected gate should not leave an
    // orphaned object in SeaweedFS. Must be the uploader's own live tier, or a
    // hand-built form could gate a video behind another creator's ladder.
    const requiredTierId = requestedTierId
      ? ((
          await MembershipTierModel.findOne({
            _id: requestedTierId,
            creatorId: userId,
            active: true,
          })
            .select('_id')
            .lean()
        )?._id ?? null)
      : null
    if (requestedTierId && !requiredTierId) throw new Error(CHANNEL_ERRORS.tierNotYours)

    const body = new Uint8Array(await file.arrayBuffer())
    const key = `videos/${randomUUID()}-${file.name}`
    const url = await uploadObject({ key, body, contentType: file.type })

    const video = await VideoModel.create({
      title,
      description,
      url,
      visibility,
      requiredTierId,
      uploadedBy: userId,
      // A `subscriber` video is the subscription's product; running an ad in front
      // of it as well would be selling the same minute twice. A private one has no
      // audience to advertise to.
      adsEnabled: visibility === 'public',
    })

    return { id: String(video._id) }
  })
