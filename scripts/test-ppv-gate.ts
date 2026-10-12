/**
 * Integration check for the pay-per-view paywall, against the local Mongo in
 * MONGODB_URI.
 *
 * Run: npm run test:ppv-gate
 *
 * The sibling of `test-channel-gate.ts`, covering the fourth visibility: that
 * `requirePlayableVideo` refuses a `buyer` video to everyone except its creator and
 * the people who have bought it, and lets a buyer in the moment a purchase row exists.
 *
 * The load-bearing assertion is the one about a paying subscriber. Pay-per-view and
 * subscriber gating are alternatives rather than a ladder, which is a deliberate
 * product decision and exactly the kind a later "fix" quietly reverses — so it is
 * asserted here rather than left to a comment.
 *
 * No Stripe calls: the purchase row is written directly, the way `recordVideoPurchase`
 * writes it. Creates its own throwaway users/videos and deletes them again, so it is
 * safe to run against a dev database.
 */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { INTERACTION_ERRORS } from '../src/lib/interaction-errors.ts'
import { ChannelSubscriptionModel } from '../src/server/db/models/channel-subscription.ts'
import { MembershipTierModel } from '../src/server/db/models/membership-tier.ts'
import { UserModel } from '../src/server/db/models/user.ts'
import { VideoModel } from '../src/server/db/models/video.ts'
import { VideoPurchaseModel } from '../src/server/db/models/video-purchase.ts'
import { connectToDatabase } from '../src/server/db/mongoose.ts'
import { requirePlayableVideo } from '../src/server/lib/entitlement.ts'

const tag = `ppv-test-${Date.now()}`

/** The rejection `requirePlayableVideo` throws, or null when it let the viewer in. */
async function denial(videoId: string, viewerId: string | null): Promise<string | null> {
  try {
    await requirePlayableVideo(videoId, viewerId)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

async function main() {
  await connectToDatabase()

  const creator = await UserModel.create({
    email: `${tag}-creator@example.test`,
    googleId: `${tag}-creator`,
    name: 'PPV Test Creator',
    channelName: 'PPV Test Channel',
  })
  const viewer = await UserModel.create({
    email: `${tag}-viewer@example.test`,
    googleId: `${tag}-viewer`,
    name: 'PPV Test Viewer',
  })

  const paid = await VideoModel.create({
    title: `${tag} for sale`,
    url: 'http://example.test/for-sale.mp4',
    visibility: 'buyer',
    priceCents: 499,
    uploadedBy: creator._id,
  })
  // A second one, to prove a purchase buys a video rather than a channel.
  const alsoPaid = await VideoModel.create({
    title: `${tag} also for sale`,
    url: 'http://example.test/also-for-sale.mp4',
    visibility: 'buyer',
    priceCents: 299,
    uploadedBy: creator._id,
  })
  // The other paid state, to prove the two do not open each other.
  const premium = await VideoModel.create({
    title: `${tag} premium`,
    url: 'http://example.test/premium.mp4',
    visibility: 'subscriber',
    uploadedBy: creator._id,
  })
  // A `buyer` video that was never priced. It cannot be sold, so it must not be
  // watchable either — failing open here would give away what could not be bought.
  const unpriced = await VideoModel.create({
    title: `${tag} unpriced`,
    url: 'http://example.test/unpriced.mp4',
    visibility: 'buyer',
    uploadedBy: creator._id,
  })

  const paidId = String(paid._id)
  const alsoPaidId = String(alsoPaid._id)
  const premiumId = String(premium._id)
  const unpricedId = String(unpriced._id)
  const viewerId = String(viewer._id)
  const creatorId = String(creator._id)

  // Nobody watches a pay-per-view video for free, signed in or not.
  assert.equal(await denial(paidId, null), INTERACTION_ERRORS.purchaseRequired)
  assert.equal(await denial(paidId, viewerId), INTERACTION_ERRORS.purchaseRequired)
  assert.equal(
    await denial(unpricedId, viewerId),
    INTERACTION_ERRORS.purchaseRequired,
    'an unpriced pay-per-view video must fail closed',
  )

  // The creator never buys their own work, and the gate says so without a row.
  const owned = await requirePlayableVideo(paidId, creatorId)
  assert.equal(owned.purchased, true, 'the creator holds their own video by right')

  // A membership — even an active one, on the channel's top tier — buys the
  // `subscriber` videos and nothing else. This is the mutual-exclusivity decision.
  const tier = await MembershipTierModel.create({
    creatorId: creator._id,
    name: `${tag} gold`,
    priceCents: 999,
    rank: 9,
  })
  await ChannelSubscriptionModel.create({
    subscriberId: viewer._id,
    creatorId: creator._id,
    stripeCustomerId: 'cus_ppv_test',
    status: 'active',
    currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    tierId: tier._id,
    tierName: tier.name,
  })

  // The subscription works, on the video it is for...
  assert.equal(await denial(premiumId, viewerId), null, 'the subscription should open a premium video')
  // ...and buys nothing at all behind the pay-per-view one.
  assert.equal(
    await denial(paidId, viewerId),
    INTERACTION_ERRORS.purchaseRequired,
    'a subscription must not include a pay-per-view video',
  )

  // This is what `recordVideoPurchase` writes once Stripe reports the session paid.
  await VideoPurchaseModel.create({
    buyerId: viewer._id,
    creatorId: creator._id,
    videoId: paid._id,
    stripeSessionId: `cs_test_${tag}`,
    amountCents: 499,
    currency: 'usd',
  })

  const allowed = await requirePlayableVideo(paidId, viewerId)
  assert.equal(allowed.purchased, true)
  assert.equal(String(allowed.video.id), paidId)

  // A purchase buys one video, not the creator's catalogue.
  assert.equal(
    await denial(alsoPaidId, viewerId),
    INTERACTION_ERRORS.purchaseRequired,
    'buying one video must not unlock another',
  )

  // ...and not another creator's, either.
  const other = await UserModel.create({
    email: `${tag}-other@example.test`,
    googleId: `${tag}-other`,
    channelName: 'Someone Else',
  })
  const otherPaid = await VideoModel.create({
    title: `${tag} other for sale`,
    url: 'http://example.test/other.mp4',
    visibility: 'buyer',
    priceCents: 499,
    uploadedBy: other._id,
  })
  assert.equal(
    await denial(String(otherPaid._id), viewerId),
    INTERACTION_ERRORS.purchaseRequired,
    'a purchase on one channel must not unlock another',
  )

  // The purchase is permanent: there is no period to lapse, so letting the
  // subscription expire takes nothing away.
  await ChannelSubscriptionModel.updateOne(
    { subscriberId: viewer._id, creatorId: creator._id },
    { currentPeriodEnd: new Date(Date.now() - 86_400_000) },
  )
  assert.equal(
    await denial(paidId, viewerId),
    null,
    'a purchase outlives the subscription beside it',
  )
  assert.equal(
    await denial(premiumId, viewerId),
    INTERACTION_ERRORS.subscriptionRequired,
    'and the lapsed subscription still closes the premium video',
  )

  console.log('ppv gate: all checks passed')
}

main()
  .catch((err) => {
    console.error('ppv gate FAILED:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    // Best effort: a failed run should still not leave test rows behind.
    await Promise.all([
      UserModel.deleteMany({ email: new RegExp(`^${tag}-`) }),
      VideoModel.deleteMany({ title: new RegExp(`^${tag} `) }),
      MembershipTierModel.deleteMany({ name: new RegExp(`^${tag} `) }),
      ChannelSubscriptionModel.deleteMany({ stripeCustomerId: 'cus_ppv_test' }),
      VideoPurchaseModel.deleteMany({ stripeSessionId: new RegExp(`^cs_test_${tag}`) }),
    ]).catch(() => {})
    await mongoose.disconnect()
  })
