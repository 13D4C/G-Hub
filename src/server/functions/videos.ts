import { createServerFn } from '@tanstack/react-start'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { CHANNEL_ERRORS } from '@/lib/channel-errors'
import { INTERACTION_ERRORS } from '@/lib/interaction-errors'
import { VIDEO_ERRORS } from '@/lib/video-errors'
import { isSellablePrice } from '@/lib/video-price'
import { VIDEO_VISIBILITIES, type VideoVisibility } from '@/lib/video-visibility'
import { recordAdImpression } from '@/server/lib/ad-impression'
import { connectToDatabase } from '@/server/db/mongoose'
import { getUserId, requireUserId } from '@/server/auth/require-user'
import { MembershipTierModel } from '@/server/db/models/membership-tier'
import { UserModel } from '@/server/db/models/user'
import { VideoModel } from '@/server/db/models/video'
import { VideoCommentModel } from '@/server/db/models/video-comment'
import { VideoLikeModel } from '@/server/db/models/video-like'
import { pickPrerollAd, type PrerollAd } from '@/server/lib/ad-decision'
import { deleteObject, keyFromPublicUrl, uploadObject } from '@/server/storage/seaweed'
import {
  loadSubscribedCreatorIds,
  requirePlayableVideo,
  visibleToViewerFilter,
  type ChannelAccess,
} from '@/server/lib/entitlement'
import { channelFrom, summarizeVideosForViewer } from '@/server/lib/video-summary'
import { recordWatch } from '@/server/lib/watch-history'
import type { VideoChannel, VideoSummary } from '@/lib/video-summary-types'

/**
 * Server functions only ever run on the server, so `mongoose` never reaches the
 * client bundle. Call these from a route loader or a React Query hook.
 */

/**
 * Re-exported so the components that render a byline keep importing it from here,
 * where it was defined until the catalogue row shape moved to `src/lib/` to stop the
 * card deriving its props from this module's return types.
 */
export type { VideoChannel }

/**
 * The channel a video belongs to, or null for videos uploaded before channels
 * existed. `uploadedBy` is the channel: a channel has no identity of its own.
 *
 * Assumes the caller has already connected to the database.
 */
async function channelOf(uploadedBy: unknown): Promise<VideoChannel | null> {
  if (!uploadedBy) return null

  const creator = await UserModel.findById(uploadedBy)
    .select('name channelName channelCurrency avatarUrl')
    .lean()
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
 * `subscriber` and `buyer` videos are listed alongside public ones — that is the point
 * of a paywall: you can see what you would be buying. An *unlocked* one (the viewer
 * subscribes, has bought it, or uploaded it) is a normal playable card, so paying
 * makes a video watchable from here rather than only from the page that sold it.
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

  return summarizeVideosForViewer(videos, viewerId)
})

export type SubscribedFeed = {
  hasSubscriptions: boolean
  videos: VideoSummary[]
}

export const listSubscribedVideos = createServerFn({ method: 'GET' }).handler(
  async (): Promise<SubscribedFeed> => {
    const viewerId = await requireUserId()
    await connectToDatabase()

    const subscriptions = await loadSubscribedCreatorIds(viewerId)
    if (subscriptions.length === 0) return { hasSubscriptions: false, videos: [] }

    const subscribedCreatorIds = subscriptions.map((s) => s.creatorId)
    const videos = await VideoModel.find({
      $and: [visibleToViewerFilter(viewerId), { uploadedBy: { $in: subscribedCreatorIds } }],
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean()

    const access = new Map<string, ChannelAccess>(
      subscriptions.map((s) => [s.creatorId, { subscribed: true, tierId: s.tierId, isOwner: false }]),
    )

    return {
      hasSubscriptions: true,
      videos: await summarizeVideosForViewer(videos, viewerId, access),
    }
  },
)

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
  /** True for `visibility: 'buyer'` — bought once, per video. */
  payPerView: boolean
  /**
   * True when this viewer holds this pay-per-view video — bought it, or uploaded it.
   *
   * Only ever true alongside `payPerView`: the other visibilities have their own
   * notion of access and report it through `subscribed`, so this is not a general
   * "may watch" flag. It is playing, so they may.
   */
  owned: boolean
  /** The tier that gates this video, empty when any subscriber may watch it. */
  requiredTierName: string
  preroll: PrerollAd | null
}

/**
 * Return a video for playback plus a preroll ad to show before it.
 *
 * Public videos are open to everyone; `subscriber` ones require an active
 * subscription to the video's channel, and one gated behind a membership tier
 * requires that tier or higher; a `buyer` one requires having bought that exact
 * video. `requirePlayableVideo` throws `subscriptionRequired`, `tierRequired` or
 * `purchaseRequired` otherwise — the three messages the `/video` route turns into a
 * subscribe, upgrade or buy prompt — and reports a `private` video as missing.
 * A subscriber of any tier watches that channel ad-free, which is the other half of
 * what they paid for; a `buyer` video carries no ad for anyone.
 */
export const getVideoById = createServerFn({ method: 'GET' })
  .validator(getVideoByIdSchema)
  .handler(async ({ data }): Promise<PlaybackData> => {
    const viewerId = await getUserId()
    await connectToDatabase()

    const { video, subscribed, purchased } = await requirePlayableVideo(data.videoId, viewerId)
    // A `buyer` video already has `adsEnabled: false`, so the preroll never reaches
    // someone who paid for this one video — `!subscribed` is simply not the clause
    // doing the work there.
    const preroll = video.adsEnabled && !subscribed ? await pickPrerollAd() : null

    // The one place a view is counted: this is the only handler that hands out a
    // playable `url`, so a locked video never scores a view and no other caller has
    // to remember to increment. `$inc` rather than a read-modify-write so concurrent
    // viewers cannot overwrite each other.
    //
    // The per-viewer record rides along here for the same reason — a watch the feed
    // can learn from is exactly a watch that was allowed to play. `recordWatch`
    // swallows its own errors, which is what makes it safe to pair with the increment
    // rather than risk a ranking signal failing a playback; and it writes nothing at
    // all for an anonymous viewer, so this stays one query for them as before.
    //
    // The ad impression rides along for a third reason, stronger than the other two:
    // this row is money. A client-callable endpoint for it would be a revenue-minting
    // one — anybody with a session could loop it and inflate their own earnings — so
    // choosing the ad and recording that it was chosen have to happen in the same
    // server-side breath. The cost is this handler's existing looseness: a re-run of
    // the `/video` loader counts again, bounded by a dedupe window for signed-in
    // viewers and not at all for anonymous ones. That is one reason ad revenue is
    // reported as an estimate rather than as settled money.
    await Promise.all([
      VideoModel.updateOne({ _id: video._id }, { $inc: { viewCount: 1 } }),
      recordWatch(viewerId, video),
      preroll ? recordAdImpression(viewerId, video, preroll.id) : null,
    ])

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
      payPerView: video.visibility === 'buyer',
      owned: purchased,
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
  /** Which kind of lock this is, so the paywall knows what to offer. */
  visibility: VideoVisibility
  /** The tier that would open it, empty when a plain subscription suffices. */
  requiredTierName: string
  /** What buying it costs. Null unless this is a `buyer` video. */
  priceCents: number | null
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
      .select('title description uploadedBy requiredTierId visibility priceCents')
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
      visibility: video.visibility as VideoVisibility,
      requiredTierName: await tierNameOf(video.requiredTierId),
      priceCents: video.visibility === 'buyer' ? (video.priceCents ?? null) : null,
    }
  })

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
    const requestedDuration = Number(String(data.get('durationSeconds') ?? '').trim())
    const durationSeconds =
      Number.isFinite(requestedDuration) && requestedDuration > 0
        ? Math.round(requestedDuration)
        : 0
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
    // The mirror of that rule for the other paid state. A price on anything but a
    // `buyer` video is dropped, and a `buyer` video without a usable one is refused
    // rather than saved: it would be a paywall its own checkout cannot open.
    //
    // Minor units on the wire — the form does the decimal parsing with
    // `parseVideoPrice`, so the only thing left to do here is disbelieve it.
    const requestedPrice = Number(String(data.get('priceCents') ?? '').trim())
    const priceCents =
      visibility === 'buyer' && Number.isInteger(requestedPrice) && isSellablePrice(requestedPrice)
        ? requestedPrice
        : null

    if (!(file instanceof File) || !file.type.startsWith('video/')) {
      throw new Error(VIDEO_ERRORS.invalidFile)
    }
    if (!title) {
      throw new Error(VIDEO_ERRORS.titleRequired)
    }
    // Checked before the upload, for the same reason the tier is: a rejected gate
    // must not leave an orphaned object in SeaweedFS.
    if (visibility === 'buyer' && priceCents === null) {
      throw new Error(VIDEO_ERRORS.invalidPrice)
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
      durationSeconds,
      visibility,
      requiredTierId,
      priceCents,
      uploadedBy: userId,
      // A `subscriber` video is the subscription's product, and a `buyer` one is the
      // purchase's; running an ad in front of either would be selling the same minute
      // twice. A private one has no audience to advertise to.
      adsEnabled: visibility === 'public',
    })

    return { id: String(video._id) }
  })

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

const updateVideoDetailsSchema = z.object({
  videoId: objectId,
  title: z.string().trim().min(1, VIDEO_ERRORS.titleRequired).max(200),
  description: z.string().trim().max(5000),
})

export const updateVideoDetails = createServerFn({ method: 'POST' })
  .validator(updateVideoDetailsSchema)
  .handler(async ({ data }): Promise<{ id: string; title: string; description: string }> => {
    const userId = await requireUserId()
    await connectToDatabase()

    const video = await VideoModel.findOneAndUpdate(
      { _id: data.videoId, uploadedBy: userId },
      { $set: { title: data.title, description: data.description } },
    ).lean()
    if (!video) throw new Error(INTERACTION_ERRORS.videoNotFound)

    return { id: String(video._id), title: data.title, description: data.description }
  })

const deleteVideoSchema = z.object({ videoId: objectId })

export const deleteVideo = createServerFn({ method: 'POST' })
  .validator(deleteVideoSchema)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const userId = await requireUserId()
    await connectToDatabase()

    const video = await VideoModel.findOneAndDelete({
      _id: data.videoId,
      uploadedBy: userId,
    }).lean()
    if (!video) throw new Error(INTERACTION_ERRORS.videoNotFound)

    await Promise.all([
      VideoCommentModel.deleteMany({ videoId: video._id }),
      VideoLikeModel.deleteMany({ videoId: video._id }),
    ])

    const key = keyFromPublicUrl(video.url)
    if (key) {
      try {
        await deleteObject(key)
      } catch (error) {
        console.error(`Failed to delete storage object for video ${data.videoId}:`, error)
      }
    }

    return { id: String(video._id) }
  })
