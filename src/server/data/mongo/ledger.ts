import { Types } from 'mongoose'
import { connectToDatabase } from '../../db/mongoose.ts'
import { AdImpressionModel } from '../../db/models/ad-impression.ts'
import { SubscriptionInvoiceModel } from '../../db/models/subscription-invoice.ts'
import { TipModel } from '../../db/models/tip.ts'
import { VideoPurchaseModel } from '../../db/models/video-purchase.ts'
import type {
  AdImpressionRepo,
  Id,
  ImpressionRecordFields,
  InvoiceRecordFields,
  LedgerEntry,
  PurchaseRecordFields,
  SubscriptionInvoiceRepo,
  TipRecordFields,
  TipRepo,
  VideoPurchaseRepo,
} from '../types.ts'

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000
}

export const tips: TipRepo = {
  async listByCreator(creatorId: Id): Promise<LedgerEntry[]> {
    await connectToDatabase()
    const docs = await TipModel.find({ creatorId })
      .select('videoId amountCents currency createdAt')
      .lean()
    return docs.map((doc) => ({
      creatorId,
      videoId: doc.videoId ? String(doc.videoId) : null,
      amountCents: doc.amountCents,
      currency: doc.currency || 'usd',
      at: doc.createdAt,
    }))
  },

  async recordBySession(stripeSessionId: string, fields: TipRecordFields): Promise<void> {
    await connectToDatabase()
    await TipModel.updateOne({ stripeSessionId }, fields, { upsert: true })
  },
}

export const videoPurchases: VideoPurchaseRepo = {
  async listByCreator(creatorId: Id): Promise<LedgerEntry[]> {
    await connectToDatabase()
    const docs = await VideoPurchaseModel.find({ creatorId })
      .select('videoId amountCents currency createdAt')
      .lean()
    return docs.map((doc) => ({
      creatorId,
      videoId: doc.videoId ? String(doc.videoId) : null,
      amountCents: doc.amountCents,
      currency: doc.currency || 'usd',
      at: doc.createdAt,
    }))
  },

  async recordBySession(stripeSessionId: string, fields: PurchaseRecordFields): Promise<void> {
    await connectToDatabase()
    await VideoPurchaseModel.updateOne({ stripeSessionId }, fields, { upsert: true })
  },

  async existsForBuyer(buyerId: Id, videoId: Id): Promise<boolean> {
    await connectToDatabase()
    return (await VideoPurchaseModel.exists({ buyerId, videoId })) !== null
  },

  async purchasedVideoIds(buyerId: Id, videoIds: readonly Id[]): Promise<Set<Id>> {
    if (videoIds.length === 0) return new Set()
    await connectToDatabase()
    const rows = await VideoPurchaseModel.find({ buyerId, videoId: { $in: [...videoIds] } })
      .select('videoId')
      .lean()
    return new Set(rows.map((row) => String(row.videoId)))
  },
}

export const subscriptionInvoices: SubscriptionInvoiceRepo = {
  async listByCreator(creatorId: Id): Promise<LedgerEntry[]> {
    await connectToDatabase()
    const docs = await SubscriptionInvoiceModel.find({ creatorId })
      .select('amountPaidCents currency paidAt')
      .lean()
    return docs.map((doc) => ({
      creatorId,
      videoId: null,
      amountCents: doc.amountPaidCents,
      currency: doc.currency || 'usd',
      at: doc.paidAt,
    }))
  },

  async recordByInvoiceId(stripeInvoiceId: string, fields: InvoiceRecordFields): Promise<void> {
    await connectToDatabase()
    await SubscriptionInvoiceModel.updateOne({ stripeInvoiceId }, fields, { upsert: true })
  },
}

export const adImpressions: AdImpressionRepo = {
  async listByCreator(creatorId: Id): Promise<Array<{ at: Date }>> {
    await connectToDatabase()
    const docs = await AdImpressionModel.find({ creatorId }).select('shownAt').lean()
    return docs.map((doc) => ({ at: doc.shownAt }))
  },

  async record(fields: ImpressionRecordFields): Promise<void> {
    await connectToDatabase()
    try {
      await AdImpressionModel.create({
        adId: new Types.ObjectId(fields.adId),
        videoId: new Types.ObjectId(fields.videoId),
        creatorId: new Types.ObjectId(fields.creatorId),
        viewerId: fields.viewerId ? new Types.ObjectId(fields.viewerId) : null,
        shownAt: fields.shownAt,
        ...(fields.dedupeKey ? { dedupeKey: fields.dedupeKey } : {}),
      })
    } catch (err) {
      if (isDuplicateKeyError(err)) return
      throw err
    }
  },
}
