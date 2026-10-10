import { Types } from 'mongoose'
import { connectToDatabase } from '../../db/mongoose.ts'
import { VideoModel } from '../../db/models/video.ts'
import type {
  ClaimedVideo,
  Id,
  TranscodeResultFields,
  VideoCreateFields,
  VideoGatePatch,
  VideoRepo,
  VideoRow,
} from '../types.ts'

type Lean = Record<string, any>

function toRow(doc: Lean): VideoRow {
  const t = doc.transcode ?? {}
  return {
    id: String(doc._id),
    title: doc.title ?? '',
    description: doc.description ?? '',
    url: doc.url ?? '',
    uploadedBy: doc.uploadedBy ? String(doc.uploadedBy) : null,
    durationSeconds: doc.durationSeconds ?? 0,
    visibility: doc.visibility ?? 'public',
    requiredTierId: doc.requiredTierId ? String(doc.requiredTierId) : null,
    priceCents: doc.priceCents ?? null,
    adsEnabled: doc.adsEnabled ?? true,
    likeCount: doc.likeCount ?? 0,
    viewCount: doc.viewCount ?? 0,
    shareCount: doc.shareCount ?? 0,
    createdAt: doc.createdAt,
    transcode: {
      status: t.status ?? 'pending',
      nextAttemptAt: t.nextAttemptAt ?? new Date(0),
      attempts: t.attempts ?? 0,
      workerId: t.workerId ?? '',
      prefix: t.prefix ?? '',
      hlsUrl: t.hlsUrl ?? '',
      dashUrl: t.dashUrl ?? '',
      renditions: t.renditions ?? [],
      sourceWidth: t.sourceWidth ?? 0,
      sourceHeight: t.sourceHeight ?? 0,
      error: t.error ?? '',
      startedAt: t.startedAt ?? null,
      finishedAt: t.finishedAt ?? null,
    },
  }
}

function visibleFilter(viewerId: Id | null) {
  const notPrivate = { visibility: { $ne: 'private' as const } }
  return viewerId ? { $or: [notPrivate, { uploadedBy: viewerId }] } : notPrivate
}

export const videos: VideoRepo = {
  async findById(videoId: Id): Promise<VideoRow | null> {
    await connectToDatabase()
    const doc = await VideoModel.findById(videoId).lean()
    return doc ? toRow(doc) : null
  },

  async listVisible(viewerId: Id | null, limit: number): Promise<VideoRow[]> {
    await connectToDatabase()
    const docs = await VideoModel.find(visibleFilter(viewerId))
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
    return docs.map(toRow)
  },

  async listVisibleByCreators(
    viewerId: Id | null,
    creatorIds: readonly Id[],
    limit: number,
  ): Promise<VideoRow[]> {
    if (creatorIds.length === 0) return []
    await connectToDatabase()
    const docs = await VideoModel.find({
      $and: [visibleFilter(viewerId), { uploadedBy: { $in: [...creatorIds] } }],
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
    return docs.map(toRow)
  },

  async listVisibleSince(viewerId: Id | null, since: Date, limit: number): Promise<VideoRow[]> {
    await connectToDatabase()
    const docs = await VideoModel.find({
      $and: [visibleFilter(viewerId), { createdAt: { $gte: since } }],
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
    return docs.map(toRow)
  },

  async listByCreator(creatorId: Id, limit: number): Promise<VideoRow[]> {
    await connectToDatabase()
    const docs = await VideoModel.find({ uploadedBy: creatorId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
    return docs.map(toRow)
  },

  async countByTier(tierIds: readonly Id[]): Promise<Map<Id, number>> {
    if (tierIds.length === 0) return new Map()
    await connectToDatabase()
    const counts = await VideoModel.aggregate<{ _id: unknown; count: number }>([
      { $match: { requiredTierId: { $in: tierIds.map((id) => new Types.ObjectId(id)) } } },
      { $group: { _id: '$requiredTierId', count: { $sum: 1 } } },
    ])
    return new Map(counts.map((row) => [String(row._id), row.count]))
  },

  async create(fields: VideoCreateFields): Promise<VideoRow> {
    await connectToDatabase()
    const doc = new VideoModel({
      _id: new Types.ObjectId(fields.id),
      title: fields.title,
      description: fields.description,
      url: fields.url,
      uploadedBy: new Types.ObjectId(fields.uploadedBy),
      durationSeconds: fields.durationSeconds,
      visibility: fields.visibility,
      requiredTierId: fields.requiredTierId ? new Types.ObjectId(fields.requiredTierId) : null,
      priceCents: fields.priceCents,
      adsEnabled: fields.adsEnabled,
    })
    await doc.save()
    return toRow(doc.toObject() as Lean)
  },

  async updateDetails(
    videoId: Id,
    creatorId: Id,
    fields: { title: string; description: string },
  ): Promise<VideoRow | null> {
    await connectToDatabase()
    const doc = await VideoModel.findOneAndUpdate(
      { _id: videoId, uploadedBy: creatorId },
      { $set: fields },
      { returnDocument: 'after' },
    ).lean()
    return doc ? toRow(doc) : null
  },

  async updateGate(videoId: Id, creatorId: Id, patch: VideoGatePatch): Promise<VideoRow | null> {
    await connectToDatabase()
    const doc = await VideoModel.findOneAndUpdate(
      { _id: videoId, uploadedBy: creatorId },
      {
        $set: {
          visibility: patch.visibility,
          requiredTierId: patch.requiredTierId
            ? new Types.ObjectId(patch.requiredTierId)
            : null,
          priceCents: patch.priceCents,
          adsEnabled: patch.adsEnabled,
        },
      },
      { returnDocument: 'after' },
    ).lean()
    return doc ? toRow(doc) : null
  },

  async deleteOwned(videoId: Id, creatorId: Id): Promise<VideoRow | null> {
    await connectToDatabase()
    const doc = await VideoModel.findOneAndDelete({
      _id: videoId,
      uploadedBy: creatorId,
    }).lean()
    return doc ? toRow(doc) : null
  },

  async incrementView(videoId: Id): Promise<void> {
    await connectToDatabase()
    await VideoModel.updateOne({ _id: videoId }, { $inc: { viewCount: 1 } })
  },

  async incrementLike(videoId: Id, delta: number): Promise<number> {
    await connectToDatabase()
    const doc = await VideoModel.findByIdAndUpdate(
      videoId,
      { $inc: { likeCount: delta } },
      { returnDocument: 'after', projection: { likeCount: 1 } },
    ).lean()
    return doc?.likeCount ?? 0
  },

  async incrementShare(videoId: Id): Promise<number> {
    await connectToDatabase()
    const doc = await VideoModel.findByIdAndUpdate(
      videoId,
      { $inc: { shareCount: 1 } },
      { returnDocument: 'after', projection: { shareCount: 1 } },
    ).lean()
    return doc?.shareCount ?? 0
  },

  async claimNext(
    workerId: string,
    leaseMs: number,
    maxAttempts: number,
  ): Promise<ClaimedVideo | null> {
    await connectToDatabase()
    const now = new Date()
    const claimed = await VideoModel.findOneAndUpdate(
      {
        'transcode.status': { $in: ['pending', 'processing'] },
        'transcode.nextAttemptAt': { $lte: now },
        'transcode.attempts': { $lt: maxAttempts },
      },
      {
        $set: {
          'transcode.status': 'processing',
          'transcode.nextAttemptAt': new Date(now.getTime() + leaseMs),
          'transcode.workerId': workerId,
          'transcode.prefix': crypto.randomUUID(),
          'transcode.startedAt': now,
          'transcode.error': '',
        },
        $inc: { 'transcode.attempts': 1 },
      },
      { sort: { 'transcode.nextAttemptAt': 1 }, returnDocument: 'after' },
    )
      .select('url transcode.prefix transcode.attempts')
      .lean()

    if (!claimed) return null
    return {
      id: String(claimed._id),
      url: claimed.url,
      prefix: claimed.transcode?.prefix ?? '',
      attempts: claimed.transcode?.attempts ?? 1,
    }
  },

  async renewClaim(videoId: Id, workerId: string, leaseMs: number): Promise<boolean> {
    await connectToDatabase()
    const result = await VideoModel.updateOne(
      { _id: videoId, 'transcode.workerId': workerId, 'transcode.status': 'processing' },
      { $set: { 'transcode.nextAttemptAt': new Date(Date.now() + leaseMs) } },
    )
    return result.matchedCount > 0
  },

  async completeTranscode(
    videoId: Id,
    workerId: string,
    result: TranscodeResultFields,
  ): Promise<boolean> {
    await connectToDatabase()
    const update = await VideoModel.updateOne(
      { _id: videoId, 'transcode.workerId': workerId },
      {
        $set: {
          'transcode.status': 'ready',
          'transcode.hlsUrl': result.hlsUrl,
          'transcode.dashUrl': result.dashUrl,
          'transcode.renditions': result.renditions,
          'transcode.sourceWidth': result.sourceWidth,
          'transcode.sourceHeight': result.sourceHeight,
          'transcode.finishedAt': new Date(),
          'transcode.error': '',
          ...(result.durationSeconds > 0 ? { durationSeconds: result.durationSeconds } : {}),
        },
      },
    )
    return update.matchedCount > 0
  },

  async failTranscode(
    videoId: Id,
    workerId: string,
    giveUp: boolean,
    nextAttemptAt: Date,
    message: string,
  ): Promise<boolean> {
    await connectToDatabase()
    const update = await VideoModel.updateOne(
      { _id: videoId, 'transcode.workerId': workerId },
      {
        $set: {
          'transcode.status': giveUp ? 'failed' : 'pending',
          'transcode.nextAttemptAt': nextAttemptAt,
          'transcode.error': message,
          'transcode.finishedAt': giveUp ? new Date() : null,
        },
      },
    )
    return update.matchedCount > 0
  },

  async skipTranscode(videoId: Id, workerId: string, reason: string): Promise<boolean> {
    await connectToDatabase()
    const update = await VideoModel.updateOne(
      { _id: videoId, 'transcode.workerId': workerId },
      {
        $set: {
          'transcode.status': 'skipped',
          'transcode.error': reason,
          'transcode.finishedAt': new Date(),
        },
      },
    )
    return update.matchedCount > 0
  },
}
