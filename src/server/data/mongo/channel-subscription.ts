import { connectToDatabase } from '../../db/mongoose.ts'
import { ChannelSubscriptionModel } from '../../db/models/channel-subscription.ts'
import type {
  ChannelSubscriptionRepo,
  Id,
  SubscriptionPatch,
  SubscriptionRow,
} from '../types.ts'

type Lean = {
  subscriberId?: unknown
  creatorId?: unknown
  status?: string | null
  currentPeriodEnd?: Date | null
  tierId?: unknown
  tierName?: string | null
  priceCents?: number | null
  currency?: string | null
  cancelAtPeriodEnd?: boolean | null
  stripeCustomerId?: string | null
  stripeSubscriptionId?: string | null
}

function toRow(doc: Lean): SubscriptionRow {
  return {
    subscriberId: String(doc.subscriberId),
    creatorId: String(doc.creatorId),
    status: doc.status ?? 'incomplete',
    currentPeriodEnd: doc.currentPeriodEnd ?? null,
    tierId: doc.tierId ? String(doc.tierId) : null,
    tierName: doc.tierName ?? '',
    priceCents: doc.priceCents ?? 0,
    currency: doc.currency ?? 'usd',
    cancelAtPeriodEnd: doc.cancelAtPeriodEnd ?? false,
    stripeCustomerId: doc.stripeCustomerId ?? '',
    stripeSubscriptionId: doc.stripeSubscriptionId ?? '',
  }
}

export const channelSubscriptions: ChannelSubscriptionRepo = {
  async find(subscriberId: Id, creatorId: Id): Promise<SubscriptionRow | null> {
    await connectToDatabase()
    const doc = await ChannelSubscriptionModel.findOne({ subscriberId, creatorId }).lean()
    return doc ? toRow(doc) : null
  },

  async listBySubscriber(
    subscriberId: Id,
    statuses: readonly string[],
  ): Promise<SubscriptionRow[]> {
    await connectToDatabase()
    const docs = await ChannelSubscriptionModel.find({
      subscriberId,
      status: { $in: [...statuses] },
    }).lean()
    return docs.map(toRow)
  },

  async listByCreator(creatorId: Id): Promise<SubscriptionRow[]> {
    await connectToDatabase()
    const docs = await ChannelSubscriptionModel.find({ creatorId }).lean()
    return docs.map(toRow)
  },

  async upsert(subscriberId: Id, creatorId: Id, patch: SubscriptionPatch): Promise<void> {
    await connectToDatabase()
    await ChannelSubscriptionModel.findOneAndUpdate({ subscriberId, creatorId }, patch, {
      upsert: true,
      setDefaultsOnInsert: true,
    })
  },
}
