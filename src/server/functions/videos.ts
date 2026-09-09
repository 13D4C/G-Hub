import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { connectToDatabase } from '@/server/db/mongoose'
import { getUserId } from '@/server/auth/require-user'
import { UserModel } from '@/server/db/models/user'
import { VideoModel } from '@/server/db/models/video'
import { pickPrerollAd, type PrerollAd } from '@/server/lib/ad-decision'
import { requirePlayableVideo } from '@/server/lib/entitlement'

/**
 * Server functions only ever run on the server, so `mongoose` never reaches the
 * client bundle. Call these from a route loader or a React Query hook.
 */

export type VideoChannel = {
  creatorId: string
  name: string
}

/**
 * The channel a video belongs to, or null for videos seeded before channels existed.
 *
 * Assumes the caller has already connected to the database.
 */
async function channelOf(creatorId: unknown): Promise<VideoChannel | null> {
  if (!creatorId) return null

  const creator = await UserModel.findById(creatorId).select('name channelName').lean()
  if (!creator) return null

  return {
    creatorId: String(creator._id),
    name: creator.channelName || creator.name || 'Untitled channel',
  }
}

/** The browsable catalogue: public videos only, so the list itself is not a paywall. */
export const listVideos = createServerFn({ method: 'GET' }).handler(async () => {
  await connectToDatabase()

  const videos = await VideoModel.find({ visibility: 'public' })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean()

  // One `$in` for every creator on the page rather than a lookup per row — the same
  // shape `listComments` uses for author names, and for the same reason.
  const creatorIds = [...new Set(videos.map((v) => String(v.creatorId)).filter(Boolean))]
  const creators = await UserModel.find({ _id: { $in: creatorIds } })
    .select('name channelName')
    .lean()
  const channelById = new Map(
    creators.map((c) => [
      String(c._id),
      { creatorId: String(c._id), name: c.channelName || c.name || 'Untitled channel' },
    ]),
  )

  return videos.map((v) => ({
    id: String(v._id),
    title: v.title,
    description: v.description,
    url: v.url,
    durationSeconds: v.durationSeconds,
    channel: channelById.get(String(v.creatorId)) ?? null,
  }))
})

const getVideoByIdSchema = z.object({ videoId: z.string() })

export type PlaybackData = {
  video: {
    id: string
    title: string
    description: string
    url: string
    durationSeconds: number
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
 * subscribe prompt. A subscriber's own channel plays ad-free, which is the other
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
      },
      channel: await channelOf(video.creatorId),
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
      .select('title description creatorId')
      .lean()
    if (!video) return null

    return {
      id: String(video._id),
      title: video.title,
      description: video.description,
      channel: await channelOf(video.creatorId),
    }
  })
