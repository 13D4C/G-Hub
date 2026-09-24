/**
 * Self-check for the transcode status vocabulary — which states are still moving, and what
 * each one says to a viewer.
 *
 * Run: npm run test:transcode-status
 *
 * `transcode-status.ts` has no imports at all, so this runs under plain `node
 * --experimental-strip-types`. Same arrangement as `test-video-unlock.ts`.
 *
 * Small, but it pins two things that would otherwise fail quietly in opposite directions:
 * a status the client treats as unfinished forever (so the watch page polls a video that
 * will never change again, on the app's busiest route), and a status added to the enum
 * without copy to go with it (so a creator sees an empty badge).
 */
import assert from 'node:assert/strict'
import {
  isTranscodeSettled,
  TRANSCODE_STATUS_LABELS,
  TRANSCODE_STATUSES,
  TRANSCODE_VIEWER_NOTES,
  type TranscodeStatus,
} from '../src/lib/transcode-status.ts'

// --- which states are still moving --------------------------------------------------

assert.equal(isTranscodeSettled('pending'), false, 'a queued video is still going to change')
assert.equal(isTranscodeSettled('processing'), false, 'so is one being encoded')

assert.equal(isTranscodeSettled('ready'), true)
assert.equal(isTranscodeSettled('failed'), true, 'a failure is final — attempts are already spent')
assert.equal(isTranscodeSettled('skipped'), true, 'a skip is a decision, not a stage')

// --- the states that are not states at all ------------------------------------------

// A row written before this pipeline existed has no `transcode` path at all, because
// `.lean()` does not apply schema defaults. The client must read that as "nothing is
// happening" rather than as "still working": polling forever against a field the server
// does not know about is a worse failure than showing no note.
assert.equal(isTranscodeSettled(undefined), true, 'a legacy row with no transcode path is settled')
assert.equal(isTranscodeSettled(null), true, 'and so is an explicit null')
assert.equal(
  isTranscodeSettled('a-state-from-a-newer-deploy'),
  true,
  'an unrecognised status is settled too — an unknown state must not start an endless timer',
)

// --- every state has copy ------------------------------------------------------------

for (const status of TRANSCODE_STATUSES) {
  assert.ok(
    TRANSCODE_STATUS_LABELS[status as TranscodeStatus]?.length > 0,
    `${status} needs a dashboard label`,
  )
  assert.equal(
    typeof TRANSCODE_VIEWER_NOTES[status as TranscodeStatus],
    'string',
    `${status} needs a viewer note, even if it is deliberately empty`,
  )
}

// Silence is the right UI for the normal case, and for a decision a viewer cannot act on.
assert.equal(TRANSCODE_VIEWER_NOTES.ready, '', 'a ready video says nothing')
assert.equal(TRANSCODE_VIEWER_NOTES.skipped, '', 'nor does a skipped one')
assert.ok(TRANSCODE_VIEWER_NOTES.pending.length > 0, 'a waiting viewer is told why')
assert.ok(
  TRANSCODE_VIEWER_NOTES.failed.length > 0,
  'and a failure explains that the video they are watching is the original',
)

{
  const unique = new Set(TRANSCODE_STATUSES)
  assert.equal(unique.size, TRANSCODE_STATUSES.length, 'the enum has no duplicates')
}

console.log('transcode status: all checks passed')
