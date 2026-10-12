import { connectToDatabase } from '../../db/mongoose.ts'
import { UserModel } from '../../db/models/user.ts'
import {
  DuplicateEmail,
  type GoogleLinkFields,
  type Id,
  type UserCreateFields,
  type UserProfilePatch,
  type UserRepo,
  type UserRow,
} from '../types.ts'

type Lean = {
  _id: unknown
  email: string
  passwordHash?: string | null
  googleId?: string | null
  name?: string | null
  avatarUrl?: string | null
  channelName?: string | null
  channelDescription?: string | null
  channelCurrency?: string | null
  stripeCustomerId?: string | null
}

function toRow(doc: Lean): UserRow {
  return {
    id: String(doc._id),
    email: doc.email,
    passwordHash: doc.passwordHash ?? null,
    googleId: doc.googleId ?? null,
    name: doc.name ?? '',
    avatarUrl: doc.avatarUrl ?? '',
    channelName: doc.channelName ?? '',
    channelDescription: doc.channelDescription ?? '',
    channelCurrency: doc.channelCurrency || 'usd',
    stripeCustomerId: doc.stripeCustomerId ?? '',
  }
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000
}

export const users: UserRepo = {
  async findById(id: Id): Promise<UserRow | null> {
    await connectToDatabase()
    const doc = await UserModel.findById(id).lean()
    return doc ? toRow(doc) : null
  },

  async findByEmail(email: string): Promise<UserRow | null> {
    await connectToDatabase()
    const doc = await UserModel.findOne({ email }).lean()
    return doc ? toRow(doc) : null
  },

  async findByGoogleId(googleId: string): Promise<UserRow | null> {
    await connectToDatabase()
    const doc = await UserModel.findOne({ googleId }).lean()
    return doc ? toRow(doc) : null
  },

  async listByIds(ids: readonly Id[]): Promise<UserRow[]> {
    if (ids.length === 0) return []
    await connectToDatabase()
    const docs = await UserModel.find({ _id: { $in: [...ids] } }).lean()
    return docs.map(toRow)
  },

  async create(fields: UserCreateFields): Promise<UserRow> {
    await connectToDatabase()
    try {
      const doc = await UserModel.create({
        email: fields.email,
        passwordHash: fields.passwordHash ?? undefined,
        googleId: fields.googleId ?? undefined,
        name: fields.name ?? '',
        avatarUrl: fields.avatarUrl ?? '',
      })
      return toRow(doc.toObject() as Lean)
    } catch (err) {
      if (isDuplicateKeyError(err)) throw new DuplicateEmail()
      throw err
    }
  },

  async updateProfile(id: Id, patch: UserProfilePatch): Promise<void> {
    await connectToDatabase()
    await UserModel.updateOne({ _id: id }, { $set: patch })
  },

  async linkGoogle(id: Id, fields: GoogleLinkFields): Promise<void> {
    await connectToDatabase()
    const set: Record<string, unknown> = { googleId: fields.googleId }
    if (fields.name) set.name = fields.name
    if (fields.avatarUrl) set.avatarUrl = fields.avatarUrl
    await UserModel.updateOne({ _id: id }, { $set: set })
  },

  async setAvatar(id: Id, avatarUrl: string): Promise<void> {
    await connectToDatabase()
    await UserModel.updateOne({ _id: id }, { $set: { avatarUrl } })
  },

  async claimStripeCustomerId(id: Id, customerId: string): Promise<string> {
    await connectToDatabase()
    const claimed = await UserModel.findOneAndUpdate(
      { _id: id, $or: [{ stripeCustomerId: '' }, { stripeCustomerId: null }] },
      { stripeCustomerId: customerId },
      { returnDocument: 'after', projection: { stripeCustomerId: 1 } },
    ).lean()
    if (claimed?.stripeCustomerId) return claimed.stripeCustomerId

    const existing = await UserModel.findById(id).select('stripeCustomerId').lean()
    return existing?.stripeCustomerId || customerId
  },
}
