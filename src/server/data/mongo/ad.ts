import { connectToDatabase } from '../../db/mongoose.ts'
import { AdModel } from '../../db/models/ad.ts'
import type { AdRepo, AdRow, AdSeedFields } from '../types.ts'

export const ads: AdRepo = {
  async listActive(): Promise<AdRow[]> {
    await connectToDatabase()
    const docs = await AdModel.find({ active: true }).lean()
    return docs.map((doc) => ({
      id: String(doc._id),
      title: doc.title,
      mediaUrl: doc.mediaUrl,
      durationSeconds: doc.durationSeconds ?? 0,
      clickThroughUrl: doc.clickThroughUrl ?? '',
      skippableAfterSeconds: doc.skippableAfterSeconds ?? 3,
      weight: doc.weight ?? 1,
    }))
  },

  async upsertByTitle(title: string, fields: AdSeedFields): Promise<void> {
    await connectToDatabase()
    await AdModel.findOneAndUpdate({ title }, { title, ...fields }, { upsert: true })
  },
}
