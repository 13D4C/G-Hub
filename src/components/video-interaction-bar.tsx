import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Heart, MessageSquare, Share2 } from 'lucide-react'
import { SignInPrompt } from '@/components/sign-in-prompt'
import { TipButton } from '@/components/tip-button'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { describeMutationError, meQueryOptions } from '@/lib/auth'
import { copyToClipboard } from '@/lib/clipboard'
import { interactionKeys, interactionSummaryQueryOptions } from '@/lib/interactions'
import { recordShare, toggleVideoLike } from '@/server/functions/interactions'
import type { InteractionSummary } from '@/server/functions/interactions'
import type { VideoChannel } from '@/server/functions/videos'

/** Like / comment-count / share / tip row for the video currently playing. */
export function VideoInteractionBar({
  videoId,
  channel,
}: {
  videoId: string
  /** Null for videos uploaded before channels existed — those have nobody to tip. */
  channel: VideoChannel | null
}) {
  const queryClient = useQueryClient()
  const { data: viewer } = useQuery(meQueryOptions)
  const viewerId = viewer?.id ?? null

  const summaryKey = interactionKeys.summary(videoId, viewerId)
  const { data: summary } = useQuery(interactionSummaryQueryOptions(videoId, viewerId))

  const [shareNotice, setShareNotice] = useState<string>()
  /** Set only when the clipboard is unavailable, so the link can be copied by hand. */
  const [manualUrl, setManualUrl] = useState<string>()

  /**
   * Patch the cached summary rather than invalidating it: the mutation response is
   * already authoritative, so refetching would only add a round trip and a flicker.
   * The `prev ? ... : prev` guard makes a response that arrives before the query
   * resolves a no-op instead of a partial cache entry.
   */
  function patchSummary(changes: Partial<InteractionSummary>) {
    queryClient.setQueryData(summaryKey, (prev: InteractionSummary | undefined) =>
      prev ? { ...prev, ...changes } : prev,
    )
  }

  const like = useMutation({
    mutationFn: () => toggleVideoLike({ data: { videoId } }),
    onSuccess: (result) =>
      patchSummary({ viewerHasLiked: result.liked, likeCount: result.likeCount }),
  })

  const share = useMutation({
    mutationFn: () => recordShare({ data: { videoId } }),
    onSuccess: (result) => patchSummary({ shareCount: result.shareCount }),
  })

  async function handleShare() {
    // `window` is only read inside the handler — it does not exist during SSR.
    const url = `${window.location.origin}/video?id=${encodeURIComponent(videoId)}`
    const copied = await copyToClipboard(url)
    setShareNotice(copied ? 'Link copied.' : 'Copy this link:')
    setManualUrl(copied ? undefined : url)
    share.mutate()
  }

  const liked = summary?.viewerHasLiked ?? false
  // `—` while the summary is still loading, so the row never jumps from 0 to a count.
  const count = (value: number | undefined) => value ?? '—'

  const errorMessage = like.isError
    ? describeMutationError(like.error, 'Could not save your like. Please try again.')
    : share.isError
      ? describeMutationError(share.error, 'Could not record that share.')
      : undefined

  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {viewerId ? (
          <Button
            variant={liked ? 'default' : 'outline'}
            size="sm"
            onClick={() => like.mutate()}
            disabled={like.isPending}
            aria-pressed={liked}
            aria-label={liked ? 'Remove your like' : 'Like this video'}
          >
            <Heart className={liked ? 'fill-current' : undefined} />
            {count(summary?.likeCount)}
          </Button>
        ) : (
          <SignInPrompt redirect={`/video?id=${videoId}`} label="Sign in to like" />
        )}

        {/* A count, not a control — the comment thread is already below the player. */}
        <span className="flex items-center gap-1.5 px-2 text-sm text-muted-foreground">
          <MessageSquare className="size-4" />
          {count(summary?.commentCount)}
        </span>

        {/* Sharing needs no account, so this stays enabled for everyone. */}
        <Button variant="outline" size="sm" onClick={handleShare} disabled={share.isPending}>
          <Share2 />
          Share
          <span className="text-muted-foreground">{count(summary?.shareCount)}</span>
        </Button>

        {channel ? (
          <TipButton
            creatorId={channel.creatorId}
            creatorName={channel.name}
            currency={channel.currency}
            videoId={videoId}
            redirect={`/video?id=${videoId}`}
          />
        ) : null}

        {shareNotice ? (
          <span role="status" className="text-sm text-muted-foreground">
            {shareNotice}
          </span>
        ) : null}
      </div>

      {manualUrl ? (
        <Input
          value={manualUrl}
          readOnly
          aria-label="Video link"
          onFocus={(event) => event.currentTarget.select()}
        />
      ) : null}

      {errorMessage ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      ) : null}
    </div>
  )
}
