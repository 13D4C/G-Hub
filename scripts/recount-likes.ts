/**
 * Reconcile `video.likeCount` against the `videolikes` collection.
 *
 * `toggleVideoLike` writes the like row first and the denormalized counter second.
 * Without transactions (Mongo here is a standalone, not a replica set) a crash
 * between the two leaves a count that disagrees with the rows. This script is the way
 * back to truth, and it is idempotent — a clean run reports no corrections, which is
 * also how you verify the toggle's bookkeeping is right.
 *
 * Run:
 *   npm run recount-likes
 */
import { connectToDatabase } from '../src/server/db/mongoose.ts'
import { videoLikes } from '../src/server/data/index.ts'
import { VideoModel } from '../src/server/db/models/video.ts'

async function main() {
  await connectToDatabase()

  const trueCounts = await videoLikes.countByVideo()

  // Every video, not just those with likes: one whose last like was lost mid-write
  // would otherwise keep a stale positive count forever.
  const videos = await VideoModel.find().select('_id title likeCount').lean()

  const corrections = videos
    .map((video) => {
      const id = String(video._id)
      return { id, title: video.title, stored: video.likeCount ?? 0, actual: trueCounts.get(id) ?? 0 }
    })
    .filter((row) => row.stored !== row.actual)

  if (corrections.length === 0) {
    console.log(`All ${videos.length} video(s) already agree with the like rows. Nothing to fix.`)
    return
  }

  await VideoModel.bulkWrite(
    corrections.map((row) => ({
      updateOne: { filter: { _id: row.id }, update: { $set: { likeCount: row.actual } } },
    })),
  )

  for (const row of corrections) {
    console.log(`fixed ${row.title}: ${row.stored} -> ${row.actual}`)
  }
  console.log(`Corrected ${corrections.length} of ${videos.length} video(s).`)
}

main()
  .catch((err) => {
    console.error('Recount failed:', err)
    process.exitCode = 1
  })
  .finally(() => process.exit())
