import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { COMMENT_MAX_LENGTH, INTERACTION_ERRORS } from '@/lib/interaction-errors'
import { getUserId, requireUserId } from '@/server/auth/require-user'
import { UserModel } from '@/server/db/models/user'
import { VideoCommentModel } from '@/server/db/models/video-comment'
import { VideoLikeModel } from '@/server/db/models/video-like'
import { VideoModel } from '@/server/db/models/video'
import { connectToDatabase } from '@/server/db/mongoose'

/**
 * Viewer interactions: likes, comments and shares. Like `videos.ts`, these only ever
 * run on the server, so `mongoose` never reaches the client bundle.
 *
 * Identity always comes from the sealed session cookie, never from the arguments — a
 * client cannot pass a userId — and ownership checks live inside the Mongo filter
 * rather than in a separate read.
 */

/**
 * A 24-hex ObjectId. Validating here makes a junk id a clean rejection instead of a
 * Mongoose CastError, whose message would fail the client-side allowlist and collapse
 * into a generic fallback.
 */
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

const videoIdSchema = z.object({ videoId: objectId })
const commentIdSchema = z.object({ commentId: objectId })

const listCommentsSchema = z.object({
  videoId: objectId,
  limit: z.number().int().min(1).max(50).default(20),
  /** Keyset cursor: the `_id` of the last comment of the previous page. */
  cursor: objectId.nullish(),
})

const createCommentSchema = z.object({
  videoId: objectId,
  // `.trim()` runs before `.min(1)`, so a whitespace-only body is rejected and the
  // handler receives the trimmed string.
  body: z.string().trim().min(1).max(COMMENT_MAX_LENGTH),
})

const updateCommentSchema = z.object({
  commentId: objectId,
  body: z.string().trim().min(1).max(COMMENT_MAX_LENGTH),
})

/** Mongo's duplicate-key error, raised here by the unique index on `videolikes`. */
function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000
}

/**
 * Interactions are only accepted on videos a viewer is actually allowed to watch,
 * matching `getVideoById`. Reads go through this too, so a private video's like count
 * and comment thread cannot be enumerated by guessing an ObjectId.
 *
 * Assumes the caller has already connected to the database.
 */
async function requirePlayableVideo(videoId: string) {
  const video = await VideoModel.findById(videoId).lean()
  if (!video) throw new Error(INTERACTION_ERRORS.videoNotFound)
  if (video.visibility !== 'public') throw new Error(INTERACTION_ERRORS.videoNotPublic)
  return video
}

export type InteractionSummary = {
  videoId: string
  likeCount: number
  commentCount: number
  shareCount: number
  viewerHasLiked: boolean
}

/**
 * Every counter for one video, plus whether the current viewer has liked it.
 *
 * Tolerates an anonymous caller (`viewerHasLiked: false`) rather than rejecting, so
 * the counts still render for signed-out viewers.
 */
export const getVideoInteractions = createServerFn({ method: 'GET' })
  .validator(videoIdSchema)
  .handler(async ({ data }): Promise<InteractionSummary> => {
    const viewerId = await getUserId()
    await connectToDatabase()
    const video = await requirePlayableVideo(data.videoId)

    const [commentCount, viewerLike] = await Promise.all([
      VideoCommentModel.countDocuments({ videoId: video._id }),
      // Index-only, and the one thing a denormalized counter cannot answer.
      viewerId ? VideoLikeModel.exists({ videoId: video._id, userId: viewerId }) : null,
    ])

    return {
      videoId: String(video._id),
      // Read off the video doc `requirePlayableVideo` already fetched, so likes and
      // shares cost no extra query. `.lean()` skips schema defaults, so videos
      // created before these fields existed read back as `undefined` despite the
      // `number` type — hence `?? 0`.
      likeCount: video.likeCount ?? 0,
      commentCount,
      shareCount: video.shareCount ?? 0,
      viewerHasLiked: viewerLike !== null,
    }
  })

/**
 * Add or remove the viewer's like, returning the new state and total.
 *
 * The `videoLike` row is the source of truth and is written first; the denormalized
 * `video.likeCount` follows. If the process dies between the two, the result is a
 * cosmetically wrong number over correct rows, which `npm run recount-likes` repairs.
 * The reverse order would leave a count nothing can explain.
 */
export const toggleVideoLike = createServerFn({ method: 'POST' })
  .validator(videoIdSchema)
  .handler(async ({ data }): Promise<{ liked: boolean; likeCount: number }> => {
    const userId = await requireUserId()
    await connectToDatabase()
    const video = await requirePlayableVideo(data.videoId)

    const key = { videoId: video._id, userId }

    // Delete-then-insert rather than read-then-branch: the delete is itself the test
    // for "was it liked?", so there is no read/write gap to lose a race in.
    const removed = await VideoLikeModel.findOneAndDelete(key).lean()
    let liked = false
    let delta = -1

    if (!removed) {
      try {
        await VideoLikeModel.create(key)
        liked = true
        delta = 1
      } catch (err) {
        // A concurrent double submit already inserted this exact like and the unique
        // index turned this one into E11000. The desired end state (liked) already
        // holds, so the toggle is idempotent — and the request that *did* insert the
        // row is the one that increments, so this one must not.
        if (!isDuplicateKeyError(err)) throw err
        liked = true
        delta = 0
      }
    }

    // `returnDocument: 'after'` gives the post-increment value, so this replaces the
    // `countDocuments` this handler would otherwise need: the same number of queries
    // here, and every summary read gets the count for free.
    const updated = delta
      ? await VideoModel.findByIdAndUpdate(
          video._id,
          { $inc: { likeCount: delta } },
          { returnDocument: 'after', projection: { likeCount: 1 } },
        ).lean()
      : null

    return { liked, likeCount: updated?.likeCount ?? video.likeCount ?? 0 }
  })

export type CommentDto = {
  id: string
  videoId: string
  body: string
  authorId: string
  authorName: string
  /** ISO-8601 UTC. A `Date` would format differently on the server and the client. */
  createdAt: string
  editedAt: string | null
}

export type CommentPage = {
  comments: Array<CommentDto>
  /** Pass back as `cursor` for the next page. `null` when the thread is exhausted. */
  nextCursor: string | null
}

/** Display name for a comment author, never their email address. */
function authorNameFrom(name: string | undefined): string {
  // A missing author is expected, not a bug: `requireUserId` trusts the session
  // cookie without checking the account still exists, so comments outlive accounts.
  return name || 'Anonymous'
}

/**
 * One newest-first page of a video's comments.
 *
 * The DTO carries `authorId` rather than a `canEdit` flag, so it does not depend on
 * who is asking and one cache entry serves every viewer. The client compares
 * `authorId` to decide whether to *show* edit controls; the actual gate is the
 * ownership filter in `updateComment` / `deleteComment`.
 */
export const listComments = createServerFn({ method: 'GET' })
  .validator(listCommentsSchema)
  .handler(async ({ data }): Promise<CommentPage> => {
    await connectToDatabase()
    const video = await requirePlayableVideo(data.videoId)

    // Keyset, not skip/limit: `_id` descending is effectively newest-first and is
    // unique, so a comment posted mid-scroll cannot shift a row across a page
    // boundary. A `createdAt` cursor has millisecond ties and would.
    const docs = await VideoCommentModel.find({
      videoId: video._id,
      ...(data.cursor ? { _id: { $lt: data.cursor } } : {}),
    })
      .sort({ _id: -1 })
      .limit(data.limit + 1)
      .lean()

    const hasMore = docs.length > data.limit
    const page = hasMore ? docs.slice(0, data.limit) : docs

    // Author names via one extra `$in` query rather than `.populate()`:
    // `InferSchemaType` types `userId` as an ObjectId and populate does not narrow
    // it, so the populated form would need a cast this codebase has none of.
    const authorIds = [...new Set(page.map((c) => String(c.userId)))]
    const authors = await UserModel.find({ _id: { $in: authorIds } })
      .select('name')
      .lean()
    const nameById = new Map(authors.map((u) => [String(u._id), u.name]))

    return {
      comments: page.map((c) => ({
        id: String(c._id),
        videoId: String(c.videoId),
        body: c.body,
        authorId: String(c.userId),
        authorName: authorNameFrom(nameById.get(String(c.userId))),
        createdAt: c.createdAt.toISOString(),
        editedAt: c.editedAt ? c.editedAt.toISOString() : null,
      })),
      nextCursor: hasMore ? String(page[page.length - 1]._id) : null,
    }
  })

/** Post a comment as the signed-in viewer. */
export const createComment = createServerFn({ method: 'POST' })
  .validator(createCommentSchema)
  .handler(async ({ data }): Promise<CommentDto> => {
    const userId = await requireUserId()
    await connectToDatabase()
    const video = await requirePlayableVideo(data.videoId)

    const comment = await VideoCommentModel.create({
      videoId: video._id,
      userId,
      body: data.body,
    })
    const author = await UserModel.findById(userId).select('name').lean()

    return {
      id: String(comment._id),
      videoId: String(comment.videoId),
      body: comment.body,
      authorId: userId,
      authorName: authorNameFrom(author?.name),
      createdAt: comment.createdAt.toISOString(),
      editedAt: null,
    }
  })

/**
 * Edit one of the viewer's own comments.
 *
 * Ownership lives in the filter, not in a read-then-compare: there is no window
 * between the check and the write, and a non-owner gets the same "no longer exists"
 * as a bad id, so this is not an existence oracle either.
 */
export const updateComment = createServerFn({ method: 'POST' })
  .validator(updateCommentSchema)
  .handler(async ({ data }): Promise<{ id: string; body: string; editedAt: string }> => {
    const userId = await requireUserId()
    await connectToDatabase()

    const editedAt = new Date()
    const updated = await VideoCommentModel.findOneAndUpdate(
      { _id: data.commentId, userId },
      { body: data.body, editedAt },
      { returnDocument: 'after' },
    ).lean()
    if (!updated) throw new Error(INTERACTION_ERRORS.commentNotFound)

    return { id: String(updated._id), body: updated.body, editedAt: editedAt.toISOString() }
  })

/**
 * Delete one of the viewer's own comments. Returns the video it belonged to so the
 * client knows which caches to refresh.
 */
export const deleteComment = createServerFn({ method: 'POST' })
  .validator(commentIdSchema)
  .handler(async ({ data }): Promise<{ id: string; videoId: string }> => {
    const userId = await requireUserId()
    await connectToDatabase()

    const deleted = await VideoCommentModel.findOneAndDelete({
      _id: data.commentId,
      userId,
    }).lean()
    if (!deleted) throw new Error(INTERACTION_ERRORS.commentNotFound)

    return { id: String(deleted._id), videoId: String(deleted.videoId) }
  })

/**
 * Count a share. Unauthenticated by design — sharing a link is not an account action,
 * and there is no per-viewer share state to render.
 */
export const recordShare = createServerFn({ method: 'POST' })
  .validator(videoIdSchema)
  .handler(async ({ data }): Promise<{ shareCount: number }> => {
    await connectToDatabase()

    // Existence check, visibility check and increment in one atomic operation. A
    // private video and a missing one give the same message, so this leaks nothing.
    const video = await VideoModel.findOneAndUpdate(
      { _id: data.videoId, visibility: 'public' },
      { $inc: { shareCount: 1 } },
      { returnDocument: 'after', projection: { shareCount: 1 } },
    ).lean()
    if (!video) throw new Error(INTERACTION_ERRORS.videoNotFound)

    return { shareCount: video.shareCount ?? 0 }
  })
