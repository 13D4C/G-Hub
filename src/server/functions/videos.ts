import { createServerFn } from '@tanstack/react-start'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { getUserId } from '@/server/auth/require-user'
import { VIDEO_ERRORS } from '@/lib/video-errors'
import { connectToDatabase } from '@/server/db/mongoose'
import { VideoModel } from '@/server/db/models/video'
import { pickPrerollAd, type PrerollAd } from '@/server/lib/ad-decision'
import { requireUserId } from '@/server/auth/require-user'
import { uploadObject } from '@/server/storage/seaweed'
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
    visibility: v.visibility,
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
    createdAt: string
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
        createdAt: video.createdAt.toISOString(),
      },
      preroll,
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

export const listMyVideos = createServerFn({ method: 'GET' }).handler(async (): Promise<MyVideo[]> => {
  const userId = await requireUserId()
  await connectToDatabase()

  const videos = await VideoModel.find({ uploadedBy: userId }).sort({ createdAt: -1 }).limit(100).lean()

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
    })

    return { id: String(video._id) }
  })
