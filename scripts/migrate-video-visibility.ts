/**
 * Move pre-existing paywalled videos onto the `subscriber` visibility.
 *
 * Run: npm run migrate:visibility
 *
 * `visibility` used to have two states, where `private` meant "premium: playable
 * only by an active subscriber". It now has three, and `private` means the uploader
 * alone. That is a change of *meaning*, not an addition — so every row written under
 * the old scheme says something different from what its creator intended, and a
 * video someone is paying for would quietly disappear from their catalogue.
 *
 * This rewrites those rows to `subscriber`, which is what they always meant.
 *
 * Idempotent: it matches only `private` rows, and after one successful run there are
 * none left to match. A creator who later marks a video private on purpose is
 * therefore safe — but only run this once, before anyone has done so. It prints the
 * count first and does nothing without `--apply`, so a dry run is the default.
 */
import mongoose from 'mongoose'
import { VideoModel } from '../src/server/db/models/video.ts'
import { connectToDatabase } from '../src/server/db/mongoose.ts'

const apply = process.argv.includes('--apply')

async function main() {
  await connectToDatabase()

  const affected = await VideoModel.countDocuments({ visibility: 'private' })
  const byState = await VideoModel.aggregate<{ _id: string; count: number }>([
    { $group: { _id: '$visibility', count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ])

  console.log('Current visibility counts:')
  for (const row of byState) console.log(`  ${row._id ?? '(unset)'}: ${row.count}`)

  if (affected === 0) {
    console.log('\nNothing to migrate — no `private` rows from the old scheme.')
    return
  }

  if (!apply) {
    console.log(
      `\n${affected} video(s) would be rewritten from 'private' to 'subscriber'.` +
        '\nRe-run with --apply to make the change.',
    )
    return
  }

  const result = await VideoModel.updateMany(
    { visibility: 'private' },
    { $set: { visibility: 'subscriber' } },
  )
  console.log(`\nRewrote ${result.modifiedCount} video(s) to 'subscriber'.`)
}

main()
  .catch((err) => {
    console.error('visibility migration FAILED:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await mongoose.disconnect()
  })
