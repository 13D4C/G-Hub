/**
 * Self-check for the player's quality menu.
 *
 * Run: npm run test:video-quality
 *
 * `video-quality.ts` has no imports at all precisely so this can run under plain `node
 * --experimental-strip-types`, which resolves neither the `@/` alias nor anything the browser
 * bundle pulls in. Same arrangement as `test-video-sources.ts`.
 *
 * The menu is built from whatever the manifest happens to list, not from the ladder the
 * encoder was asked for — a source shorter than 1080p produces fewer renditions, and a
 * browser that cannot decode one sees it dropped before it ever reaches here. So the cases
 * worth pinning are the awkward shapes: one rendition, none, unsorted input, and two
 * renditions that claim the same height.
 */
import assert from 'node:assert/strict'
import {
  AUTO_QUALITY_ID,
  formatKbps,
  formatRenditionLabel,
  qualityOptionsFrom,
  renditionForHeight,
  sortedByQuality,
  type SelectableRendition,
} from '../src/lib/video-quality.ts'

/** A four-rung manifest, listed worst-first the way a playlist usually is. */
const ladder: SelectableRendition[] = [
  { height: 240, bandwidth: 531_918 },
  { height: 360, bandwidth: 931_918 },
  { height: 480, bandwidth: 1_531_918 },
  { height: 720, bandwidth: 2_931_918 },
]

// --- the menu ----------------------------------------------------------------------

{
  const options = qualityOptionsFrom(ladder)

  assert.equal(options[0].id, AUTO_QUALITY_ID, 'Auto is always the first option')
  assert.equal(options[0].height, null, 'and selects no particular rendition')
  assert.equal(options[0].detail, '', 'Auto has no bitrate of its own to show')

  assert.deepEqual(
    options.slice(1).map((o) => o.label),
    ['720p', '480p', '360p', '240p'],
    'best quality first, which is the order every familiar player uses',
  )

  assert.equal(options.length, ladder.length + 1, 'every rendition is offered, plus Auto')
  assert.equal(
    new Set(options.map((o) => o.id)).size,
    options.length,
    'ids are used as list keys and radio values, so they have to be unique',
  )
  assert.equal(options[1].detail, '2932 kbps', 'each option shows what it will cost to play')
}

// --- shapes the manifest can actually take ------------------------------------------

{
  // A 240p source encodes to exactly one rung. Auto is still offered: it is the default, and
  // a menu whose default disappeared in some cases would be stranger than a redundant entry.
  const options = qualityOptionsFrom([{ height: 240, bandwidth: 531_918 }])
  assert.equal(options.length, 2)
  assert.equal(options[0].id, AUTO_QUALITY_ID)
  assert.equal(options[1].label, '240p')
}

assert.deepEqual(
  qualityOptionsFrom([]),
  [],
  'no renditions means no menu at all — the caller uses that to explain why there is nothing to pick',
)

{
  // Playlists arrive in whatever order the manifest lists them.
  const shuffled: SelectableRendition[] = [
    { height: 480, bandwidth: 1_531_918 },
    { height: 720, bandwidth: 2_931_918 },
    { height: 240, bandwidth: 531_918 },
  ]
  assert.deepEqual(
    sortedByQuality(shuffled).map((r) => r.height),
    [720, 480, 240],
    'the menu imposes its own order rather than trusting the manifest',
  )

  const before = [...shuffled]
  sortedByQuality(shuffled)
  assert.deepEqual(shuffled, before, 'and does not reorder the caller array in place')
}

// --- resolving a choice back to a rendition ------------------------------------------

assert.equal(renditionForHeight(ladder, 720)?.bandwidth, 2_931_918)
assert.equal(renditionForHeight(ladder, null), null, 'Auto resolves to no particular rendition')
assert.equal(
  renditionForHeight(ladder, 1080),
  null,
  'a height this manifest does not carry resolves to nothing rather than guessing',
)

{
  // Two renditions of the same size at different bitrates is legal in a manifest, and the
  // menu would otherwise be ambiguous about which one "720p" means.
  const duplicated: SelectableRendition[] = [
    { height: 720, bandwidth: 1_800_000 },
    { height: 720, bandwidth: 2_931_918 },
  ]
  assert.equal(
    renditionForHeight(duplicated, 720)?.bandwidth,
    2_931_918,
    'where two renditions share a height, asking for it gets the better one',
  )
}

// --- labels ---------------------------------------------------------------------------

assert.equal(formatRenditionLabel({ height: 1080, bandwidth: 1 }), '1080p')
assert.equal(formatKbps(2_931_918), '2932 kbps')
assert.equal(formatKbps(531_918), '532 kbps')

console.log('video quality: all checks passed')
