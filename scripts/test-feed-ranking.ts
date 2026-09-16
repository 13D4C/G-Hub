/**
 * Self-check for the personalized feed's ordering rule, and for the labels that
 * explain it.
 *
 * Run: npm run test:feed-ranking
 *
 * `feed-ranking.ts` and `feed-reason.ts` import nothing that reaches Mongoose
 * precisely so this can run under plain `node --experimental-strip-types`. Same
 * arrangement as `test-tier-access.ts`.
 *
 * `rankFeed` takes `nowMs` as an argument, so every age below is stated rather than
 * waited for and no assertion here depends on the wall clock.
 */
import assert from 'node:assert/strict'
import {
  DEFAULT_FEED_WEIGHTS,
  NO_SIGNALS,
  mergeCandidatePools,
  rankFeed,
  type FeedCandidate,
  type ViewerSignals,
} from '../src/server/lib/feed-ranking.ts'
import { feedReasonLabel } from '../src/lib/feed-reason.ts'

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0)
const HOUR = 3_600_000
const DAY = 24 * HOUR

function video(id: string, over: Partial<FeedCandidate> = {}): FeedCandidate {
  return {
    id,
    creatorId: `creator-${id}`,
    createdAtMs: NOW - DAY,
    viewCount: 0,
    likeCount: 0,
    fromSubscription: false,
    ...over,
  }
}

function signals(over: Partial<ViewerSignals> = {}): ViewerSignals {
  return { ...NO_SIGNALS, ...over }
}

/** The ids in ranked order — what almost every assertion here is really about. */
function order(candidates: FeedCandidate[], viewerSignals = NO_SIGNALS): string[] {
  return rankFeed(candidates, viewerSignals, NOW).map((row) => row.id)
}

// --- degenerate input -------------------------------------------------------------
assert.deepEqual(rankFeed([], NO_SIGNALS, NOW), [], 'no candidates, no feed')

// --- recency ----------------------------------------------------------------------
{
  const fresh = video('fresh', { createdAtMs: NOW - 2 * HOUR })
  const stale = video('stale', { createdAtMs: NOW - 30 * DAY })
  assert.deepEqual(order([stale, fresh]), ['fresh', 'stale'], 'newer wins, all else equal')
}

// A future timestamp clamps rather than scoring above a brand-new video — clock skew
// and seeded fixtures both produce these.
{
  const future = video('future', { createdAtMs: NOW + 5 * DAY })
  const now = video('now', { createdAtMs: NOW })
  const ranked = rankFeed([future, now], NO_SIGNALS, NOW)
  assert.equal(ranked[0].score, ranked[1].score, 'a future video does not outscore a current one')
}

// --- trending decays with age -----------------------------------------------------
// The headline property: popularity alone must never hold the top of the feed
// forever. An old hit loses to a fresh unknown because its popularity is multiplied
// by a recency that has fallen.
{
  const oldHit = video('old-hit', { createdAtMs: NOW - 200 * DAY, viewCount: 50_000 })
  const newcomer = video('newcomer', { createdAtMs: NOW - 2 * HOUR, viewCount: 3 })
  assert.deepEqual(order([oldHit, newcomer]), ['newcomer', 'old-hit'], 'age beats an old hit')
}

// Among videos of the same age, popularity is what separates them.
{
  const popular = video('popular', { viewCount: 5_000 })
  const quiet = video('quiet', { viewCount: 1 })
  assert.deepEqual(order([quiet, popular]), ['popular', 'quiet'], 'engagement breaks a tie on age')
}

// A like counts for more than a view, because it costs a deliberate click.
{
  const liked = video('liked', { likeCount: 10 })
  const viewed = video('viewed', { viewCount: 10 })
  assert.deepEqual(order([viewed, liked]), ['liked', 'viewed'], 'a like outweighs a view')
}

// --- subscriptions ----------------------------------------------------------------
{
  const sub = video('sub', { creatorId: 'paid-creator', fromSubscription: true })
  const pub = video('pub', { creatorId: 'other-creator' })
  const me = signals({ subscribedCreatorIds: ['paid-creator'] })
  assert.deepEqual(
    rankFeed([pub, sub], me, NOW).map((r) => r.id),
    ['sub', 'pub'],
    'a subscribed upload beats a same-age public one',
  )
}

// The flag alone is not enough: a candidate mislabelled `fromSubscription` by a
// caller must not collect a boost for a channel the viewer does not pay for.
{
  const mislabelled = video('mislabelled', { creatorId: 'stranger', fromSubscription: true })
  const ranked = rankFeed([mislabelled], NO_SIGNALS, NOW)
  assert.equal(ranked[0].reason, 'new', 'no subscription, no subscription reason')
}

// --- affinity ---------------------------------------------------------------------
{
  const watchedChannel = video('affine', { creatorId: 'familiar' })
  const strangerChannel = video('stranger', { creatorId: 'unknown' })
  const me = signals({ creatorWatchCounts: { familiar: 3 } })
  assert.deepEqual(
    rankFeed([strangerChannel, watchedChannel], me, NOW).map((r) => r.id),
    ['affine', 'stranger'],
    'a channel you keep watching outranks one you never have',
  )
}

// Affinity saturates, so a single obsessively-rewatched channel cannot run away with
// the feed as the count climbs.
{
  const at = (count: number) =>
    rankFeed([video('v', { creatorId: 'c' })], signals({ creatorWatchCounts: { c: count } }), NOW)[0]
      .score
  const saturation = DEFAULT_FEED_WEIGHTS.affinitySaturation
  assert.equal(at(saturation), at(saturation * 10), 'affinity is capped')
  assert.ok(at(1) < at(saturation), 'and climbs up to the cap')
}

// --- seen videos are demoted, not dropped -----------------------------------------
{
  const seen = video('seen', { createdAtMs: NOW - HOUR })
  const unseen = video('unseen', { createdAtMs: NOW - 2 * DAY })
  const me = signals({ watchedVideoIds: ['seen'] })
  const ranked = rankFeed([seen, unseen], me, NOW)
  assert.deepEqual(
    ranked.map((r) => r.id),
    ['unseen', 'seen'],
    'a watched video falls behind a comparable unwatched one',
  )
  assert.equal(ranked.length, 2, 'but is still in the feed — a filter would empty the page')
}

// --- videos with no creator -------------------------------------------------------
// `video.uploadedBy` is optional, so these exist. They must not crash, must not
// collect a subscription boost, and must not be caught by the per-creator cap.
{
  const orphans = [
    video('orphan-1', { creatorId: null, fromSubscription: true }),
    video('orphan-2', { creatorId: null }),
    video('orphan-3', { creatorId: null }),
    video('orphan-4', { creatorId: null }),
  ]
  const me = signals({ subscribedCreatorIds: ['whoever'] })
  const ranked = rankFeed(orphans, me, NOW)
  assert.equal(ranked.length, 4, 'every creatorless video survives')
  assert.ok(
    ranked.every((row) => row.reason !== 'subscription'),
    'a creatorless video is never "from a channel you subscribe to"',
  )
}

// --- per-creator diversity cap ----------------------------------------------------
// Without this one prolific creator owns every slot above the fold, which is the most
// likely way the feed looks broken on a small seeded database.
{
  const hogs = Array.from({ length: 5 }, (_, i) =>
    video(`hog-${i}`, { creatorId: 'prolific', createdAtMs: NOW - i * HOUR }),
  )
  const other = video('other', { creatorId: 'someone-else', createdAtMs: NOW - 10 * DAY })
  const ranked = rankFeed([...hogs, other], NO_SIGNALS, NOW).map((r) => r.id)

  assert.equal(ranked.length, 6, 'demoted, not dropped')
  const cap = DEFAULT_FEED_WEIGHTS.maxPerCreator
  assert.equal(
    ranked.slice(0, cap).every((id) => id.startsWith('hog-')),
    true,
    'the cap lets the first few through',
  )
  assert.equal(
    ranked[cap],
    'other',
    'a much older video from another creator still beats the overflow',
  )
}

// --- determinism ------------------------------------------------------------------
// The candidate array is assembled by deduping across two queries, so its input order
// is not stable between runs. The output must be.
{
  const pool = [
    video('a', { viewCount: 100 }),
    video('b', { viewCount: 100 }),
    video('c', { createdAtMs: NOW - 3 * DAY }),
    video('d', { creatorId: null }),
    video('e', { likeCount: 4 }),
  ]
  const baseline = order(pool)
  const shuffles = [
    [pool[4], pool[0], pool[3], pool[1], pool[2]],
    [pool[2], pool[3], pool[4], pool[1], pool[0]],
    [...pool].reverse(),
  ]
  for (const shuffled of shuffles) {
    assert.deepEqual(order(shuffled), baseline, 'input order does not change the ranking')
  }
}

// Two candidates identical but for their id break the tie by id, not by luck.
{
  const twins = [video('zzz', { creatorId: 'c' }), video('aaa', { creatorId: 'c' })]
  assert.deepEqual(order(twins), ['aaa', 'zzz'])
  assert.deepEqual(order([...twins].reverse()), ['aaa', 'zzz'])
}

// --- reasons ----------------------------------------------------------------------
{
  const me = signals({
    subscribedCreatorIds: ['paid'],
    creatorWatchCounts: { familiar: 2 },
  })
  const ranked = rankFeed(
    [
      video('s', { creatorId: 'paid', fromSubscription: true }),
      video('a', { creatorId: 'familiar' }),
      video('t', { creatorId: 'hot', viewCount: 8_000, createdAtMs: NOW - HOUR }),
      video('n', { creatorId: 'nobody' }),
    ],
    me,
    NOW,
  )
  const reasonById = new Map(ranked.map((row) => [row.id, row.reason]))
  assert.equal(reasonById.get('s'), 'subscription')
  assert.equal(reasonById.get('a'), 'affinity')
  assert.equal(reasonById.get('t'), 'trending')
  assert.equal(reasonById.get('n'), 'new', 'an unremarkable video claims nothing')
}

// --- merging the two candidate pools ----------------------------------------------
{
  const row = (id: string) => ({ _id: id })
  const idOf = (r: { _id: string }) => r._id

  // The rule worth a test: a video in both pools keeps its subscription flag. Reverse
  // the two loops and every subscribed creator's recent upload silently loses its
  // boost — a feed that still looks plausible and ranks wrongly.
  const merged = mergeCandidatePools([row('both'), row('sub-only')], [row('both'), row('new')], idOf)

  assert.deepEqual(
    merged.map((m) => m.id),
    ['both', 'sub-only', 'new'],
    'each video appears once, subscribed pool first',
  )
  assert.equal(
    merged.find((m) => m.id === 'both')?.fromSubscription,
    true,
    'a video in both pools is still from a subscription',
  )
  assert.equal(merged.find((m) => m.id === 'new')?.fromSubscription, false)

  // Degenerate inputs the caller really produces: no subscriptions at all is the
  // anonymous and cold-start case, and it must not lose the recent pool.
  assert.deepEqual(mergeCandidatePools([], [row('a')], idOf).map((m) => m.id), ['a'])
  assert.deepEqual(mergeCandidatePools([row('a')], [], idOf).map((m) => m.id), ['a'])
  assert.deepEqual(mergeCandidatePools([], [], idOf), [])

  // A pool repeating an id — which a paginated query can produce — must not duplicate.
  assert.equal(mergeCandidatePools([row('x'), row('x')], [row('x')], idOf).length, 1)

  // The row itself survives, since the caller maps back through it to summarize.
  const carried = mergeCandidatePools([{ _id: 'k', title: 'kept' }], [], (r) => r._id)
  assert.equal(carried[0].row.title, 'kept')
}

// --- labels -----------------------------------------------------------------------
assert.equal(feedReasonLabel('subscription', 'Reef TV'), 'New from Reef TV')
assert.equal(feedReasonLabel('affinity', 'Reef TV'), 'Because you watched Reef TV')
assert.equal(feedReasonLabel('trending'), 'Trending')

// The empty label is the contract that lets a caller branch on the label rather than
// on the reason, so that 'new' renders nothing without a second condition.
assert.equal(feedReasonLabel('new'), '', 'a merely-recent video has nothing to explain')
assert.equal(feedReasonLabel('new', 'Reef TV'), '', 'and a channel name does not change that')

// A creatorless video has no channel to name; the sentence must still read.
assert.equal(feedReasonLabel('subscription', null), 'New upload')
assert.equal(feedReasonLabel('affinity', undefined), 'Based on your viewing')
assert.ok(
  !feedReasonLabel('subscription', null).includes('undefined'),
  'never interpolate a missing channel name into a sentence',
)

console.log('feed ranking: all checks passed')
