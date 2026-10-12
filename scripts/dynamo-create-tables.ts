import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb'
import { TABLES } from '../src/server/data/dynamo/client.ts'
import { LAST_WATCHED_INDEX } from '../src/server/data/dynamo/video-view.ts'
import { CREATOR_INDEX } from '../src/server/data/dynamo/channel-subscription.ts'
import { ACTIVE_INDEX } from '../src/server/data/dynamo/ad.ts'
import { VIDEO_INDEX } from '../src/server/data/dynamo/video-comment.ts'
import { CREATOR_INDEX as TIER_CREATOR_INDEX } from '../src/server/data/dynamo/membership-tier.ts'
import { BUYER_INDEX, CREATOR_INDEX as LEDGER_CREATOR_INDEX } from '../src/server/data/dynamo/ledger.ts'
import {
  CREATOR_INDEX as VIDEO_CREATOR_INDEX,
  RECENCY_INDEX,
  TIER_INDEX,
  TRANSCODE_INDEX,
} from '../src/server/data/dynamo/video.ts'

const endpoint = process.env.DYNAMODB_ENDPOINT
const region = process.env.AWS_REGION || process.env.DYNAMODB_REGION || 'us-east-1'
const accessKeyId = process.env.DYNAMODB_ACCESS_KEY_ID
const secretAccessKey = process.env.DYNAMODB_SECRET_ACCESS_KEY

const client = new DynamoDBClient({
  region,
  ...(endpoint ? { endpoint } : {}),
  ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
})

const definitions = [
  {
    TableName: TABLES.videoLikes,
    BillingMode: 'PAY_PER_REQUEST' as const,
    AttributeDefinitions: [
      { AttributeName: 'videoId', AttributeType: 'S' as const },
      { AttributeName: 'userId', AttributeType: 'S' as const },
    ],
    KeySchema: [
      { AttributeName: 'videoId', KeyType: 'HASH' as const },
      { AttributeName: 'userId', KeyType: 'RANGE' as const },
    ],
  },
  {
    TableName: TABLES.videoViews,
    BillingMode: 'PAY_PER_REQUEST' as const,
    AttributeDefinitions: [
      { AttributeName: 'viewerId', AttributeType: 'S' as const },
      { AttributeName: 'videoId', AttributeType: 'S' as const },
      { AttributeName: 'lastWatchedAt', AttributeType: 'N' as const },
    ],
    KeySchema: [
      { AttributeName: 'viewerId', KeyType: 'HASH' as const },
      { AttributeName: 'videoId', KeyType: 'RANGE' as const },
    ],
    LocalSecondaryIndexes: [
      {
        IndexName: LAST_WATCHED_INDEX,
        KeySchema: [
          { AttributeName: 'viewerId', KeyType: 'HASH' as const },
          { AttributeName: 'lastWatchedAt', KeyType: 'RANGE' as const },
        ],
        Projection: { ProjectionType: 'ALL' as const },
      },
    ],
  },
  {
    TableName: TABLES.channelSubscriptions,
    BillingMode: 'PAY_PER_REQUEST' as const,
    AttributeDefinitions: [
      { AttributeName: 'subscriberId', AttributeType: 'S' as const },
      { AttributeName: 'creatorId', AttributeType: 'S' as const },
    ],
    KeySchema: [
      { AttributeName: 'subscriberId', KeyType: 'HASH' as const },
      { AttributeName: 'creatorId', KeyType: 'RANGE' as const },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: CREATOR_INDEX,
        KeySchema: [
          { AttributeName: 'creatorId', KeyType: 'HASH' as const },
          { AttributeName: 'subscriberId', KeyType: 'RANGE' as const },
        ],
        Projection: { ProjectionType: 'ALL' as const },
      },
    ],
  },
  {
    TableName: TABLES.ads,
    BillingMode: 'PAY_PER_REQUEST' as const,
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'S' as const },
      { AttributeName: 'active', AttributeType: 'S' as const },
    ],
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' as const }],
    GlobalSecondaryIndexes: [
      {
        IndexName: ACTIVE_INDEX,
        KeySchema: [
          { AttributeName: 'active', KeyType: 'HASH' as const },
          { AttributeName: 'id', KeyType: 'RANGE' as const },
        ],
        Projection: { ProjectionType: 'ALL' as const },
      },
    ],
  },
  {
    TableName: TABLES.videoComments,
    BillingMode: 'PAY_PER_REQUEST' as const,
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'S' as const },
      { AttributeName: 'videoId', AttributeType: 'S' as const },
    ],
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' as const }],
    GlobalSecondaryIndexes: [
      {
        IndexName: VIDEO_INDEX,
        KeySchema: [
          { AttributeName: 'videoId', KeyType: 'HASH' as const },
          { AttributeName: 'id', KeyType: 'RANGE' as const },
        ],
        Projection: { ProjectionType: 'ALL' as const },
      },
    ],
  },
  {
    TableName: TABLES.membershipTiers,
    BillingMode: 'PAY_PER_REQUEST' as const,
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'S' as const },
      { AttributeName: 'creatorId', AttributeType: 'S' as const },
    ],
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' as const }],
    GlobalSecondaryIndexes: [
      {
        IndexName: TIER_CREATOR_INDEX,
        KeySchema: [
          { AttributeName: 'creatorId', KeyType: 'HASH' as const },
          { AttributeName: 'id', KeyType: 'RANGE' as const },
        ],
        Projection: { ProjectionType: 'ALL' as const },
      },
    ],
  },
  {
    TableName: TABLES.users,
    BillingMode: 'PAY_PER_REQUEST' as const,
    AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' as const }],
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' as const }],
  },
  {
    TableName: TABLES.tips,
    BillingMode: 'PAY_PER_REQUEST' as const,
    AttributeDefinitions: [
      { AttributeName: 'stripeSessionId', AttributeType: 'S' as const },
      { AttributeName: 'creatorId', AttributeType: 'S' as const },
    ],
    KeySchema: [{ AttributeName: 'stripeSessionId', KeyType: 'HASH' as const }],
    GlobalSecondaryIndexes: [
      {
        IndexName: LEDGER_CREATOR_INDEX,
        KeySchema: [
          { AttributeName: 'creatorId', KeyType: 'HASH' as const },
          { AttributeName: 'stripeSessionId', KeyType: 'RANGE' as const },
        ],
        Projection: { ProjectionType: 'ALL' as const },
      },
    ],
  },
  {
    TableName: TABLES.videoPurchases,
    BillingMode: 'PAY_PER_REQUEST' as const,
    AttributeDefinitions: [
      { AttributeName: 'stripeSessionId', AttributeType: 'S' as const },
      { AttributeName: 'creatorId', AttributeType: 'S' as const },
      { AttributeName: 'buyerId', AttributeType: 'S' as const },
      { AttributeName: 'videoId', AttributeType: 'S' as const },
    ],
    KeySchema: [{ AttributeName: 'stripeSessionId', KeyType: 'HASH' as const }],
    GlobalSecondaryIndexes: [
      {
        IndexName: LEDGER_CREATOR_INDEX,
        KeySchema: [
          { AttributeName: 'creatorId', KeyType: 'HASH' as const },
          { AttributeName: 'stripeSessionId', KeyType: 'RANGE' as const },
        ],
        Projection: { ProjectionType: 'ALL' as const },
      },
      {
        IndexName: BUYER_INDEX,
        KeySchema: [
          { AttributeName: 'buyerId', KeyType: 'HASH' as const },
          { AttributeName: 'videoId', KeyType: 'RANGE' as const },
        ],
        Projection: { ProjectionType: 'ALL' as const },
      },
    ],
  },
  {
    TableName: TABLES.subscriptionInvoices,
    BillingMode: 'PAY_PER_REQUEST' as const,
    AttributeDefinitions: [
      { AttributeName: 'stripeInvoiceId', AttributeType: 'S' as const },
      { AttributeName: 'creatorId', AttributeType: 'S' as const },
    ],
    KeySchema: [{ AttributeName: 'stripeInvoiceId', KeyType: 'HASH' as const }],
    GlobalSecondaryIndexes: [
      {
        IndexName: LEDGER_CREATOR_INDEX,
        KeySchema: [
          { AttributeName: 'creatorId', KeyType: 'HASH' as const },
          { AttributeName: 'stripeInvoiceId', KeyType: 'RANGE' as const },
        ],
        Projection: { ProjectionType: 'ALL' as const },
      },
    ],
  },
  {
    TableName: TABLES.adImpressions,
    BillingMode: 'PAY_PER_REQUEST' as const,
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'S' as const },
      { AttributeName: 'creatorId', AttributeType: 'S' as const },
    ],
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' as const }],
    GlobalSecondaryIndexes: [
      {
        IndexName: LEDGER_CREATOR_INDEX,
        KeySchema: [
          { AttributeName: 'creatorId', KeyType: 'HASH' as const },
          { AttributeName: 'id', KeyType: 'RANGE' as const },
        ],
        Projection: { ProjectionType: 'ALL' as const },
      },
    ],
  },
  {
    TableName: TABLES.videos,
    BillingMode: 'PAY_PER_REQUEST' as const,
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'S' as const },
      { AttributeName: 'uploadedBy', AttributeType: 'S' as const },
      { AttributeName: 'feedBucket', AttributeType: 'S' as const },
      { AttributeName: 'createdAt', AttributeType: 'N' as const },
      { AttributeName: 'requiredTierId', AttributeType: 'S' as const },
      { AttributeName: 'transcodeStatus', AttributeType: 'S' as const },
      { AttributeName: 'transcodeNextAttemptAt', AttributeType: 'N' as const },
    ],
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' as const }],
    GlobalSecondaryIndexes: [
      {
        IndexName: VIDEO_CREATOR_INDEX,
        KeySchema: [
          { AttributeName: 'uploadedBy', KeyType: 'HASH' as const },
          { AttributeName: 'createdAt', KeyType: 'RANGE' as const },
        ],
        Projection: { ProjectionType: 'ALL' as const },
      },
      {
        IndexName: RECENCY_INDEX,
        KeySchema: [
          { AttributeName: 'feedBucket', KeyType: 'HASH' as const },
          { AttributeName: 'createdAt', KeyType: 'RANGE' as const },
        ],
        Projection: { ProjectionType: 'ALL' as const },
      },
      {
        IndexName: TIER_INDEX,
        KeySchema: [
          { AttributeName: 'requiredTierId', KeyType: 'HASH' as const },
          { AttributeName: 'id', KeyType: 'RANGE' as const },
        ],
        Projection: { ProjectionType: 'KEYS_ONLY' as const },
      },
      {
        IndexName: TRANSCODE_INDEX,
        KeySchema: [
          { AttributeName: 'transcodeStatus', KeyType: 'HASH' as const },
          { AttributeName: 'transcodeNextAttemptAt', KeyType: 'RANGE' as const },
        ],
        Projection: { ProjectionType: 'ALL' as const },
      },
    ],
  },
]

async function exists(name: string): Promise<boolean> {
  try {
    await client.send(new DescribeTableCommand({ TableName: name }))
    return true
  } catch (err) {
    if ((err as { name?: string }).name === 'ResourceNotFoundException') return false
    throw err
  }
}

async function main() {
  console.log(`DynamoDB ${endpoint ? `at ${endpoint}` : `in ${region}`}`)

  for (const definition of definitions) {
    const name = definition.TableName
    if (await exists(name)) {
      console.log(`  exists   ${name}`)
      continue
    }
    await client.send(new CreateTableCommand(definition))
    await waitUntilTableExists({ client, maxWaitTime: 120 }, { TableName: name })
    console.log(`  created  ${name}`)
  }

  console.log('\nTTL on video-views.expiresAt must be enabled separately:')
  console.log(
    `  aws dynamodb update-time-to-live --table-name ${TABLES.videoViews}` +
      ` --time-to-live-specification "Enabled=true,AttributeName=expiresAt"`,
  )
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
