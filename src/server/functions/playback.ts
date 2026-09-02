import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { connectToDatabase } from '@/server/db/mongoose'
import { VideoModel } from '@/server/db/models/video'
import { pickPrerollAd, type PrerollAd } from '@/server/lib/ad-decision'

const inputSchema = z.object({ videoId: z.string() })

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
export const getVideoById = createServerFn({ method: 'POST' })
  .validator(inputSchema)
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
