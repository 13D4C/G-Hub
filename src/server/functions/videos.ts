import { createServerFn } from '@tanstack/react-start'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { CHANNEL_ERRORS } from '@/lib/channel-errors'
import { VIDEO_ERRORS } from '@/lib/video-errors'
import { isSellablePrice } from '@/lib/video-price'
import { VIDEO_VISIBILITIES, type VideoVisibility } from '@/lib/video-visibility'
import { connectToDatabase } from '@/server/db/mongoose'
import { getUserId, requireUserId } from '@/server/auth/require-user'
import { MembershipTierModel } from '@/server/db/models/membership-tier'
import { UserModel } from '@/server/db/models/user'
import { VideoModel } from '@/server/db/models/video'
import { pickPrerollAd, type PrerollAd } from '@/server/lib/ad-decision'
import { uploadObject } from '@/server/storage/seaweed'
import { requirePlayableVideo, visibleToViewerFilter } from '@/server/lib/entitlement'
import { channelFrom, summarizeVideosForViewer } from '@/server/lib/video-summary'
import type { VideoChannel } from '@/lib/video-summary-types'

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

  const creator = await UserModel.findById(uploadedBy).select('name channelName channelCurrency').lean()
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
    await VideoModel.updateOne({ _id: video._id }, { $inc: { viewCount: 1 } })

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

export type MyVideo = {
  id: string
  title: string
  description: string
  url: string
  durationSeconds: number
  visibility: VideoVisibility
  /** The tier gating it, or null for "any active subscriber". */
  requiredTierId: string | null
  /** What it sells for, or null when it is not a `buyer` video. */
  priceCents: number | null
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
      priceCents: v.priceCents ?? null,
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
