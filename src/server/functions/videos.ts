import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getUserId } from '@/server/auth/require-user'
import { connectToDatabase } from '@/server/db/mongoose'
import { VideoModel } from '@/server/db/models/video'
import { pickPrerollAd, type PrerollAd } from '@/server/lib/ad-decision'
import { requirePlayableVideo } from '@/server/lib/entitlement'

/**
 * Server functions only ever run on the server, so `mongoose` never reaches the
 * client bundle. Call these from a route loader or a React Query hook.
 */
export const listVideos = createServerFn({ method: 'GET' }).handler(async () => {
  await connectToDatabase()

  const videos = await VideoModel.find().sort({ createdAt: -1 }).limit(50).lean()

  return videos.map((v) => ({
    id: String(v._id),
    title: v.title,
    description: v.description,
    url: v.url,
    durationSeconds: v.durationSeconds,
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
  preroll: PrerollAd | null
}

/**
 * Return a video for playback plus a preroll ad to show before it.
 *
 * Public videos are playable by anyone; private ones need an active subscription,
 * which `requirePlayableVideo` enforces for playback and interactions alike. A
 * preroll is attached when the video has ads enabled, an active ad exists, and the
 * viewer is not a subscriber — paying is what turns the ads off.
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
      preroll,
    }
  })
