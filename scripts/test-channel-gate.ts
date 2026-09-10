/**
 * Integration check for the channel paywall, against the local Mongo in MONGODB_URI.
 *
 * Run: npm run test:channel-gate
 *
 * `scripts/test-entitlement.ts` covers the predicate in isolation; this covers the
 * thing the predicate is *for* — that `requirePlayableVideo` denies a premium video
 * to a stranger and lets the same viewer in once an active subscription row exists,
 * which is the server-side half of "premium content becomes accessible immediately
 * upon successful subscription". No Stripe calls: the row is written directly, the
 * way `syncSubscription` writes it.
 *
 * Creates its own throwaway users/videos and deletes them again, so it is safe to
 * run against a dev database.
 */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { INTERACTION_ERRORS } from '../src/lib/interaction-errors.ts'
import { ChannelSubscriptionModel } from '../src/server/db/models/channel-subscription.ts'
import { UserModel } from '../src/server/db/models/user.ts'
import { VideoModel } from '../src/server/db/models/video.ts'
import { connectToDatabase } from '../src/server/db/mongoose.ts'
import { requirePlayableVideo } from '../src/server/lib/entitlement.ts'

const tag = `gate-test-${Date.now()}`

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
    name: 'Gate Test Creator',
    channelName: 'Gate Test Channel',
    subscriptionPriceCents: 499,
  })
  const viewer = await UserModel.create({
    email: `${tag}-viewer@example.test`,
    googleId: `${tag}-viewer`,
    name: 'Gate Test Viewer',
  })

  const free = await VideoModel.create({
    title: `${tag} free`,
    url: 'http://example.test/free.mp4',
    visibility: 'public',
    uploadedBy: creator._id,
  })
  const premium = await VideoModel.create({
    title: `${tag} premium`,
    url: 'http://example.test/premium.mp4',
    visibility: 'private',
    uploadedBy: creator._id,
  })

  const freeId = String(free._id)
  const premiumId = String(premium._id)
  const viewerId = String(viewer._id)
  const creatorId = String(creator._id)

  // A public video is open to everyone, signed in or not.
  assert.equal(await denial(freeId, null), null, 'anonymous should watch a public video')
  assert.equal(await denial(freeId, viewerId), null, 'viewer should watch a public video')

  // A premium video is not.
  assert.equal(await denial(premiumId, null), INTERACTION_ERRORS.subscriptionRequired)
  assert.equal(await denial(premiumId, viewerId), INTERACTION_ERRORS.subscriptionRequired)

  // The creator never pays for their own channel.
  assert.equal(await denial(premiumId, creatorId), null, 'creator should watch their own premium video')

  // A row that exists but has not been paid for does not open the gate — this is the
  // state `startChannelCheckout` writes just before handing off to Stripe.
  await ChannelSubscriptionModel.create({
    subscriberId: viewer._id,
    creatorId: creator._id,
    stripeCustomerId: 'cus_gate_test',
    status: 'incomplete',
  })
  assert.equal(
    await denial(premiumId, viewerId),
    INTERACTION_ERRORS.subscriptionRequired,
    'an unpaid checkout must not unlock anything',
  )

  // ...and this is what `syncSubscription` writes once the payment lands.
  await ChannelSubscriptionModel.updateOne(
    { subscriberId: viewer._id, creatorId: creator._id },
    { status: 'active', currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) },
  )
  const allowed = await requirePlayableVideo(premiumId, viewerId)
  assert.equal(allowed.subscribed, true)
  assert.equal(String(allowed.video._id), premiumId)

  // The subscription buys this channel, not the whole site.
  const other = await UserModel.create({
    email: `${tag}-other@example.test`,
    googleId: `${tag}-other`,
    channelName: 'Someone Else',
    subscriptionPriceCents: 999,
  })
  const otherPremium = await VideoModel.create({
    title: `${tag} other premium`,
    url: 'http://example.test/other.mp4',
    visibility: 'private',
    uploadedBy: other._id,
  })
  assert.equal(
    await denial(String(otherPremium._id), viewerId),
    INTERACTION_ERRORS.subscriptionRequired,
    'a subscription to one channel must not unlock another',
  )

  // A lapsed period closes the gate again even while the status still reads active.
  await ChannelSubscriptionModel.updateOne(
    { subscriberId: viewer._id, creatorId: creator._id },
    { currentPeriodEnd: new Date(Date.now() - 86_400_000) },
  )
  assert.equal(
    await denial(premiumId, viewerId),
    INTERACTION_ERRORS.subscriptionRequired,
    'an expired period must fail closed',
  )

  console.log('channel gate: all checks passed')
}

main()
  .catch((err) => {
    console.error('channel gate FAILED:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    // Best effort: a failed run should still not leave test rows behind.
    await Promise.all([
      UserModel.deleteMany({ email: new RegExp(`^${tag}-`) }),
      VideoModel.deleteMany({ title: new RegExp(`^${tag} `) }),
      ChannelSubscriptionModel.deleteMany({ stripeCustomerId: 'cus_gate_test' }),
    ]).catch(() => {})
    await mongoose.disconnect()
  })
