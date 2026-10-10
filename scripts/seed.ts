/**
 * Seed script: upload local mp4 files to SeaweedFS and create Mongo records.
 *
 * Drop files into:
 *   seed/videos/*.mp4   -> `video` collection (public, ads enabled)
 *   seed/premium/*.mp4  -> `video` collection (premium — subscribers only)
 *   seed/ads/*.mp4      -> `ad` collection (active, skippable after 3s)
 *
 * Every seeded video is assigned to one demo channel (SEED_CREATOR_EMAIL), so the
 * premium ones have a channel to be bought from. That account is password-less: it
 * exists to own videos, not to be signed into.
 *
 * Run (requires Node 24+ for native TypeScript + --env-file):
 *   node --env-file=.env --experimental-strip-types scripts/seed.ts
 *
 * Records are upserted by title, so re-running is safe.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { connectToDatabase } from '../src/server/db/mongoose.ts'
import { MembershipTierModel } from '../src/server/db/models/membership-tier.ts'
import { UserModel } from '../src/server/db/models/user.ts'
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

/**
 * The demo channel every seeded video belongs to, plus the membership tier that
 * sells access to its subscriber-only videos. Created on first run.
 *
 * A channel sells tiers and nothing else, so seeding a price means seeding a tier —
 * without one the seeded subscriber-only videos would be visible to nobody but the
 * demo creator, and the checkout flow would have nothing to demonstrate.
 *
 * `googleId` is set to a sentinel so the schema's conditional `passwordHash`
 * requirement does not fire: this account owns videos and is never signed into.
 */
async function ensureCreator() {
  const email = process.env.SEED_CREATOR_EMAIL ?? 'creator@g-hub.local'
  const name = process.env.SEED_CREATOR_NAME ?? 'Demo Channel'
  const priceCents = Number(process.env.SEED_CHANNEL_PRICE_CENTS ?? 499)
  const tierName = process.env.SEED_TIER_NAME ?? 'Membership'

  const creator = await UserModel.findOneAndUpdate(
    { email },
    {
      email,
      name,
      googleId: `seed:${email}`,
      channelName: name,
      channelDescription: 'Seeded demo channel for the subscription flow.',
      channelCurrency: 'usd',
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  )

  // Keyed on (creator, name) so re-seeding reprices the same tier rather than
  // stacking up duplicates, which the partial unique index would reject anyway.
  const tier = await MembershipTierModel.findOneAndUpdate(
    { creatorId: creator._id, name: tierName },
    { creatorId: creator._id, name: tierName, priceCents, currency: 'usd', rank: 0, active: true },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  )

  console.log(
    `channel ready: ${name} (${creator._id}) — tier "${tier.name}" at ${priceCents} cents/month`,
  )
  return creator
}

async function main() {
  await connectToDatabase()

  const videoFiles = listMp4(join('seed', 'videos'))
  const premiumFiles = listMp4(join('seed', 'premium'))
  const adFiles = listMp4(join('seed', 'ads'))

  if (videoFiles.length === 0 && premiumFiles.length === 0 && adFiles.length === 0) {
    console.log('No .mp4 files found in seed/videos, seed/premium or seed/ads. Nothing to do.')
    return
  }

  const creator = await ensureCreator()

  for (const [dir, visibility] of [
    ['videos', 'public'],
    // `subscriber`, not `private`: these are the paywalled samples, and `private`
    // now means the uploader alone. See `scripts/migrate-video-visibility.ts`.
    ['premium', 'subscriber'],
  ] as const) {
    for (const file of dir === 'videos' ? videoFiles : premiumFiles) {
      const title = titleFromFile(file)
      const url = await upload(dir, file)
      await VideoModel.findOneAndUpdate(
        { title },
        // Premium videos carry no preroll: the subscription is what replaces the ad.
        { title, url, visibility, adsEnabled: visibility === 'public', uploadedBy: creator._id },
        { upsert: true, returnDocument: 'after' },
      )
      console.log(`${visibility === 'public' ? 'video' : 'premium video'} record ready: ${title}`)
    }
  }

  for (const file of adFiles) {
    const title = titleFromFile(file)
    const url = await upload('ads', file)
    await AdModel.findOneAndUpdate(
      { title },
      { title, mediaUrl: url, skippableAfterSeconds: 3, active: true, weight: 1 },
      { upsert: true, returnDocument: 'after' },
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
