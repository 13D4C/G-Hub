/**
 * Where a video is in the HLS/DASH transcoding pipeline.
 *
 * Deliberately alone in a module with no imports, for the same reason as
 * `video-visibility.ts`: the Mongoose schema imports it relatively (so `scripts/*.ts`
 * can load the model under plain `node --experimental-strip-types`) and the client
 * imports it through the `@/` alias. One list, so the enum the database enforces and
 * the badge a creator reads cannot drift apart.
 *
 * None of these states gates access. The original upload is public and playable
 * before the worker ever sees the video, so a `pending` or `failed` one plays exactly
 * as it did before this pipeline existed — the manifests are an optimisation layered
 * on top. That is what makes a broken worker a quality regression and never an outage.
 */
export const TRANSCODE_STATUSES = [
  'pending',
  'processing',
  'ready',
  'failed',
  'skipped',
] as const

export type TranscodeStatus = (typeof TRANSCODE_STATUSES)[number]

/**
 * Whether this status can still change on its own.
 *
 * Drives the watch page's poll interval, so an unknown or missing status has to count
 * as settled: a video row written before this pipeline existed has no `transcode` path
 * at all (`.lean()` does not apply defaults), and a client that polled forever against
 * a field the server does not know about is a worse failure than one that says nothing.
 */
export function isTranscodeSettled(status: string | null | undefined): boolean {
  return status !== 'pending' && status !== 'processing'
}

/**
 * What a viewer is told while the pipeline works. Empty for every state that needs no
 * explanation — `ready` is the normal case and silence is the right UI for it, and
 * `skipped` is an operator's decision a viewer cannot act on.
 *
 * `failed` deliberately does not offer a retry: the video is playing, and there is
 * nothing for the person watching it to do.
 */
export const TRANSCODE_VIEWER_NOTES: Record<TranscodeStatus, string> = {
  pending: "Preparing adaptive quality — you're watching the original upload.",
  processing: "Preparing adaptive quality — you're watching the original upload.",
  ready: '',
  failed: "Adaptive quality could not be prepared. You're watching the original upload.",
  skipped: '',
}

/** The creator-facing badge on the dashboard, where every state is worth naming. */
export const TRANSCODE_STATUS_LABELS: Record<TranscodeStatus, string> = {
  pending: 'Queued',
  processing: 'Processing',
  ready: 'Ready',
  failed: 'Failed',
  skipped: 'Skipped',
}
