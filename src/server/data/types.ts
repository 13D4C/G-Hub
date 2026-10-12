export type Id = string

export type VideoLikeRepo = {
  exists(videoId: Id, userId: Id): Promise<boolean>
  remove(videoId: Id, userId: Id): Promise<boolean>
  insert(videoId: Id, userId: Id): Promise<boolean>
  removeByVideo(videoId: Id): Promise<void>
  countByVideo(): Promise<Map<Id, number>>
}

export type WatchSignal = {
  videoId: Id
  creatorId: Id | null
  watchCount: number
}

export type VideoViewRepo = {
  recordWatch(viewerId: Id, videoId: Id, creatorId: Id | null): Promise<void>
  recentByViewer(viewerId: Id, limit: number): Promise<WatchSignal[]>
}

export type SubscriptionRow = {
  subscriberId: Id
  creatorId: Id
  status: string
  currentPeriodEnd: Date | null
  tierId: Id | null
  tierName: string
  priceCents: number
  currency: string
  cancelAtPeriodEnd: boolean
  stripeCustomerId: string
  stripeSubscriptionId: string
}

export type SubscriptionPatch = Partial<Omit<SubscriptionRow, 'subscriberId' | 'creatorId'>>

export const SUBSCRIPTION_DEFAULTS: Omit<SubscriptionRow, 'subscriberId' | 'creatorId'> = {
  status: 'incomplete',
  currentPeriodEnd: null,
  tierId: null,
  tierName: '',
  priceCents: 0,
  currency: 'usd',
  cancelAtPeriodEnd: false,
  stripeCustomerId: '',
  stripeSubscriptionId: '',
}

export type ChannelSubscriptionRepo = {
  find(subscriberId: Id, creatorId: Id): Promise<SubscriptionRow | null>
  listBySubscriber(subscriberId: Id, statuses: readonly string[]): Promise<SubscriptionRow[]>
  listByCreator(creatorId: Id): Promise<SubscriptionRow[]>
  upsert(subscriberId: Id, creatorId: Id, patch: SubscriptionPatch): Promise<void>
}

export class DuplicateTierName extends Error {
  constructor() {
    super('duplicate tier name')
    this.name = 'DuplicateTierName'
  }
}

export type AdRow = {
  id: Id
  title: string
  mediaUrl: string
  durationSeconds: number
  clickThroughUrl: string
  skippableAfterSeconds: number
  weight: number
}

export type AdSeedFields = {
  mediaUrl: string
  skippableAfterSeconds: number
  weight: number
  active: boolean
}

export type AdRepo = {
  listActive(): Promise<AdRow[]>
  upsertByTitle(title: string, fields: AdSeedFields): Promise<void>
}

export type CommentRow = {
  id: Id
  videoId: Id
  userId: Id
  body: string
  createdAt: Date
  editedAt: Date | null
}

export type VideoCommentRepo = {
  countByVideo(videoId: Id): Promise<number>
  listByVideo(videoId: Id, limit: number, cursor: Id | null): Promise<CommentRow[]>
  create(videoId: Id, userId: Id, body: string): Promise<CommentRow>
  updateOwn(commentId: Id, userId: Id, body: string, editedAt: Date): Promise<CommentRow | null>
  deleteOwn(commentId: Id, userId: Id): Promise<CommentRow | null>
  deleteByVideo(videoId: Id): Promise<void>
}

export type TierRow = {
  id: Id
  creatorId: Id
  name: string
  description: string
  priceCents: number
  currency: string
  rank: number
  active: boolean
}

export type TierCreateFields = {
  name: string
  description: string
  priceCents: number
  currency: string
  rank: number
}

export type TierUpdateFields = Partial<Pick<TierRow, 'name' | 'description' | 'priceCents' | 'rank'>>

export type MembershipTierRepo = {
  findById(tierId: Id): Promise<TierRow | null>
  findActiveOwned(tierId: Id, creatorId: Id): Promise<TierRow | null>
  listActiveByCreator(creatorId: Id): Promise<TierRow[]>
  listByIds(ids: readonly Id[]): Promise<TierRow[]>
  countActiveByCreator(creatorId: Id): Promise<number>
  create(creatorId: Id, fields: TierCreateFields): Promise<TierRow>
  updateOwn(tierId: Id, creatorId: Id, fields: TierUpdateFields): Promise<TierRow | null>
  archive(tierId: Id, creatorId: Id): Promise<boolean>
}

export class DuplicateEmail extends Error {
  constructor() {
    super('duplicate email')
    this.name = 'DuplicateEmail'
  }
}

export type UserRow = {
  id: Id
  email: string
  passwordHash: string | null
  googleId: string | null
  name: string
  avatarUrl: string
  channelName: string
  channelDescription: string
  channelCurrency: string
  stripeCustomerId: string
}

export type UserCreateFields = {
  email: string
  passwordHash?: string | null
  googleId?: string | null
  name?: string
  avatarUrl?: string
}

export type UserProfilePatch = Partial<
  Pick<UserRow, 'name' | 'channelName' | 'channelDescription' | 'channelCurrency' | 'avatarUrl'>
>

export type GoogleLinkFields = {
  googleId: string
  name?: string
  avatarUrl?: string
}

export type UserRepo = {
  findById(id: Id): Promise<UserRow | null>
  findByEmail(email: string): Promise<UserRow | null>
  findByGoogleId(googleId: string): Promise<UserRow | null>
  listByIds(ids: readonly Id[]): Promise<UserRow[]>
  create(fields: UserCreateFields): Promise<UserRow>
  updateProfile(id: Id, patch: UserProfilePatch): Promise<void>
  linkGoogle(id: Id, fields: GoogleLinkFields): Promise<void>
  setAvatar(id: Id, avatarUrl: string): Promise<void>
  claimStripeCustomerId(id: Id, customerId: string): Promise<string>
}

export type LedgerEntry = {
  creatorId: Id
  videoId: Id | null
  amountCents: number
  currency: string
  at: Date
}

export type TipRecordFields = {
  supporterId: Id
  creatorId: Id
  videoId: Id | null
  amountCents: number
  currency: string
}

export type TipRepo = {
  listByCreator(creatorId: Id): Promise<LedgerEntry[]>
  recordBySession(stripeSessionId: string, fields: TipRecordFields): Promise<void>
}

export type PurchaseRecordFields = {
  buyerId: Id
  creatorId: Id
  videoId: Id
  amountCents: number
  currency: string
}

export type VideoPurchaseRepo = {
  listByCreator(creatorId: Id): Promise<LedgerEntry[]>
  recordBySession(stripeSessionId: string, fields: PurchaseRecordFields): Promise<void>
  existsForBuyer(buyerId: Id, videoId: Id): Promise<boolean>
  purchasedVideoIds(buyerId: Id, videoIds: readonly Id[]): Promise<Set<Id>>
}

export type InvoiceRecordFields = {
  subscriberId: Id
  creatorId: Id
  stripeSubscriptionId: string
  tierId: Id | null
  tierName: string
  amountPaidCents: number
  currency: string
  billingReason: string
  paidAt: Date
  periodStart: Date | null
  periodEnd: Date | null
}

export type SubscriptionInvoiceRepo = {
  listByCreator(creatorId: Id): Promise<LedgerEntry[]>
  recordByInvoiceId(stripeInvoiceId: string, fields: InvoiceRecordFields): Promise<void>
}

export type ImpressionRecordFields = {
  adId: Id
  videoId: Id
  creatorId: Id
  viewerId: Id | null
  shownAt: Date
  dedupeKey: string | null
}

export type AdImpressionRepo = {
  listByCreator(creatorId: Id): Promise<Array<{ at: Date }>>
  record(fields: ImpressionRecordFields): Promise<void>
}

export type Rendition = { width: number; height: number; bitrateKbps: number }

export type TranscodeState = {
  status: string
  nextAttemptAt: Date
  attempts: number
  workerId: string
  prefix: string
  hlsUrl: string
  dashUrl: string
  renditions: Rendition[]
  sourceWidth: number
  sourceHeight: number
  error: string
  startedAt: Date | null
  finishedAt: Date | null
}

export type VideoRow = {
  id: Id
  title: string
  description: string
  url: string
  uploadedBy: Id | null
  durationSeconds: number
  visibility: string
  requiredTierId: Id | null
  priceCents: number | null
  adsEnabled: boolean
  likeCount: number
  viewCount: number
  shareCount: number
  createdAt: Date
  transcode: TranscodeState
}

export type VideoCreateFields = {
  id: Id
  title: string
  description: string
  url: string
  uploadedBy: Id
  durationSeconds: number
  visibility: string
  requiredTierId: Id | null
  priceCents: number | null
  adsEnabled: boolean
}

export type VideoGatePatch = {
  visibility: string
  requiredTierId: Id | null
  priceCents: number | null
  adsEnabled: boolean
}

export type ClaimedVideo = {
  id: Id
  url: string
  prefix: string
  attempts: number
}

export type TranscodeResultFields = {
  hlsUrl: string
  dashUrl: string
  renditions: Rendition[]
  sourceWidth: number
  sourceHeight: number
  durationSeconds: number
}

export type VideoRepo = {
  findById(videoId: Id): Promise<VideoRow | null>
  listVisible(viewerId: Id | null, limit: number): Promise<VideoRow[]>
  listVisibleByCreators(
    viewerId: Id | null,
    creatorIds: readonly Id[],
    limit: number,
  ): Promise<VideoRow[]>
  listVisibleSince(viewerId: Id | null, since: Date, limit: number): Promise<VideoRow[]>
  listByCreator(creatorId: Id, limit: number): Promise<VideoRow[]>
  countByTier(tierIds: readonly Id[]): Promise<Map<Id, number>>
  create(fields: VideoCreateFields): Promise<VideoRow>
  updateDetails(
    videoId: Id,
    creatorId: Id,
    fields: { title: string; description: string },
  ): Promise<VideoRow | null>
  updateGate(videoId: Id, creatorId: Id, patch: VideoGatePatch): Promise<VideoRow | null>
  deleteOwned(videoId: Id, creatorId: Id): Promise<VideoRow | null>
  incrementView(videoId: Id): Promise<void>
  incrementLike(videoId: Id, delta: number): Promise<number>
  incrementShare(videoId: Id): Promise<number>
  claimNext(workerId: string, leaseMs: number, maxAttempts: number): Promise<ClaimedVideo | null>
  renewClaim(videoId: Id, workerId: string, leaseMs: number): Promise<boolean>
  completeTranscode(
    videoId: Id,
    workerId: string,
    result: TranscodeResultFields,
  ): Promise<boolean>
  failTranscode(
    videoId: Id,
    workerId: string,
    giveUp: boolean,
    nextAttemptAt: Date,
    message: string,
  ): Promise<boolean>
  skipTranscode(videoId: Id, workerId: string, reason: string): Promise<boolean>
}
