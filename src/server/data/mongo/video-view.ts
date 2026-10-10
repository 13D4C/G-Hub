import { connectToDatabase } from '../../db/mongoose.ts'
import { VideoViewModel } from '../../db/models/video-view.ts'
import type { Id, VideoViewRepo, WatchSignal } from '../types.ts'

export const videoViews: VideoViewRepo = {
  async recordWatch(viewerId: Id, videoId: Id, creatorId: Id | null): Promise<void> {
    await connectToDatabase()
    await VideoViewModel.updateOne(
      { viewerId, videoId },
      {
        $inc: { watchCount: 1 },
        $set: { lastWatchedAt: new Date(), creatorId },
      },
      { upsert: true },
    )
  },

  async recentByViewer(viewerId: Id, limit: number): Promise<WatchSignal[]> {
    await connectToDatabase()
    const rows = await VideoViewModel.find({ viewerId })
      .sort({ lastWatchedAt: -1 })
      .limit(limit)
      .select('videoId creatorId watchCount')
      .lean()

    return rows.map((row) => ({
      videoId: String(row.videoId),
      creatorId: row.creatorId ? String(row.creatorId) : null,
      watchCount: row.watchCount || 1,
    }))
  },
}
