import { connectToDatabase } from '../../db/mongoose.ts'
import { VideoCommentModel } from '../../db/models/video-comment.ts'
import type { CommentRow, Id, VideoCommentRepo } from '../types.ts'

type Lean = {
  _id: unknown
  videoId: unknown
  userId: unknown
  body: string
  createdAt: Date
  editedAt?: Date | null
}

function toRow(doc: Lean): CommentRow {
  return {
    id: String(doc._id),
    videoId: String(doc.videoId),
    userId: String(doc.userId),
    body: doc.body,
    createdAt: doc.createdAt,
    editedAt: doc.editedAt ?? null,
  }
}

export const videoComments: VideoCommentRepo = {
  async countByVideo(videoId: Id): Promise<number> {
    await connectToDatabase()
    return VideoCommentModel.countDocuments({ videoId })
  },

  async listByVideo(videoId: Id, limit: number, cursor: Id | null): Promise<CommentRow[]> {
    await connectToDatabase()
    const docs = await VideoCommentModel.find({
      videoId,
      ...(cursor ? { _id: { $lt: cursor } } : {}),
    })
      .sort({ _id: -1 })
      .limit(limit)
      .lean()
    return docs.map(toRow)
  },

  async create(videoId: Id, userId: Id, body: string): Promise<CommentRow> {
    await connectToDatabase()
    const doc = await VideoCommentModel.create({ videoId, userId, body })
    return toRow(doc.toObject() as Lean)
  },

  async updateOwn(
    commentId: Id,
    userId: Id,
    body: string,
    editedAt: Date,
  ): Promise<CommentRow | null> {
    await connectToDatabase()
    const doc = await VideoCommentModel.findOneAndUpdate(
      { _id: commentId, userId },
      { body, editedAt },
      { returnDocument: 'after' },
    ).lean()
    return doc ? toRow(doc) : null
  },

  async deleteOwn(commentId: Id, userId: Id): Promise<CommentRow | null> {
    await connectToDatabase()
    const doc = await VideoCommentModel.findOneAndDelete({ _id: commentId, userId }).lean()
    return doc ? toRow(doc) : null
  },

  async deleteByVideo(videoId: Id): Promise<void> {
    await connectToDatabase()
    await VideoCommentModel.deleteMany({ videoId })
  },
}
