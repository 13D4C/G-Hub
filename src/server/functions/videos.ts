import { createServerFn } from '@tanstack/react-start'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { VIDEO_ERRORS } from '@/lib/video-errors'
import { connectToDatabase } from '@/server/db/mongoose'
import { getUserId, requireUserId } from '@/server/auth/require-user'
import { UserModel } from '@/server/db/models/user'
import { VideoModel } from '@/server/db/models/video'
import { pickPrerollAd, type PrerollAd } from '@/server/lib/ad-decision'
import { uploadObject } from '@/server/storage/seaweed'
import { hasActiveChannelSubscription, requirePlayableVideo } from '@/server/lib/entitlement'

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
 * The browsable catalogue, seen through this viewer's entitlement.
 *
 * Premium videos are listed alongside public ones — that is the point of a paywall:
 * you can see what you would be buying. An *unlocked* premium video (the viewer
 * subscribes, or uploaded it) is a normal playable card, so paying for a channel
 * makes its videos watchable from here rather than only from the channel page.
 * `url` is the one real secret and is withheld from a locked row; playback still
 * goes through `getVideoById`, which re-checks.
 */
export const listVideos = createServerFn({ method: 'GET' }).handler(async () => {
  const viewerId = await getUserId()
  await connectToDatabase()

  const videos = await VideoModel.find().sort({ createdAt: -1 }).limit(50).lean()

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
  // per row, and through the shared predicate so the rule (a creator is entitled to
  // their own channel) is not restated here.
  const premiumCreators = [
    ...new Set(
      videos
        .filter((v) => v.visibility !== 'public' && v.uploadedBy)
        .map((v) => String(v.uploadedBy)),
    ),
  ]
  const entitlements = await Promise.all(
    premiumCreators.map(async (id) => [id, await hasActiveChannelSubscription(viewerId, id)] as const),
  )
  const entitledTo = new Map(entitlements)

  return videos.map((v) => {
    const creatorId = v.uploadedBy ? String(v.uploadedBy) : null
    const premium = v.visibility !== 'public'
    const unlocked = !premium || (!!creatorId && entitledTo.get(creatorId) === true)

    return {
      id: String(v._id),
      title: v.title,
      description: v.description,
      url: unlocked ? v.url : '',
      durationSeconds: v.durationSeconds,
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
  premium: boolean
  preroll: PrerollAd | null
}

/**
 * Return a video for playback plus a preroll ad to show before it.
 *
 * Public videos are open to everyone; premium ones (`visibility: 'private'`) require
 * an active subscription to the video's channel, and `requirePlayableVideo` throws
 * `subscriptionRequired` otherwise — the message the `/video` route turns into a
 * subscribe prompt. A subscriber watches that channel ad-free, which is the other
 * half of what they paid for.
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
      premium: video.visibility !== 'public',
      preroll,
    }
  })

const lockedVideoSchema = z.object({ videoId: z.string() })

export type LockedVideo = {
  id: string
  title: string
  description: string
  channel: VideoChannel | null
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
      .select('title description uploadedBy')
      .lean()
    if (!video) return null

    return {
      id: String(video._id),
      title: video.title,
      description: video.description,
      channel: await channelOf(video.uploadedBy),
    }
  })

export type MyVideo = {
  id: string
  title: string
  description: string
  url: string
  durationSeconds: number
  visibility: 'public' | 'private'
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
      visibility: v.visibility,
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
    const visibility = data.get('visibility') === 'private' ? 'private' : 'public'

    if (!(file instanceof File) || !file.type.startsWith('video/')) {
      throw new Error(VIDEO_ERRORS.invalidFile)
    }
    if (!title) {
      throw new Error(VIDEO_ERRORS.titleRequired)
    }

    await connectToDatabase()

    const body = new Uint8Array(await file.arrayBuffer())
    const key = `videos/${randomUUID()}-${file.name}`
    const url = await uploadObject({ key, body, contentType: file.type })

    const video = await VideoModel.create({
      title,
      description,
      url,
      visibility,
      uploadedBy: userId,
      // A premium video is the subscription's product; running an ad in front of it
      // as well would be selling the same minute twice.
      adsEnabled: visibility === 'public',
    })

    return { id: String(video._id) }
  })
