// Relative, `.ts`-suffixed import for the same reason as `dashboard-totals.ts`:
// `scripts/test-feed-ranking.ts` loads this under plain `node
// --experimental-strip-types`, which resolves neither tsconfig paths nor
// extensionless specifiers. Nothing that reaches Mongoose may be added here.
import type { FeedReason } from '../../lib/feed-reason.ts'

/**
 * The order of the personalized home feed.
 *
 * Kept apart from the queries that feed it so `npm run test:feed-ranking` can check
 * the whole rule without a database — which matters more here than elsewhere,
 * because "the feed looks wrong" is otherwise only arguable by squinting at a page.
 * Every input is a plain value and `nowMs` is injected, so a test states an age in
 * hours rather than waiting for one.
 *
 * There are no categories or tags on a video in this app, so "recommended" cannot
 * mean topic matching. It means: recent, watched by others, from a channel you pay
 * for, or from a channel you keep coming back to. Those are the four signals below.
 */

export type FeedCandidate = {
  id: string
  /**
   * Null for videos uploaded before channels existed — `video.uploadedBy` is
   * optional. Such a row can be neither subscribed to nor accumulate affinity, and
   * still scores on recency and popularity.
   */
  creatorId: string | null
  createdAtMs: number
  viewCount: number
  likeCount: number
  /** True when this row reached the candidate set via the subscribed-creator query. */
  fromSubscription: boolean
}

export type ViewerSignals = {
  watchedVideoIds: readonly string[]
  /** Recent watches per creator — the affinity signal. */
  creatorWatchCounts: Readonly<Record<string, number>>
  subscribedCreatorIds: readonly string[]
}

/** What an anonymous viewer knows about themselves. Scores reduce to recency + trending. */
export const NO_SIGNALS: ViewerSignals = {
  watchedVideoIds: [],
  creatorWatchCounts: {},
  subscribedCreatorIds: [],
}

export type FeedWeights = {
  recency: number
  trending: number
  subscription: number
  affinity: number
  /** Subtracted from an already-watched video. A demotion, not a filter — see below. */
  seen: number
  /** Age at which the recency term halves. */
  halfLifeHours: number
  /** Engagement score that saturates the popularity term. */
  popularityCeiling: number
  /** Watches of one creator that saturate affinity. */
  affinitySaturation: number
  /** Rows from one creator before the rest are demoted to the tail. */
  maxPerCreator: number
}

/**
 * Tuning lives here, in one object, so changing the feed's behaviour never means
 * editing the logic and never invalidates the tests' structure.
 *
 * These are reasoned guesses, not measurements — this app has no analytics and no
 * way to A/B a weight. `subscription` outranks `recency` because a paying viewer
 * asking "what's new from the people I pay" is the clearest intent the feed can
 * read; `affinity` sits below both because a watch is weaker evidence than a
 * payment.
 */
export const DEFAULT_FEED_WEIGHTS: FeedWeights = {
  recency: 1.0,
  trending: 0.8,
  subscription: 1.2,
  affinity: 0.6,
  seen: 0.7,
  halfLifeHours: 72,
  popularityCeiling: 10_000,
  affinitySaturation: 5,
  maxPerCreator: 3,
}

export type RankedCandidate = {
  id: string
  score: number
  reason: FeedReason
}

/**
 * Merge the two candidate pools into one deduplicated list.
 *
 * The feed asks two questions — "what have the channels I pay for posted" and "what
 * is good lately" — and the same video is very often both. That overlap is the common
 * case rather than an edge one, so which pool wins the duplicate decides whether a
 * subscribed creator's new upload keeps its boost or silently loses it. The
 * subscription answer wins, because it is the one carrying information: a video being
 * recent is already represented by its own term in the score.
 *
 * Pure and separate from the queries so this rule is checked without a database — it
 * is one `if` whose reversal produces a feed that looks plausible and ranks wrongly.
 */
export function mergeCandidatePools<T>(
  subscribed: readonly T[],
  recent: readonly T[],
  idOf: (row: T) => string,
): Array<{ id: string; row: T; fromSubscription: boolean }> {
  const merged = new Map<string, { id: string; row: T; fromSubscription: boolean }>()

  for (const row of subscribed) {
    const id = idOf(row)
    if (!merged.has(id)) merged.set(id, { id, row, fromSubscription: true })
  }
  for (const row of recent) {
    const id = idOf(row)
    if (!merged.has(id)) merged.set(id, { id, row, fromSubscription: false })
  }

  return [...merged.values()]
}

/**
 * How recent this is, on a 0..1 scale.
 *
 * Hyperbolic rather than exponential, deliberately: with a 72-hour half-life an
 * exponential decay puts a two-week-old video at 0.02, which against a catalogue
 * this small is indistinguishable from deleting it. Hyperbolic leaves it at 0.18 —
 * still clearly beaten by anything fresh, still able to win on another signal.
 *
 * A video with a future timestamp (clock skew, a seeded fixture) clamps to 1 rather
 * than scoring above it.
 */
function recencyScore(ageHours: number, halfLifeHours: number): number {
  if (ageHours <= 0) return 1
  return 1 / (1 + ageHours / halfLifeHours)
}

/**
 * How much engagement this has, on a 0..1 scale.
 *
 * A like is worth three views because it costs a deliberate click, where a view is
 * counted for merely opening the page (see the note on `viewCount` in the video
 * schema — it counts loads, not people, so a reload inflates it). Logarithmic so one
 * viral row cannot flatten every other score to noise.
 */
function popularityScore(viewCount: number, likeCount: number, ceiling: number): number {
  const engagement = Math.max(0, viewCount) + 3 * Math.max(0, likeCount)
  if (engagement <= 0) return 0
  return Math.min(1, Math.log10(1 + engagement) / Math.log10(1 + ceiling))
}

/**
 * The ranked feed, best first.
 *
 * score = w.recency*recency + w.trending*trending + w.subscription*subscription
 *         + w.affinity*affinity - seenPenalty
 *
 * Each term is normalized to 0..1 so one can be reasoned about — and tested —
 * without unpicking the others.
 *
 * **Trending is popularity times recency, and that product is the age decay.** An
 * old hit and an old dud decay at the same rate, so what falls over time is an old
 * video's *ceiling*: nothing can rank on all-time popularity forever, which is the
 * failure mode a naive sort on `viewCount` has and the reason this feed does not run
 * one. Keeping the decay multiplicative rather than folding age into a single
 * Hacker-News-style expression is what lets recency and popularity stay separately
 * testable.
 *
 * **A watched video is demoted, not removed.** Filtering seen rows outright empties
 * the home page of the app's most engaged viewer, and against a catalogue this size
 * that is the likely case rather than the edge case. The penalty is large enough
 * that anything unwatched and comparable outranks it.
 *
 * Cold start needs no branch: a viewer with no subscriptions and no history zeroes
 * those two terms and is left with recency + trending, which is "newest and
 * trending" — the feed the story asks for before it has anything personal to say.
 */
export function rankFeed(
  candidates: readonly FeedCandidate[],
  signals: ViewerSignals,
  nowMs: number,
  weights: FeedWeights = DEFAULT_FEED_WEIGHTS,
): RankedCandidate[] {
  const subscribed = new Set(signals.subscribedCreatorIds)
  const watched = new Set(signals.watchedVideoIds)

  const scored = candidates.map((candidate) => {
    const ageHours = (nowMs - candidate.createdAtMs) / 3_600_000
    const recency = recencyScore(ageHours, weights.halfLifeHours)
    const popularity = popularityScore(
      candidate.viewCount,
      candidate.likeCount,
      weights.popularityCeiling,
    )
    const trending = popularity * recency

    // The membership re-check is not redundant with `fromSubscription`: it makes the
    // term correct even if a caller mislabels a candidate, and a boost handed to a
    // channel the viewer does not pay for is the one error here a viewer would read
    // as the feed lying to them.
    const isSubscription =
      candidate.fromSubscription && !!candidate.creatorId && subscribed.has(candidate.creatorId)

    const watchCount = candidate.creatorId
      ? (signals.creatorWatchCounts[candidate.creatorId] ?? 0)
      : 0
    const affinity = Math.min(1, Math.max(0, watchCount) / weights.affinitySaturation)

    const score =
      weights.recency * recency +
      weights.trending * trending +
      weights.subscription * (isSubscription ? 1 : 0) +
      weights.affinity * affinity -
      (watched.has(candidate.id) ? weights.seen : 0)

    // First match wins, most specific explanation first. The trending floor keeps the
    // label honest: a video with almost no engagement is "new", not "trending".
    const reason: FeedReason = isSubscription
      ? 'subscription'
      : affinity > 0
        ? 'affinity'
        : trending >= 0.15
          ? 'trending'
          : 'new'

    return { candidate, score, reason }
  })

  // Ties break on recency then id. Never rely on `Array.prototype.sort` being stable
  // here: the candidate array is assembled by deduping across two queries, so its
  // input order is not stable between runs and a stable sort would only make the
  // nondeterminism harder to see.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.candidate.createdAtMs - a.candidate.createdAtMs ||
      (a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0),
  )

  // One prolific creator — most likely the one the viewer just subscribed to — would
  // otherwise own every slot above the fold, which is the most probable way this
  // feature looks broken on first run. Demoted to the tail rather than dropped: with
  // few creators seeded, dropping them empties the page instead.
  const kept: typeof scored = []
  const overflow: typeof scored = []
  const perCreator = new Map<string, number>()
  for (const row of scored) {
    const creatorId = row.candidate.creatorId
    if (!creatorId) {
      kept.push(row)
      continue
    }
    const seenFromCreator = perCreator.get(creatorId) ?? 0
    perCreator.set(creatorId, seenFromCreator + 1)
    if (seenFromCreator < weights.maxPerCreator) kept.push(row)
    else overflow.push(row)
  }

  return [...kept, ...overflow].map((row) => ({
    id: row.candidate.id,
    score: row.score,
    reason: row.reason,
  }))
}
