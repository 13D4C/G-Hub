import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { docClient, TABLES } from './client.ts'
import {
  SUBSCRIPTION_DEFAULTS,
  type ChannelSubscriptionRepo,
  type Id,
  type SubscriptionPatch,
  type SubscriptionRow,
} from '../types.ts'

const TABLE = TABLES.channelSubscriptions
export const CREATOR_INDEX = 'by-creator'

type Item = Record<string, unknown>

function toRow(item: Item): SubscriptionRow {
  const end = item.currentPeriodEnd
  return {
    subscriberId: String(item.subscriberId),
    creatorId: String(item.creatorId),
    status: (item.status as string) ?? SUBSCRIPTION_DEFAULTS.status,
    currentPeriodEnd: typeof end === 'number' ? new Date(end) : null,
    tierId: item.tierId ? String(item.tierId) : null,
    tierName: (item.tierName as string) ?? '',
    priceCents: Number(item.priceCents) || 0,
    currency: (item.currency as string) ?? 'usd',
    cancelAtPeriodEnd: Boolean(item.cancelAtPeriodEnd),
    stripeCustomerId: (item.stripeCustomerId as string) ?? '',
    stripeSubscriptionId: (item.stripeSubscriptionId as string) ?? '',
  }
}

function encode(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value
}

export const channelSubscriptions: ChannelSubscriptionRepo = {
  async find(subscriberId: Id, creatorId: Id): Promise<SubscriptionRow | null> {
    const out = await docClient().send(
      new GetCommand({ TableName: TABLE, Key: { subscriberId, creatorId } }),
    )
    return out.Item ? toRow(out.Item) : null
  },

  async listBySubscriber(
    subscriberId: Id,
    statuses: readonly string[],
  ): Promise<SubscriptionRow[]> {
    const allowed = new Set(statuses)
    const client = docClient()
    const rows: SubscriptionRow[] = []
    let startKey: Record<string, unknown> | undefined

    do {
      const page = await client.send(
        new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression: 'subscriberId = :s',
          ExpressionAttributeValues: { ':s': subscriberId },
          ExclusiveStartKey: startKey,
        }),
      )

      for (const item of page.Items ?? []) {
        const row = toRow(item)
        if (allowed.has(row.status)) rows.push(row)
      }

      startKey = page.LastEvaluatedKey
    } while (startKey)

    return rows
  },

  async listByCreator(creatorId: Id): Promise<SubscriptionRow[]> {
    const client = docClient()
    const rows: SubscriptionRow[] = []
    let startKey: Record<string, unknown> | undefined

    do {
      const page = await client.send(
        new QueryCommand({
          TableName: TABLE,
          IndexName: CREATOR_INDEX,
          KeyConditionExpression: 'creatorId = :c',
          ExpressionAttributeValues: { ':c': creatorId },
          ExclusiveStartKey: startKey,
        }),
      )

      for (const item of page.Items ?? []) rows.push(toRow(item))
      startKey = page.LastEvaluatedKey
    } while (startKey)

    return rows
  },

  async upsert(subscriberId: Id, creatorId: Id, patch: SubscriptionPatch): Promise<void> {
    const sets: string[] = []
    const names: Record<string, string> = {}
    const values: Record<string, unknown> = {}

    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) continue
      names[`#${field}`] = field
      values[`:${field}`] = encode(value)
      sets.push(`#${field} = :${field}`)
    }

    for (const [field, fallback] of Object.entries(SUBSCRIPTION_DEFAULTS)) {
      if (field in patch && patch[field as keyof SubscriptionPatch] !== undefined) continue
      names[`#${field}`] = field
      values[`:default_${field}`] = encode(fallback)
      sets.push(`#${field} = if_not_exists(#${field}, :default_${field})`)
    }

    await docClient().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { subscriberId, creatorId },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    )
  },
}
