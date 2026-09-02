import { createServerFn } from '@tanstack/react-start'
import { connectToDatabase } from '@/server/db/mongoose'
import { VideoModel } from '@/server/db/models/video'

/**
 * Example server function demonstrating the Mongoose connection.
 * Server functions only ever run on the server, so `mongoose` never reaches the
 * client bundle. Call this from a route loader or a React Query hook.
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
