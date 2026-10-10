import { videoLikes as mongoVideoLikes } from './mongo/video-like.ts'
import { videoViews as mongoVideoViews } from './mongo/video-view.ts'
import { channelSubscriptions as mongoChannelSubscriptions } from './mongo/channel-subscription.ts'
import { ads as mongoAds } from './mongo/ad.ts'
import { videoComments as mongoVideoComments } from './mongo/video-comment.ts'
import { membershipTiers as mongoMembershipTiers } from './mongo/membership-tier.ts'
import { users as mongoUsers } from './mongo/user.ts'
import {
  adImpressions as mongoAdImpressions,
  subscriptionInvoices as mongoSubscriptionInvoices,
  tips as mongoTips,
  videoPurchases as mongoVideoPurchases,
} from './mongo/ledger.ts'
import { videos as mongoVideos } from './mongo/video.ts'
import { videoLikes as dynamoVideoLikes } from './dynamo/video-like.ts'
import { videoViews as dynamoVideoViews } from './dynamo/video-view.ts'
import { channelSubscriptions as dynamoChannelSubscriptions } from './dynamo/channel-subscription.ts'
import { ads as dynamoAds } from './dynamo/ad.ts'
import { videoComments as dynamoVideoComments } from './dynamo/video-comment.ts'
import { membershipTiers as dynamoMembershipTiers } from './dynamo/membership-tier.ts'
import { users as dynamoUsers } from './dynamo/user.ts'
import {
  adImpressions as dynamoAdImpressions,
  subscriptionInvoices as dynamoSubscriptionInvoices,
  tips as dynamoTips,
  videoPurchases as dynamoVideoPurchases,
} from './dynamo/ledger.ts'
import { videos as dynamoVideos } from './dynamo/video.ts'
import type {
  AdImpressionRepo,
  AdRepo,
  ChannelSubscriptionRepo,
  MembershipTierRepo,
  VideoCommentRepo,
  SubscriptionInvoiceRepo,
  TipRepo,
  UserRepo,
  VideoLikeRepo,
  VideoPurchaseRepo,
  VideoRepo,
  VideoViewRepo,
} from './types.ts'

export { DuplicateEmail, DuplicateTierName } from './types.ts'
export type {
  AdImpressionRepo,
  AdRepo,
  AdRow,
  LedgerEntry,
  ChannelSubscriptionRepo,
  CommentRow,
  Id,
  MembershipTierRepo,
  SubscriptionInvoiceRepo,
  SubscriptionPatch,
  SubscriptionRow,
  TipRepo,
  TierCreateFields,
  TierRow,
  TierUpdateFields,
  UserCreateFields,
  UserProfilePatch,
  UserRepo,
  UserRow,
  VideoCommentRepo,
  VideoCreateFields,
  VideoGatePatch,
  VideoLikeRepo,
  VideoPurchaseRepo,
  VideoRepo,
  VideoRow,
  VideoViewRepo,
  WatchSignal,
} from './types.ts'

const useDynamo = process.env.DATA_BACKEND === 'dynamo'

export const videoLikes: VideoLikeRepo = useDynamo ? dynamoVideoLikes : mongoVideoLikes
export const videoViews: VideoViewRepo = useDynamo ? dynamoVideoViews : mongoVideoViews
export const channelSubscriptions: ChannelSubscriptionRepo = useDynamo
  ? dynamoChannelSubscriptions
  : mongoChannelSubscriptions
export const ads: AdRepo = useDynamo ? dynamoAds : mongoAds
export const videoComments: VideoCommentRepo = useDynamo
  ? dynamoVideoComments
  : mongoVideoComments
export const membershipTiers: MembershipTierRepo = useDynamo
  ? dynamoMembershipTiers
  : mongoMembershipTiers
export const users: UserRepo = useDynamo ? dynamoUsers : mongoUsers
export const tips: TipRepo = useDynamo ? dynamoTips : mongoTips
export const videoPurchases: VideoPurchaseRepo = useDynamo
  ? dynamoVideoPurchases
  : mongoVideoPurchases
export const subscriptionInvoices: SubscriptionInvoiceRepo = useDynamo
  ? dynamoSubscriptionInvoices
  : mongoSubscriptionInvoices
export const adImpressions: AdImpressionRepo = useDynamo
  ? dynamoAdImpressions
  : mongoAdImpressions
export const videos: VideoRepo = useDynamo ? dynamoVideos : mongoVideos
