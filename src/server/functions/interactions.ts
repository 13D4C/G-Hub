import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { COMMENT_MAX_LENGTH, INTERACTION_ERRORS } from '@/lib/interaction-errors'
import { getUserId, requireUserId } from '@/server/auth/require-user'
import { users, videoComments, videoLikes, videos } from '@/server/data'
import { requirePlayableVideo } from '@/server/lib/entitlement'

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

/**
 * Interactions are only accepted on videos a viewer is actually allowed to watch —
 * the same `requirePlayableVideo` that gates playback, so a premium video's like
 * count and comment thread cannot be read by a non-subscriber guessing an ObjectId,
 * and a subscriber is never able to watch a video but not like it.
 */

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
    const { video } = await requirePlayableVideo(data.videoId, viewerId)

    const [commentCount, viewerLike] = await Promise.all([
      videoComments.countByVideo(video.id),
      // Index-only, and the one thing a denormalized counter cannot answer.
      viewerId ? videoLikes.exists(video.id, viewerId) : false,
    ])

    return {
      videoId: video.id,
      // Read off the video doc `requirePlayableVideo` already fetched, so likes and
      // shares cost no extra query. `.lean()` skips schema defaults, so videos
      // created before these fields existed read back as `undefined` despite the
      // `number` type — hence `?? 0`.
      likeCount: video.likeCount ?? 0,
      commentCount,
      shareCount: video.shareCount ?? 0,
      viewerHasLiked: viewerLike,
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
    const { video } = await requirePlayableVideo(data.videoId, userId)

    const videoId = video.id

    // Delete-then-insert rather than read-then-branch: the delete is itself the test
    // for "was it liked?", so there is no read/write gap to lose a race in.
    const removed = await videoLikes.remove(videoId, userId)
    let liked = false
    let delta = -1

    if (!removed) {
      // A concurrent double submit may already have inserted this exact like, in which
      // case `insert` reports false. The desired end state (liked) already holds, so
      // the toggle is idempotent — and the request that *did* insert the row is the one
      // that increments, so this one must not.
      const inserted = await videoLikes.insert(videoId, userId)
      liked = true
      delta = inserted ? 1 : 0
    }

    // `returnDocument: 'after'` gives the post-increment value, so this replaces the
    // `countDocuments` this handler would otherwise need: the same number of queries
    // here, and every summary read gets the count for free.
    const updated = delta
      ? await videos.incrementLike(video.id, delta)
      : null

    return { liked, likeCount: updated ?? video.likeCount ?? 0 }
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
    const viewerId = await getUserId()
    const { video } = await requirePlayableVideo(data.videoId, viewerId)

    // Keyset, not skip/limit: `_id` descending is effectively newest-first and is
    // unique, so a comment posted mid-scroll cannot shift a row across a page
    // boundary. A `createdAt` cursor has millisecond ties and would.
    const docs = await videoComments.listByVideo(
      video.id,
      data.limit + 1,
      data.cursor ?? null,
    )

    const hasMore = docs.length > data.limit
    const page = hasMore ? docs.slice(0, data.limit) : docs

    // Author names via one extra `$in` query rather than `.populate()`:
    // `InferSchemaType` types `userId` as an ObjectId and populate does not narrow
    // it, so the populated form would need a cast this codebase has none of.
    const authorIds = [...new Set(page.map((c) => c.userId))]
    const authors = await users.listByIds(authorIds)
    const nameById = new Map(authors.map((u) => [u.id, u.name]))

    return {
      comments: page.map((c) => ({
        id: c.id,
        videoId: c.videoId,
        body: c.body,
        authorId: c.userId,
        authorName: authorNameFrom(nameById.get(c.userId)),
        createdAt: c.createdAt.toISOString(),
        editedAt: c.editedAt ? c.editedAt.toISOString() : null,
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    }
  })

/** Post a comment as the signed-in viewer. */
export const createComment = createServerFn({ method: 'POST' })
  .validator(createCommentSchema)
  .handler(async ({ data }): Promise<CommentDto> => {
    const userId = await requireUserId()
    const { video } = await requirePlayableVideo(data.videoId, userId)

    const comment = await videoComments.create(video.id, userId, data.body)
    const author = await users.findById(userId)

    return {
      id: comment.id,
      videoId: comment.videoId,
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
    const editedAt = new Date()
    const updated = await videoComments.updateOwn(data.commentId, userId, data.body, editedAt)
    if (!updated) throw new Error(INTERACTION_ERRORS.commentNotFound)

    return { id: updated.id, body: updated.body, editedAt: editedAt.toISOString() }
  })

/**
 * Delete one of the viewer's own comments. Returns the video it belonged to so the
 * client knows which caches to refresh.
 */
export const deleteComment = createServerFn({ method: 'POST' })
  .validator(commentIdSchema)
  .handler(async ({ data }): Promise<{ id: string; videoId: string }> => {
    const userId = await requireUserId()
    const deleted = await videoComments.deleteOwn(data.commentId, userId)
    if (!deleted) throw new Error(INTERACTION_ERRORS.commentNotFound)

    return { id: deleted.id, videoId: deleted.videoId }
  })

/**
 * Count a share. Still unauthenticated by design — sharing a link is not an account
 * action, and there is no per-viewer share state to render — but the video itself
 * must be one this caller may watch.
 */
export const recordShare = createServerFn({ method: 'POST' })
  .validator(videoIdSchema)
  .handler(async ({ data }): Promise<{ shareCount: number }> => {
    const viewerId = await getUserId()
    // Gated like every other interaction: a premium video's share link is only worth
    // anything to someone who can already watch it.
    const { video } = await requirePlayableVideo(data.videoId, viewerId)

    const shareCount = await videos.incrementShare(video.id)

    return { shareCount }
  })
