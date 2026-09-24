/**
 * Self-check for the transcode plan: the rendition ladder, the keyframe arithmetic, and
 * the exact ffmpeg argv.
 *
 * Run: npm run test:transcode-plan
 *
 * `transcode-plan.ts` imports only other import-free modules precisely so this can run
 * under plain `node --experimental-strip-types`, which resolves neither the `@/` alias nor
 * Mongoose. Same arrangement as `test-video-unlock.ts`.
 *
 * The reason this test exists at all: ffmpeg is not installed on every machine that works
 * on this repo, and the failures that matter most here are silent ones. A ladder that
 * upscales, a keyframe interval computed from the wrong frame rate, or an audio mapping
 * that disagrees with the adaptation sets all produce either a command that dies at startup
 * or — worse — segments that look fine until a viewer's connection changes and the player
 * tries to switch. Building the command as an array makes every one of those checkable
 * without encoding a single frame.
 */
import assert from 'node:assert/strict'
import {
  backoffMsFor,
  buildTranscodeArgs,
  contentTypeFor,
  displayDimensions,
  gopFramesFor,
  ladderForProbe,
  parseFrameRate,
  safeFileName,
  SEGMENT_SECONDS,
  type ProbeResult,
} from '../src/server/lib/transcode-plan.ts'

/** A landscape 1080p source with sound — the ordinary case every other case varies from. */
function probe(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    width: 1920,
    height: 1080,
    rotation: 0,
    fps: 30,
    durationSeconds: 120,
    hasAudio: true,
    ...over,
  }
}

/** The argv element following `flag`, which is how every ffmpeg option is spelled here. */
function valueAfter(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag)
  return at === -1 ? undefined : args[at + 1]
}

// --- the ladder: never upscale, never empty ---------------------------------------

{
  const rungs = ladderForProbe(probe({ width: 3840, height: 2160 }))
  assert.deepEqual(
    rungs.map((r) => r.height),
    [240, 360, 480, 720, 1080],
    'a 4K source is capped at the top rung rather than encoded at its own size',
  )
}

{
  const rungs = ladderForProbe(probe({ width: 854, height: 480 }))
  assert.deepEqual(
    rungs.map((r) => r.height),
    [240, 360, 480],
    'a 480p source gets no 720p rung — upscaling spends CPU to look worse',
  )
}

{
  const rungs = ladderForProbe(probe({ width: 426, height: 240 }))
  assert.deepEqual(rungs.map((r) => r.height), [240], 'a 240p source gets exactly its own rung')
}

{
  // Below every rung. The off-by-one to guard against is an empty ladder, which would be an
  // ffmpeg command with no outputs at all.
  const rungs = ladderForProbe(probe({ width: 356, height: 200 }))
  assert.equal(rungs.length, 1, 'a source below the lowest rung still gets one rung')
  assert.equal(rungs[0].height, 200, 'and that rung is its own size, not an upscale')
}

{
  const rungs = ladderForProbe(probe({ width: 300, height: 171 }))
  assert.equal(rungs[0].height % 2, 0, 'an odd short edge is rounded even for 4:2:0 chroma')
}

// --- orientation: the short edge is what the ladder measures ----------------------

{
  const portrait = probe({ width: 1080, height: 1920 })
  assert.deepEqual(
    ladderForProbe(portrait).map((r) => r.height),
    [240, 360, 480, 720, 1080],
    'a portrait 1080x1920 source ladders on its 1080 short edge, not its 1920 long one',
  )

  const args = buildTranscodeArgs({ sourcePath: '/s', outputDir: '/o', probe: portrait })
  const graph = valueAfter(args, '-filter_complex') ?? ''
  assert.ok(
    graph.includes('scale=w=720:h=-2'),
    'portrait states the width and lets ffmpeg compute the height',
  )
  assert.ok(
    !graph.includes('scale=w=-2:h=720'),
    'and must not use the landscape spelling, which would scale the long edge',
  )
}

{
  // A phone records 1920x1080 and tags it with a quarter turn; ffmpeg rotates on decode, so
  // the raw numbers describe a video nobody sees. Laddering them treats portrait as
  // landscape and letterboxes or upscales every rung.
  const rotated = probe({ width: 1920, height: 1080, rotation: -90 })
  assert.deepEqual(
    displayDimensions(rotated),
    { width: 1080, height: 1920 },
    'a quarter turn swaps the displayed axes',
  )

  const graph = valueAfter(
    buildTranscodeArgs({ sourcePath: '/s', outputDir: '/o', probe: rotated }),
    '-filter_complex',
  )
  assert.ok(graph?.includes('scale=w=720:h=-2'), 'a rotated source is laddered as portrait')
}

assert.deepEqual(
  displayDimensions(probe({ rotation: 180 })),
  { width: 1920, height: 1080 },
  'a half turn leaves the axes alone',
)
assert.deepEqual(
  displayDimensions(probe({ rotation: 270 })),
  { width: 1080, height: 1920 },
  '270 degrees is a quarter turn too',
)

// --- aspect ratio: one ratio across the whole ladder --------------------------------

{
  // The DASH muxer refuses to write a manifest whose adaptation set mixes aspect ratios,
  // and even-rounded widths produce exactly that mix (426x240 is 1.775, 640x360 is 1.778).
  // A source with sample-aspect metadata is compensated by scale on its own; one without —
  // an OBS screen recording, which is how this was found — fails at the header unless every
  // rung is pinned explicitly. Checked per rung, because one unpinned rung is enough.
  const cases: Array<[string, ProbeResult, string]> = [
    ['landscape', probe({ width: 1920, height: 1080 }), 'setdar=1920/1080'],
    ['portrait', probe({ width: 1080, height: 1920 }), 'setdar=1080/1920'],
    ['rotated', probe({ width: 1920, height: 1080, rotation: -90 }), 'setdar=1080/1920'],
  ]

  for (const [name, source, expected] of cases) {
    const graph = valueAfter(buildTranscodeArgs({ sourcePath: '/s', outputDir: '/o', probe: source }), '-filter_complex') ?? ''
    const rungFilters = graph.split(';').slice(1)
    assert.equal(rungFilters.length, ladderForProbe(source).length, `${name}: one filter chain per rung`)
    for (const chain of rungFilters) {
      assert.ok(
        chain.includes(`,${expected}[`),
        `${name}: every rung is pinned to the displayed ratio, got ${chain}`,
      )
    }
  }
}

// --- frame rate and keyframes ------------------------------------------------------

assert.ok(Math.abs(parseFrameRate('30000/1001') - 29.97) < 0.01, 'NTSC rational parses')
assert.equal(parseFrameRate('25/1'), 25, 'a whole rate parses')
assert.equal(parseFrameRate('0/0'), 30, 'a broken header falls back rather than throwing')
assert.equal(parseFrameRate(null), 30, 'a missing rate falls back')
assert.equal(parseFrameRate('garbage'), 30, 'an unparseable rate falls back')

// Integers only: a fractional -g is not a thing ffmpeg accepts, and the whole point of
// computing this is that every rung cuts keyframes on the same frame numbers.
assert.equal(gopFramesFor(29.97), 180, '29.97fps at 6s segments is 180 frames')
assert.equal(gopFramesFor(23.976), 144, '23.976fps at 6s segments is 144 frames')
assert.equal(gopFramesFor(60), 360, '60fps at 6s segments is 360 frames')
for (const fps of [23.976, 25, 29.97, 30, 50, 59.94, 60]) {
  assert.ok(Number.isInteger(gopFramesFor(fps)), `gop for ${fps}fps must be a whole number`)
}
assert.ok(gopFramesFor(0) > 0, 'a zero frame rate still produces a usable interval')

// --- the argv: segment alignment ---------------------------------------------------

{
  const args = buildTranscodeArgs({ sourcePath: '/s', outputDir: '/o', probe: probe({ fps: 29.97 }) })
  const gop = String(gopFramesFor(29.97))

  assert.equal(valueAfter(args, '-g'), gop, 'the keyframe interval comes from the probed rate')
  assert.equal(valueAfter(args, '-keyint_min'), gop, 'and the minimum matches it exactly')
  assert.equal(
    valueAfter(args, '-seg_duration'),
    String(SEGMENT_SECONDS),
    'segment length and the keyframe interval have to describe the same thing',
  )

  // Two spellings of one instruction, on purpose: newer ffmpeg deprecates the first for
  // libx264 and older builds ignore the second. A scene cut that only one rung inserts
  // misaligns the ladder, and nothing reports it until a viewer tries to switch.
  assert.equal(valueAfter(args, '-sc_threshold'), '0', 'scene-cut detection is off')
  assert.ok(
    (valueAfter(args, '-x264-params') ?? '').includes('scenecut=0'),
    'and off again in the spelling the other ffmpeg versions read',
  )
  assert.equal(valueAfter(args, '-fps_mode'), 'cfr', 'variable-rate sources are made constant')
}

// --- the argv: audio, which is the most common way an encode dies at startup -------

{
  const args = buildTranscodeArgs({ sourcePath: '/s', outputDir: '/o', probe: probe() })

  const audioMaps = args.filter((a) => a === '0:a:0')
  assert.equal(
    audioMaps.length,
    1,
    'audio is mapped exactly once for the whole ladder — once per rung would put the audio bytes into every variant',
  )
  assert.equal(
    valueAfter(args, '-adaptation_sets'),
    'id=0,streams=v id=1,streams=a',
    'and the adaptation sets name the audio that was actually mapped',
  )
}

{
  // A screen recording with no audio track. `-map 0:a:0` against it fails the whole encode
  // before a frame is written, and the adaptation sets have to drop audio in the same
  // breath — naming a set no stream was mapped into fails just as hard.
  const args = buildTranscodeArgs({ sourcePath: '/s', outputDir: '/o', probe: probe({ hasAudio: false }) })

  assert.ok(!args.some((a) => a.startsWith('0:a')), 'a silent source maps no audio')
  assert.ok(!args.includes('-c:a'), 'and configures no audio codec')
  assert.equal(
    valueAfter(args, '-adaptation_sets'),
    'id=0,streams=v',
    'and the adaptation sets agree — the two must never disagree',
  )
}

// --- the argv: shape and safety ----------------------------------------------------

{
  const args = buildTranscodeArgs({ sourcePath: '/tmp/gh-1/source', outputDir: '/tmp/gh-1/out', probe: probe() })

  // The whole no-shell invariant in one assertion: the path is its own argv element, so
  // nothing in it can be read as syntax however the file was named.
  assert.equal(
    args.filter((a) => a === '/tmp/gh-1/source').length,
    1,
    'the source path appears exactly once, as a single argv element',
  )
  assert.equal(valueAfter(args, '-i'), '/tmp/gh-1/source', 'and is the input')
  assert.equal(args[args.length - 1], '/tmp/gh-1/out/manifest.mpd', 'the manifest is the output')

  assert.equal(valueAfter(args, '-f'), 'dash', 'the dash muxer drives the encode')
  assert.equal(valueAfter(args, '-hls_playlist'), '1', 'and emits the HLS playlists too')
  assert.equal(valueAfter(args, '-hls_master_name'), 'master.m3u8', 'with a pinned master name')

  const rungs = ladderForProbe(probe())
  assert.equal(
    args.filter((a) => a === 'libx264').length,
    rungs.length,
    'one video encoder per rung',
  )
}

{
  const args = buildTranscodeArgs({
    sourcePath: '/s',
    outputDir: '/o',
    probe: probe({ width: 160, height: 90 }),
  })
  assert.ok(args.length > 0, 'a tiny source still produces a command rather than nothing')
}

// --- content types: one platform's failure, so easy to miss ------------------------

assert.equal(contentTypeFor('master.m3u8'), 'application/vnd.apple.mpegurl')
assert.equal(contentTypeFor('media_0.m3u8'), 'application/vnd.apple.mpegurl')
assert.equal(contentTypeFor('manifest.mpd'), 'application/dash+xml')
assert.equal(contentTypeFor('init-stream0.m4s'), 'video/mp4')
assert.equal(contentTypeFor('chunk-stream0-00001.m4s'), 'video/mp4')
assert.equal(contentTypeFor('SOURCE.MP4'), 'video/mp4', 'extensions are matched case-insensitively')
assert.equal(
  contentTypeFor('notes.txt'),
  'application/octet-stream',
  'an unknown extension gets the safe default rather than a guess',
)

// --- retry arithmetic --------------------------------------------------------------

{
  const delays = [1, 2, 3, 4, 5].map(backoffMsFor)
  for (let i = 1; i < delays.length; i += 1) {
    assert.ok(delays[i] >= delays[i - 1], 'backoff never shortens between attempts')
  }
  assert.equal(backoffMsFor(1), 60_000, 'the first retry waits a minute')
  assert.ok(delays.every((d) => d <= 60 * 60_000), 'and no retry is ever pushed out past an hour')
}

// --- file names, which reach both a storage key and a temp path --------------------

// Spelled this way rather than as a literal because the separator is awkward to quote
// through the layers between here and the file, and a test that silently lost it would
// stop checking the thing it exists to check.
const SEP = String.fromCharCode(92)

const hostileNames = [
  '../../etc/passwd',
  'a/b.mp4',
  '..',
  '....//x',
  `${SEP}windows${SEP}system.mp4`,
  '-rf something.mp4',
  '.hidden.mp4',
]

for (const hostile of hostileNames) {
  const safe = safeFileName(hostile)
  assert.ok(!safe.includes('/'), `${hostile} must not keep a path separator`)
  assert.ok(!safe.includes(SEP), `${hostile} must not keep the other path separator`)
  assert.ok(!safe.includes('..'), `${hostile} must not keep a parent reference`)
  assert.ok(!safe.startsWith('.'), `${hostile} must not become a dotfile`)
  assert.ok(!safe.startsWith('-'), `${hostile} must not start like a command-line flag`)
  assert.ok(safe.length > 0, `${hostile} must still yield a usable name`)
}

assert.equal(safeFileName('holiday clip.mp4'), 'holiday-clip.mp4', 'an ordinary name survives readably')
assert.equal(safeFileName(''), 'upload', 'an empty name gets a placeholder rather than an empty key')
assert.ok(safeFileName('x'.repeat(400)).length <= 120, 'an absurd name is capped')

// Non-Latin names survive intact. The first version of this allowed ASCII only, which
// silently reduced every Thai filename to its extension — the uploads on this project are
// mostly Thai, so the whole library would have landed under anonymous keys.
assert.equal(safeFileName('ความรัก.mp4'), 'ความรัก.mp4', 'Thai survives, tone and vowel marks included')
assert.equal(
  safeFileName('ไอก้องโดนตอก67.mp4'),
  'ไอก้องโดนตอก67.mp4',
  'and so do the combining marks that Thai writes its vowels with',
)
assert.equal(safeFileName('日本語のビデオ.MP4'), '日本語のビデオ.mp4', 'Japanese survives; the extension is normalised')

// The extension is reattached separately, so a stem that sanitises away to nothing still
// produces a usable, typed name rather than a bare placeholder.
assert.equal(safeFileName('....mp4'), 'upload.mp4', 'a name that is all punctuation keeps its type')

console.log('transcode plan: all checks passed')
