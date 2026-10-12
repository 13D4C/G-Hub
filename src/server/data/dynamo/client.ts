import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'

const endpoint = process.env.DYNAMODB_ENDPOINT
const region = process.env.AWS_REGION || process.env.DYNAMODB_REGION || 'us-east-1'
const accessKeyId = process.env.DYNAMODB_ACCESS_KEY_ID
const secretAccessKey = process.env.DYNAMODB_SECRET_ACCESS_KEY

const prefix = process.env.DYNAMODB_TABLE_PREFIX || 'g-hub'

export const TABLES = {
  videoLikes: `${prefix}-video-likes`,
  videoViews: `${prefix}-video-views`,
  channelSubscriptions: `${prefix}-channel-subscriptions`,
  ads: `${prefix}-ads`,
  videoComments: `${prefix}-video-comments`,
  membershipTiers: `${prefix}-membership-tiers`,
  users: `${prefix}-users`,
  tips: `${prefix}-tips`,
  videoPurchases: `${prefix}-video-purchases`,
  subscriptionInvoices: `${prefix}-subscription-invoices`,
  adImpressions: `${prefix}-ad-impressions`,
  videos: `${prefix}-videos`,
} as const

let cached: DynamoDBDocumentClient | null = null

export function docClient(): DynamoDBDocumentClient {
  if (cached) return cached

  const base = new DynamoDBClient({
    region,
    ...(endpoint ? { endpoint } : {}),
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {}),
  })

  cached = DynamoDBDocumentClient.from(base, {
    marshallOptions: { removeUndefinedValues: true },
  })

  return cached
}

export function isConditionalCheckFailed(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'ConditionalCheckFailedException'
}
