/**
 * Integration check for the two collections the revenue dashboard adds, against the
 * local Mongo in MONGODB_URI.
 *
 * Run: npm run test:revenue-ledger
 *
 * The sibling of `test-watch-history.ts`. `test-revenue-series.ts` already covers the
 * arithmetic without a database; what can only be checked here is the half that
 * depends on Mongo actually behaving as the schemas claim:
 *
 * - `recordAdImpression` never throws, including on the duplicate-key path. It runs
 *   inside the same `Promise.all` as the `viewCount` increment in `getVideoById`, so
 *   a rejection would turn a successful playback into a 500 — the one way this
 *   feature can break something that already worked.
 * - The sparse unique index actually built, and dedupes a signed-in viewer without
 *   collapsing anonymous rows into one. That distinction is invisible in code review
 *   and silently freezes ad revenue if it is wrong.
 * - The invoice upsert is idempotent under a replayed webhook.
 * - A row with a known date groups into the month the aggregation says it does —
 *   the one assertion that would catch a typo in the `$year`/`$month` arguments.
 *
 * Creates its own throwaway users/videos/ads and deletes them again, so it is safe to
 * run against a dev database.
 */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { AdImpressionModel } from '../src/server/db/models/ad-impression.ts'
import { SubscriptionInvoiceModel } from '../src/server/db/models/subscription-invoice.ts'
import { UserModel } from '../src/server/db/models/user.ts'
import { VideoModel } from '../src/server/db/models/video.ts'
import { connectToDatabase } from '../src/server/db/mongoose.ts'
import { recordAdImpression } from '../src/server/lib/ad-impression.ts'
import { REVENUE_TIME_ZONE } from '../src/server/lib/revenue-series.ts'

/** A Mongoose video document as the repo-shaped `{ id, uploadedBy }` these now take. */
function ref(video: { _id: unknown; uploadedBy?: unknown }) {
  return {
    id: String(video._id),
    uploadedBy: video.uploadedBy ? String(video.uploadedBy) : null,
  }
}


const tag = `revenue-test-${Date.now()}`

async function main() {
  await connectToDatabase()

  // The indexes have to exist before the writes below, or the dedupe assertions pass
  // for the wrong reason. `syncIndexes` also surfaces a failed unique build as an
  // error here rather than as silently broken dedupe in production.
  await AdImpressionModel.syncIndexes()
  await SubscriptionInvoiceModel.syncIndexes()

  const creator = await UserModel.create({
    email: `${tag}-creator@example.test`,
    googleId: `${tag}-creator`,
    name: 'Revenue Test Creator',
    channelName: 'Revenue Test Channel',
  })
  const viewer = await UserModel.create({
    email: `${tag}-viewer@example.test`,
    googleId: `${tag}-viewer`,
    name: 'Revenue Test Viewer',
  })

  const video = await VideoModel.create({
    title: `${tag} video`,
    description: 'revenue ledger fixture',
    url: 'https://example.test/v.mp4',
    durationSeconds: 10,
    visibility: 'public',
    uploadedBy: creator._id,
  })
  const orphan = await VideoModel.create({
    title: `${tag} orphan`,
    description: 'a video with no uploader',
    url: 'https://example.test/o.mp4',
    durationSeconds: 10,
    visibility: 'public',
  })

  const adId = new mongoose.Types.ObjectId()
  const shownAt = new Date('2026-03-15T12:00:00Z')

  // --- ad impressions ---
  {
    // Twice for the same signed-in viewer, inside the same dedupe window.
    await recordAdImpression(String(viewer._id), ref(video), String(adId), shownAt)
    await recordAdImpression(String(viewer._id), ref(video), String(adId), shownAt)

    const rows = await AdImpressionModel.find({ creatorId: creator._id, viewerId: viewer._id })
    assert.equal(rows.length, 1, 'a repeat inside the window must not count twice')
    assert.equal(rows[0].dedupeKey !== undefined, true, 'a signed-in row carries a dedupe key')
  }

  {
    // Anonymous rows carry no dedupe key at all, so the sparse unique index must let
    // both through. If `dedupeKey` were stored as an explicit null this would be 1,
    // and every anonymous impression in the system would collapse into one row.
    await recordAdImpression(null, ref(video), String(adId), shownAt)
    await recordAdImpression(null, ref(video), String(adId), shownAt)

    const rows = await AdImpressionModel.find({ creatorId: creator._id, viewerId: null })
    assert.equal(rows.length, 2, 'anonymous impressions are each their own row')
  }

  {
    const before = await AdImpressionModel.countDocuments({ videoId: orphan._id })
    await recordAdImpression(String(viewer._id), ref(orphan), String(adId), shownAt)
    const after = await AdImpressionModel.countDocuments({ videoId: orphan._id })
    assert.equal(after, before, 'an impression on a creatorless video credits nobody')
  }

  {
    // The property that matters most: this must not be able to fail a playback.
    await assert.doesNotReject(
      // A deliberately invalid ad id: the create throws inside, and the caller must
      // still see a clean resolve.
      () => recordAdImpression(String(viewer._id), ref(video), 'not-an-object-id', shownAt),
      'recordAdImpression must swallow its own errors',
    )
  }

  // --- subscription invoices ---
  {
    const invoiceId = `in_${tag}`
    const paidAt = new Date('2026-03-20T08:30:00Z')
    const write = () =>
      SubscriptionInvoiceModel.updateOne(
        { stripeInvoiceId: invoiceId },
        {
          subscriberId: viewer._id,
          creatorId: creator._id,
          stripeSubscriptionId: `sub_${tag}`,
          amountPaidCents: 1500,
          currency: 'usd',
          billingReason: 'subscription_cycle',
          paidAt,
        },
        { upsert: true },
      )

    // The same invoice twice, as a retried webhook delivers it.
    await write()
    await write()

    const rows = await SubscriptionInvoiceModel.find({ creatorId: creator._id })
    assert.equal(rows.length, 1, 'a replayed webhook settles the same row, never a second')
    assert.equal(rows[0].amountPaidCents, 1500)
  }

  // --- the aggregation buckets on the date it claims to ---
  {
    const groups = await SubscriptionInvoiceModel.aggregate<{
      _id: { year: number; month: number; currency: string }
      cents: number
    }>([
      { $match: { creatorId: creator._id } },
      {
        $group: {
          _id: {
            year: { $year: { date: '$paidAt', timezone: REVENUE_TIME_ZONE } },
            month: { $month: { date: '$paidAt', timezone: REVENUE_TIME_ZONE } },
            currency: '$currency',
          },
          cents: { $sum: '$amountPaidCents' },
        },
      },
    ])

    assert.equal(groups.length, 1)
    assert.deepEqual(
      groups[0]._id,
      { year: 2026, month: 3, currency: 'usd' },
      'a March invoice groups into March, through the real pipeline',
    )
    assert.equal(groups[0].cents, 1500)
  }

  {
    const groups = await AdImpressionModel.aggregate<{
      _id: { year: number; month: number }
      count: number
    }>([
      { $match: { creatorId: creator._id } },
      {
        $group: {
          _id: {
            year: { $year: { date: '$shownAt', timezone: REVENUE_TIME_ZONE } },
            month: { $month: { date: '$shownAt', timezone: REVENUE_TIME_ZONE } },
          },
          count: { $sum: 1 },
        },
      },
    ])

    assert.equal(groups.length, 1)
    assert.deepEqual(groups[0]._id, { year: 2026, month: 3 })
    assert.equal(groups[0].count, 3, 'one deduped signed-in row plus two anonymous ones')
  }

  console.log('revenue ledger: all checks passed')
}

main()
  .catch((err) => {
    console.error('revenue ledger FAILED:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    // Best effort: a failed run should still not leave test rows behind.
    const users = await UserModel.find({ email: new RegExp(`^${tag}-`) })
      .select('_id')
      .lean()
      .catch(() => [])
    const userIds = users.map((u) => u._id)
    await Promise.all([
      AdImpressionModel.deleteMany({ creatorId: { $in: userIds } }),
      SubscriptionInvoiceModel.deleteMany({ creatorId: { $in: userIds } }),
      UserModel.deleteMany({ email: new RegExp(`^${tag}-`) }),
      VideoModel.deleteMany({ title: new RegExp(`^${tag} `) }),
    ]).catch(() => {})
    await mongoose.disconnect()
  })
