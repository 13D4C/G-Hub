import { connectToDatabase } from '../../db/mongoose.ts'
import { VideoLikeModel } from '../../db/models/video-like.ts'
import type { Id, VideoLikeRepo } from '../types.ts'

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000
}

export const videoLikes: VideoLikeRepo = {
  async exists(videoId: Id, userId: Id): Promise<boolean> {
    await connectToDatabase()
    return (await VideoLikeModel.exists({ videoId, userId })) !== null
  },

  async remove(videoId: Id, userId: Id): Promise<boolean> {
    await connectToDatabase()
    return (await VideoLikeModel.findOneAndDelete({ videoId, userId }).lean()) !== null
  },

  async insert(videoId: Id, userId: Id): Promise<boolean> {
    await connectToDatabase()
    try {
      await VideoLikeModel.create({ videoId, userId })
      return true
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err
      return false
    }
  },

  async removeByVideo(videoId: Id): Promise<void> {
    await connectToDatabase()
    await VideoLikeModel.deleteMany({ videoId })
  },

  async countByVideo(): Promise<Map<Id, number>> {
    await connectToDatabase()
    const grouped = await VideoLikeModel.aggregate<{ _id: unknown; n: number }>([
      { $group: { _id: '$videoId', n: { $sum: 1 } } },
    ])
    return new Map(grouped.map((row) => [String(row._id), row.n]))
  },
}
