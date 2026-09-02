/**
 * Seed script: upload local mp4 files to SeaweedFS and create Mongo records.
 *
 * Drop files into:
 *   seed/videos/*.mp4   -> `video` collection (public, ads enabled)
 *   seed/ads/*.mp4      -> `ad` collection (active, skippable after 3s)
 *
 * Run (requires Node 24+ for native TypeScript + --env-file):
 *   node --env-file=.env --experimental-strip-types scripts/seed.ts
 *
 * Records are upserted by title, so re-running is safe.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { connectToDatabase } from '../src/server/db/mongoose.ts'
import { VideoModel } from '../src/server/db/models/video.ts'
import { AdModel } from '../src/server/db/models/ad.ts'
import { uploadObject } from '../src/server/storage/seaweed.ts'

function listMp4(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => extname(f).toLowerCase() === '.mp4')
    .map((f) => join(dir, f))
}

function titleFromFile(file: string): string {
  return basename(file, extname(file))
}

async function upload(prefix: string, file: string): Promise<string> {
  const key = `${prefix}/${basename(file)}`
  const url = await uploadObject({
    key,
    body: readFileSync(file),
    contentType: 'video/mp4',
  })
  console.log(`uploaded ${file} -> ${url}`)
  return url
}

async function main() {
  await connectToDatabase()

  const videoFiles = listMp4(join('seed', 'videos'))
  const adFiles = listMp4(join('seed', 'ads'))

  if (videoFiles.length === 0 && adFiles.length === 0) {
    console.log('No .mp4 files found in seed/videos or seed/ads. Nothing to do.')
    return
  }

  for (const file of videoFiles) {
    const title = titleFromFile(file)
    const url = await upload('videos', file)
    await VideoModel.findOneAndUpdate(
      { title },
      { title, url, visibility: 'public', adsEnabled: true },
      { upsert: true, new: true },
    )
    console.log(`video record ready: ${title}`)
  }

  for (const file of adFiles) {
    const title = titleFromFile(file)
    const url = await upload('ads', file)
    await AdModel.findOneAndUpdate(
      { title },
      { title, mediaUrl: url, skippableAfterSeconds: 3, active: true, weight: 1 },
      { upsert: true, new: true },
    )
    console.log(`ad record ready: ${title}`)
  }

  console.log('Seed complete.')
}

main()
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exitCode = 1
  })
  .finally(() => process.exit())
