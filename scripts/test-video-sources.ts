/**
 * Self-check for the player's source list — which format the player reaches for first,
 * and what it falls back to.
 *
 * Run: npm run test:video-sources
 *
 * `video-sources.ts` has no imports at all precisely so this can run under plain `node
 * --experimental-strip-types`, which resolves neither the `@/` alias nor anything the
 * browser bundle pulls in. Same arrangement as `test-video-price.ts`.
 *
 * The list is ordered policy rather than preference: video.js plays the first entry some
 * registered handler claims, so the tail of this array is the answer to "what happens when
 * adaptive playback is not available" — a transcode that has not finished, or one that
 * failed outright. Once it has finished the server withholds the original, and the list
 * must then be the manifests alone.
 */
import assert from 'node:assert/strict'
import {
  buildVideoSources,
  isAdaptiveSource,
  VIDEO_MIME,
} from '../src/lib/video-sources.ts'

const HLS = 'https://media.example/v/abc/master.m3u8'
const DASH = 'https://media.example/v/abc/manifest.mpd'
const MP4 = 'https://media.example/v/abc/source.mp4'

// --- the ready case: best format first, original last ------------------------------

{
  const sources = buildVideoSources({ hlsUrl: HLS, dashUrl: DASH, mp4Url: MP4 })
  assert.deepEqual(sources, [
    { src: HLS, type: VIDEO_MIME.hls },
    { src: DASH, type: VIDEO_MIME.dash },
    { src: MP4, type: VIDEO_MIME.mp4 },
  ])
}

// HLS leads because it is the only adaptive format anything plays without MSE: on Safari
// and iOS it degrades to native playback. Leading with DASH would skip straight past that
// to the progressive file and throw the adaptive path away on those devices.
assert.equal(
  buildVideoSources({ hlsUrl: HLS, dashUrl: DASH, mp4Url: MP4 })[0].type,
  VIDEO_MIME.hls,
  'HLS is offered before DASH',
)

// --- one manifest, or none ----------------------------------------------------------

assert.deepEqual(
  buildVideoSources({ hlsUrl: HLS, mp4Url: MP4 }),
  [{ src: HLS, type: VIDEO_MIME.hls }, { src: MP4, type: VIDEO_MIME.mp4 }],
  'HLS alone still falls back to the original',
)

assert.deepEqual(
  buildVideoSources({ dashUrl: DASH, mp4Url: MP4 }),
  [{ src: DASH, type: VIDEO_MIME.dash }, { src: MP4, type: VIDEO_MIME.mp4 }],
  'DASH alone still falls back to the original',
)

assert.deepEqual(
  buildVideoSources({ mp4Url: MP4 }),
  [{ src: MP4, type: VIDEO_MIME.mp4 }],
  'a video with no transcode yet plays exactly as it did before this pipeline existed',
)

// --- absent means absent, in all the spellings the server can produce --------------

for (const blank of [null, undefined, '', '   ']) {
  assert.deepEqual(
    buildVideoSources({ hlsUrl: blank, dashUrl: blank, mp4Url: MP4 }),
    [{ src: MP4, type: VIDEO_MIME.mp4 }],
    `${JSON.stringify(blank)} counts as "no manifest"`,
  )
}

{
  // A half-written row: the status says ready but only one url landed. It must degrade to
  // what it does have rather than emit an entry the player would try and fail to load.
  const sources = buildVideoSources({ hlsUrl: '', dashUrl: DASH, mp4Url: MP4 })
  assert.equal(sources.length, 2, 'a missing HLS url is skipped, not emitted empty')
  assert.ok(
    sources.every((s) => s.src.length > 0),
    'no source may ever carry an empty src',
  )
}

// --- the invariants the player depends on ------------------------------------------

{
  const withOriginal = [
    buildVideoSources({ hlsUrl: HLS, dashUrl: DASH, mp4Url: MP4 }),
    buildVideoSources({ hlsUrl: HLS, mp4Url: MP4 }),
    buildVideoSources({ dashUrl: DASH, mp4Url: MP4 }),
    buildVideoSources({ mp4Url: MP4 }),
  ]

  for (const sources of withOriginal) {
    // While the original is offered at all it is the last resort, never ahead of a manifest.
    assert.equal(
      sources[sources.length - 1].type,
      VIDEO_MIME.mp4,
      'the original file, when present, is always the last resort',
    )
    assert.ok(sources.length > 0, 'a playable video always yields at least one source')
  }
}

{
  // A transcoded video: the server withholds the original once the adaptive stream can
  // replace it, so the list is the manifests alone — the whole-file download is gone.
  // No progressive entry is invented when the server sent none.
  assert.deepEqual(buildVideoSources({ hlsUrl: HLS, dashUrl: DASH, mp4Url: '' }), [
    { src: HLS, type: VIDEO_MIME.hls },
    { src: DASH, type: VIDEO_MIME.dash },
  ])
}

{
  // A locked row: every url blanked, and a source list built from that offers nothing.
  assert.deepEqual(buildVideoSources({ hlsUrl: '', dashUrl: '', mp4Url: '' }), [])
  assert.deepEqual(buildVideoSources({ mp4Url: null }), [])
}

// --- the MIME strings themselves ----------------------------------------------------

// Asserted literally, capital URL and all. The adaptive engine lowercases before matching
// and would not notice a tidied spelling, but the native fallback goes through
// `canPlayType`, which would — so a drift here breaks exactly one platform, on exactly the
// path that has no adaptive engine left to save it.
assert.equal(VIDEO_MIME.hls, 'application/x-mpegURL')
assert.equal(VIDEO_MIME.dash, 'application/dash+xml')
assert.equal(VIDEO_MIME.mp4, 'video/mp4')

assert.equal(isAdaptiveSource(VIDEO_MIME.hls), true)
assert.equal(isAdaptiveSource(VIDEO_MIME.dash), true)
assert.equal(
  isAdaptiveSource(VIDEO_MIME.mp4),
  false,
  'the progressive file offers nothing to switch between, which is what the quality panel needs to know',
)

console.log('video sources: all checks passed')
