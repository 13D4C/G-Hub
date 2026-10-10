import { connectToDatabase } from '../../db/mongoose.ts'
import { MembershipTierModel } from '../../db/models/membership-tier.ts'
import {
  DuplicateTierName,
  type Id,
  type MembershipTierRepo,
  type TierCreateFields,
  type TierRow,
  type TierUpdateFields,
} from '../types.ts'

type Lean = {
  _id: unknown
  creatorId: unknown
  name: string
  description?: string | null
  priceCents: number
  currency?: string | null
  rank: number
  active?: boolean | null
}

function toRow(doc: Lean): TierRow {
  return {
    id: String(doc._id),
    creatorId: String(doc.creatorId),
    name: doc.name,
    description: doc.description ?? '',
    priceCents: doc.priceCents,
    currency: doc.currency || 'usd',
    rank: doc.rank,
    active: doc.active ?? true,
  }
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000
}

export const membershipTiers: MembershipTierRepo = {
  async findById(tierId: Id): Promise<TierRow | null> {
    await connectToDatabase()
    const doc = await MembershipTierModel.findById(tierId).lean()
    return doc ? toRow(doc) : null
  },

  async findActiveOwned(tierId: Id, creatorId: Id): Promise<TierRow | null> {
    await connectToDatabase()
    const doc = await MembershipTierModel.findOne({
      _id: tierId,
      creatorId,
      active: true,
    }).lean()
    return doc ? toRow(doc) : null
  },

  async listActiveByCreator(creatorId: Id): Promise<TierRow[]> {
    await connectToDatabase()
    const docs = await MembershipTierModel.find({ creatorId, active: true })
      .sort({ rank: 1, name: 1 })
      .lean()
    return docs.map(toRow)
  },

  async listByIds(ids: readonly Id[]): Promise<TierRow[]> {
    if (ids.length === 0) return []
    await connectToDatabase()
    const docs = await MembershipTierModel.find({ _id: { $in: [...ids] } }).lean()
    return docs.map(toRow)
  },

  async countActiveByCreator(creatorId: Id): Promise<number> {
    await connectToDatabase()
    return MembershipTierModel.countDocuments({ creatorId, active: true })
  },

  async create(creatorId: Id, fields: TierCreateFields): Promise<TierRow> {
    await connectToDatabase()
    try {
      const doc = await MembershipTierModel.create({ creatorId, ...fields })
      return toRow(doc.toObject() as Lean)
    } catch (err) {
      if (isDuplicateKeyError(err)) throw new DuplicateTierName()
      throw err
    }
  },

  async updateOwn(
    tierId: Id,
    creatorId: Id,
    fields: TierUpdateFields,
  ): Promise<TierRow | null> {
    await connectToDatabase()
    try {
      const doc = await MembershipTierModel.findOneAndUpdate(
        { _id: tierId, creatorId, active: true },
        { $set: fields },
        { returnDocument: 'after' },
      ).lean()
      return doc ? toRow(doc) : null
    } catch (err) {
      if (isDuplicateKeyError(err)) throw new DuplicateTierName()
      throw err
    }
  },

  async archive(tierId: Id, creatorId: Id): Promise<boolean> {
    await connectToDatabase()
    const doc = await MembershipTierModel.findOneAndUpdate(
      { _id: tierId, creatorId, active: true },
      { $set: { active: false } },
    ).lean()
    return doc !== null
  },
}
