/**
 * Fold the old flat channel price into the membership-tier system, then drop it.
 *
 * Run: npm run migrate:channel-price          (dry run — prints the plan)
 *      npm run migrate:channel-price -- --apply
 *
 * A channel used to have two ways to sell the same videos: `user.subscriptionPriceCents`
 * and, later, `membershiptier`. Two prices for overlapping access is a bug waiting
 * to be reported, so tiers won and the flat price is gone from the schema.
 *
 * Simply deleting the field would silently take every such channel off sale, so this
 * converts instead, in three steps:
 *
 *  1. Every creator with a flat price and no live tier gets one, at that price, so
 *     the channel keeps selling exactly what it was selling.
 *  2. Entitled subscriptions with no `tierId` are pointed at that tier. They paid
 *     the flat price, so that new tier is precisely what they bought — and without
 *     this they would keep channel access but be locked out of every tier-gated
 *     video. Unpaid rows (`incomplete`, `canceled`, ...) are left alone: nothing was
 *     bought, and `startChannelCheckout` overwrites them on the next attempt.
 *  3. `subscriptionPriceCents` is unset on every user.
 *
 * Read and written through the raw driver, not the Mongoose model: the field is no
 * longer in the schema, so the model can neither see it nor unset it.
 *
 * Idempotent. After a successful run no user carries the field, so a second run
 * finds nothing to do.
 */
import mongoose from 'mongoose'
import { ChannelSubscriptionModel } from '../src/server/db/models/channel-subscription.ts'
import { MembershipTierModel } from '../src/server/db/models/membership-tier.ts'
import { connectToDatabase } from '../src/server/db/mongoose.ts'
import { isEntitled } from '../src/server/lib/entitlement-status.ts'

const apply = process.argv.includes('--apply')
/** What a converted flat price is called. Rank 0: it is the only rung there is. */
const DEFAULT_TIER_NAME = process.env.MIGRATE_TIER_NAME ?? 'Membership'

type LegacyUser = { _id: mongoose.Types.ObjectId; subscriptionPriceCents?: number }

async function main() {
  await connectToDatabase()
  const users = mongoose.connection.collection('users')

  const priced = (await users
    .find({ subscriptionPriceCents: { $gt: 0 } })
    .project({ subscriptionPriceCents: 1, channelCurrency: 1, channelName: 1 })
    .toArray()) as Array<LegacyUser & { channelCurrency?: string; channelName?: string }>

  const carryingField = await users.countDocuments({ subscriptionPriceCents: { $exists: true } })

  console.log(`Users still carrying subscriptionPriceCents: ${carryingField}`)
  console.log(`  ...of which priced above zero: ${priced.length}`)

  if (carryingField === 0) {
    console.log('\nNothing to migrate — the flat channel price is already gone.')
    return
  }

  // ---------------------------------------------------------------- plan
  const plan: Array<{ user: LegacyUser; priceCents: number; currency: string; label: string }> = []

  for (const user of priced) {
    const live = await MembershipTierModel.countDocuments({ creatorId: user._id, active: true })
    if (live > 0) {
      console.log(
        `  - ${user.channelName || user._id}: has ${live} tier(s) already; price dropped, no tier created.`,
      )
      continue
    }
    plan.push({
      user,
      priceCents: user.subscriptionPriceCents ?? 0,
      currency: user.channelCurrency || 'usd',
      label: String(user.channelName || user._id),
    })
  }

  for (const item of plan) {
    console.log(
      `  - ${item.label}: create tier "${DEFAULT_TIER_NAME}" at ${item.priceCents} ${item.currency}`,
    )
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to make these changes.')
    return
  }

  // ------------------------------------------------- 1 + 2: convert and adopt
  let adopted = 0
  for (const item of plan) {
    const tier = await MembershipTierModel.findOneAndUpdate(
      { creatorId: item.user._id, name: DEFAULT_TIER_NAME },
      {
        creatorId: item.user._id,
        name: DEFAULT_TIER_NAME,
        description: 'Access to this channel’s subscriber-only videos.',
        priceCents: item.priceCents,
        currency: item.currency,
        rank: 0,
        active: true,
      },
      { upsert: true, returnDocument: 'after' },
    ).lean()
    if (!tier) continue

    // Only rows that actually entitle someone. An unpaid row bought nothing, so
    // adopting it onto a tier would hand out access that was never paid for.
    const orphans = await ChannelSubscriptionModel.find({
      creatorId: item.user._id,
      tierId: null,
    })
      .select('status currentPeriodEnd')
      .lean()

    const entitledIds = orphans.filter((o) => isEntitled(o)).map((o) => o._id)
    if (entitledIds.length > 0) {
      await ChannelSubscriptionModel.updateMany(
        { _id: { $in: entitledIds } },
        { $set: { tierId: tier._id, tierName: tier.name } },
      )
      adopted += entitledIds.length
    }

    console.log(
      `  ✓ ${item.label}: tier ready, ${entitledIds.length} paying subscriber(s) moved onto it` +
        ` (${orphans.length - entitledIds.length} unpaid row(s) left alone)`,
    )
  }

  // ------------------------------------------------------------- 3: drop it
  const unset = await users.updateMany(
    { subscriptionPriceCents: { $exists: true } },
    { $unset: { subscriptionPriceCents: '' } },
  )

  console.log(
    `\nCreated/updated ${plan.length} tier(s), moved ${adopted} paying subscriber(s),` +
      ` unset subscriptionPriceCents on ${unset.modifiedCount} user(s).`,
  )
}

main()
  .catch((err) => {
    console.error('channel price migration FAILED:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await mongoose.disconnect()
  })
