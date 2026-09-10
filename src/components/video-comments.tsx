import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { SignInPrompt } from '@/components/sign-in-prompt'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { describeMutationError, meQueryOptions } from '@/lib/auth'
import { COMMENT_MAX_LENGTH } from '@/lib/interaction-errors'
import { commentsQueryOptions, formatCommentTime, interactionKeys } from '@/lib/interactions'
import {
  createComment,
  deleteComment,
  listComments,
  updateComment,
} from '@/server/functions/interactions'
import type { CommentDto } from '@/server/functions/interactions'

/** Comment thread for one video: compose, list, and edit or delete your own. */
export function VideoComments({ videoId }: { videoId: string }) {
  const queryClient = useQueryClient()
  const { data: viewer } = useQuery(meQueryOptions)
  const { data: page, isPending } = useQuery(commentsQueryOptions(videoId))
  const [editingId, setEditingId] = useState<string | null>(null)

  /**
   * Refresh the thread, and the summary's comment count when it changed. Both are
   * invalidated by key — never `router.invalidate()`, which would re-run the `/video`
   * loader and restart the video.
   */
  async function refresh({ countChanged }: { countChanged: boolean }) {
    await queryClient.invalidateQueries({ queryKey: interactionKeys.comments(videoId) })
    if (countChanged) {
      await queryClient.invalidateQueries({ queryKey: interactionKeys.summaryPrefix(videoId) })
    }
  }

  const add = useMutation({
    mutationFn: (body: string) => createComment({ data: { videoId, body } }),
    onSuccess: () => refresh({ countChanged: true }),
  })

  const edit = useMutation({
    mutationFn: (vars: { commentId: string; body: string }) => updateComment({ data: vars }),
    onSuccess: async () => {
      setEditingId(null)
      // An edit cannot change the count, so the summary is left alone.
      await refresh({ countChanged: false })
    },
  })

  const remove = useMutation({
    mutationFn: (commentId: string) => deleteComment({ data: { commentId } }),
    onSuccess: () => refresh({ countChanged: true }),
  })

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const body = String(new FormData(form).get('body') ?? '').trim()
    if (!body) return
    add.mutate(body, { onSuccess: () => form.reset() })
  }

  function handleEdit(event: React.FormEvent<HTMLFormElement>, commentId: string) {
    event.preventDefault()
    const body = String(new FormData(event.currentTarget).get('body') ?? '').trim()
    if (!body) return
    edit.mutate({ commentId, body })
  }

  const errorMessage = add.isError
    ? describeMutationError(add.error, 'Could not post your comment. Please try again.')
    : edit.isError
      ? describeMutationError(edit.error, 'Could not save your changes.')
      : remove.isError
        ? describeMutationError(remove.error, 'Could not delete that comment.')
        : undefined

  const comments = page?.comments ?? []

  return (
    <div className="flex flex-col gap-6">
      {viewer ? (
        <form onSubmit={handleSubmit} className="flex flex-col gap-2">
          <Label htmlFor="body" className="sr-only">
            Add a comment
          </Label>
          <Textarea
            id="body"
            name="body"
            rows={3}
            required
            maxLength={COMMENT_MAX_LENGTH}
            placeholder="Add a comment…"
          />
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={add.isPending}>
              {add.isPending ? 'Posting…' : 'Comment'}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex items-center gap-3">
          <p className="text-sm text-muted-foreground">Join the conversation.</p>
          <SignInPrompt redirect={`/video?id=${videoId}`} label="Sign in to comment" />
        </div>
      )}

      {errorMessage ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      ) : null}

      {isPending ? (
        <p className="text-sm text-muted-foreground">Loading comments…</p>
      ) : comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments yet. Be the first.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {comments.map((comment) => (
            <li key={comment.id} className="flex flex-col gap-1.5 border-b pb-4 last:border-b-0">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-medium">{comment.authorName}</span>
                <time dateTime={comment.createdAt} className="text-xs text-muted-foreground">
                  {formatCommentTime(comment.createdAt)}
                  {comment.editedAt ? ' (edited)' : null}
                </time>
              </div>

              {editingId === comment.id ? (
                <form
                  onSubmit={(event) => handleEdit(event, comment.id)}
                  className="flex flex-col gap-2"
                >
                  <Label htmlFor={`edit-${comment.id}`} className="sr-only">
                    Edit your comment
                  </Label>
                  <Textarea
                    id={`edit-${comment.id}`}
                    name="body"
                    rows={3}
                    required
                    maxLength={COMMENT_MAX_LENGTH}
                    defaultValue={comment.body}
                  />
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={edit.isPending}>
                      {edit.isPending ? 'Saving…' : 'Save'}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditingId(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <>
                  <p className="text-sm whitespace-pre-wrap">{comment.body}</p>
                  {/* Cosmetic only — the server enforces ownership in the query filter. */}
                  {comment.authorId === viewer?.id ? (
                    <CommentOwnerActions
                      comment={comment}
                      onEdit={() => setEditingId(comment.id)}
                      onDelete={() => remove.mutate(comment.id)}
                      deleting={remove.isPending && remove.variables === comment.id}
                    />
                  ) : null}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {page?.nextCursor ? <LoadMore videoId={videoId} cursor={page.nextCursor} /> : null}
    </div>
  )
}

function CommentOwnerActions({
  comment,
  onEdit,
  onDelete,
  deleting,
}: {
  comment: CommentDto
  onEdit: () => void
  onDelete: () => void
  deleting: boolean
}) {
  return (
    <div className="flex gap-1">
      <Button type="button" size="sm" variant="ghost" onClick={onEdit}>
        Edit
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={onDelete}
        disabled={deleting}
        aria-label={`Delete your comment posted ${formatCommentTime(comment.createdAt)}`}
      >
        {deleting ? 'Deleting…' : 'Delete'}
      </Button>
    </div>
  )
}

/**
 * Appends the next keyset page into the cached thread. Kept separate so the paging
 * state does not live in the main component.
 */
function LoadMore({ videoId, cursor }: { videoId: string; cursor: string }) {
  const queryClient = useQueryClient()

  const more = useMutation({
    mutationFn: () => listComments({ data: { videoId, cursor, limit: 20 } }),
    onSuccess: (next) => {
      queryClient.setQueryData(
        interactionKeys.comments(videoId),
        (prev: { comments: Array<CommentDto>; nextCursor: string | null } | undefined) =>
          prev
            ? { comments: [...prev.comments, ...next.comments], nextCursor: next.nextCursor }
            : next,
      )
    },
  })

  return (
    <div>
      <Button variant="outline" size="sm" onClick={() => more.mutate()} disabled={more.isPending}>
        {more.isPending ? 'Loading…' : 'Load more comments'}
      </Button>
    </div>
  )
}
