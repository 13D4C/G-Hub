import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { connectToDatabase } from '@/server/db/mongoose'
import { VideoModel } from '@/server/db/models/video'
import { pickPrerollAd, type PrerollAd } from '@/server/lib/ad-decision'

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
 * Return a public video for playback plus a preroll ad to show before it.
 *
 * Only `public` videos are playable (no subscription required). Private videos
 * throw. A preroll ad is attached when the video has ads enabled and an active
 * ad is available.
 */
export const getVideoById = createServerFn({ method: 'GET' })
  .validator(getVideoByIdSchema)
  .handler(async ({ data }): Promise<PlaybackData> => {
    await connectToDatabase()

    const video = await VideoModel.findById(data.videoId).lean()
    if (!video) {
      throw new Error('Video not found')
    }
    if (video.visibility !== 'public') {
      throw new Error('This video is not public')
    }

    const preroll = video.adsEnabled ? await pickPrerollAd() : null

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
