import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { docClient, isConditionalCheckFailed, TABLES } from './client.ts'
import { newObjectId } from '../object-id.ts'
import type {
  AdImpressionRepo,
  Id,
  ImpressionRecordFields,
  InvoiceRecordFields,
  LedgerEntry,
  PurchaseRecordFields,
  SubscriptionInvoiceRepo,
  TipRecordFields,
  TipRepo,
  VideoPurchaseRepo,
} from '../types.ts'

export const CREATOR_INDEX = 'by-creator'
export const BUYER_INDEX = 'by-buyer'

type Item = Record<string, unknown>

async function queryAll(
  table: string,
  index: string,
  keyExpression: string,
  values: Record<string, unknown>,
): Promise<Item[]> {
  const client = docClient()
  const items: Item[] = []
  let startKey: Record<string, unknown> | undefined

  do {
    const page = await client.send(
      new QueryCommand({
        TableName: table,
        IndexName: index,
        KeyConditionExpression: keyExpression,
        ExpressionAttributeValues: values,
        ExclusiveStartKey: startKey,
      }),
    )
    for (const item of page.Items ?? []) items.push(item)
    startKey = page.LastEvaluatedKey
  } while (startKey)

  return items
}

function toEntry(item: Item, creatorId: Id, amountField: string, dateField: string): LedgerEntry {
  return {
    creatorId,
    videoId: item.videoId ? String(item.videoId) : null,
    amountCents: Number(item[amountField]) || 0,
    currency: String(item.currency || 'usd'),
    at: new Date(Number(item[dateField])),
  }
}

export const tips: TipRepo = {
  async listByCreator(creatorId: Id): Promise<LedgerEntry[]> {
    const items = await queryAll(TABLES.tips, CREATOR_INDEX, 'creatorId = :c', { ':c': creatorId })
    return items.map((item) => toEntry(item, creatorId, 'amountCents', 'createdAt'))
  },

  async recordBySession(stripeSessionId: string, fields: TipRecordFields): Promise<void> {
    const existing = await docClient().send(
      new GetCommand({ TableName: TABLES.tips, Key: { stripeSessionId } }),
    )
    await docClient().send(
      new PutCommand({
        TableName: TABLES.tips,
        Item: {
          stripeSessionId,
          supporterId: fields.supporterId,
          creatorId: fields.creatorId,
          videoId: fields.videoId,
          amountCents: fields.amountCents,
          currency: fields.currency,
          createdAt: Number(existing.Item?.createdAt) || Date.now(),
        },
      }),
    )
  },
}

export const videoPurchases: VideoPurchaseRepo = {
  async listByCreator(creatorId: Id): Promise<LedgerEntry[]> {
    const items = await queryAll(TABLES.videoPurchases, CREATOR_INDEX, 'creatorId = :c', {
      ':c': creatorId,
    })
    return items.map((item) => toEntry(item, creatorId, 'amountCents', 'createdAt'))
  },

  async recordBySession(stripeSessionId: string, fields: PurchaseRecordFields): Promise<void> {
    const existing = await docClient().send(
      new GetCommand({ TableName: TABLES.videoPurchases, Key: { stripeSessionId } }),
    )
    await docClient().send(
      new PutCommand({
        TableName: TABLES.videoPurchases,
        Item: {
          stripeSessionId,
          buyerId: fields.buyerId,
          creatorId: fields.creatorId,
          videoId: fields.videoId,
          amountCents: fields.amountCents,
          currency: fields.currency,
          createdAt: Number(existing.Item?.createdAt) || Date.now(),
        },
      }),
    )
  },

  async existsForBuyer(buyerId: Id, videoId: Id): Promise<boolean> {
    const out = await docClient().send(
      new QueryCommand({
        TableName: TABLES.videoPurchases,
        IndexName: BUYER_INDEX,
        KeyConditionExpression: 'buyerId = :b AND videoId = :v',
        ExpressionAttributeValues: { ':b': buyerId, ':v': videoId },
        Limit: 1,
      }),
    )
    return (out.Items?.length ?? 0) > 0
  },

  async purchasedVideoIds(buyerId: Id, videoIds: readonly Id[]): Promise<Set<Id>> {
    if (videoIds.length === 0) return new Set()
    const wanted = new Set(videoIds)
    const items = await queryAll(TABLES.videoPurchases, BUYER_INDEX, 'buyerId = :b', {
      ':b': buyerId,
    })
    const owned = new Set<Id>()
    for (const item of items) {
      const videoId = String(item.videoId)
      if (wanted.has(videoId)) owned.add(videoId)
    }
    return owned
  },
}

export const subscriptionInvoices: SubscriptionInvoiceRepo = {
  async listByCreator(creatorId: Id): Promise<LedgerEntry[]> {
    const items = await queryAll(TABLES.subscriptionInvoices, CREATOR_INDEX, 'creatorId = :c', {
      ':c': creatorId,
    })
    return items.map((item) => ({
      creatorId,
      videoId: null,
      amountCents: Number(item.amountPaidCents) || 0,
      currency: String(item.currency || 'usd'),
      at: new Date(Number(item.paidAt)),
    }))
  },

  async recordByInvoiceId(stripeInvoiceId: string, fields: InvoiceRecordFields): Promise<void> {
    await docClient().send(
      new PutCommand({
        TableName: TABLES.subscriptionInvoices,
        Item: {
          stripeInvoiceId,
          subscriberId: fields.subscriberId,
          creatorId: fields.creatorId,
          stripeSubscriptionId: fields.stripeSubscriptionId,
          tierId: fields.tierId,
          tierName: fields.tierName,
          amountPaidCents: fields.amountPaidCents,
          currency: fields.currency,
          billingReason: fields.billingReason,
          paidAt: fields.paidAt.getTime(),
          periodStart: fields.periodStart ? fields.periodStart.getTime() : null,
          periodEnd: fields.periodEnd ? fields.periodEnd.getTime() : null,
        },
      }),
    )
  },
}

export const adImpressions: AdImpressionRepo = {
  async listByCreator(creatorId: Id): Promise<Array<{ at: Date }>> {
    const items = await queryAll(TABLES.adImpressions, CREATOR_INDEX, 'creatorId = :c', {
      ':c': creatorId,
    })
    return items.map((item) => ({ at: new Date(Number(item.shownAt)) }))
  },

  async record(fields: ImpressionRecordFields): Promise<void> {
    try {
      await docClient().send(
        new PutCommand({
          TableName: TABLES.adImpressions,
          Item: {
            id: fields.dedupeKey ?? newObjectId(),
            adId: fields.adId,
            videoId: fields.videoId,
            creatorId: fields.creatorId,
            viewerId: fields.viewerId,
            shownAt: fields.shownAt.getTime(),
          },
          ConditionExpression: 'attribute_not_exists(id)',
        }),
      )
    } catch (err) {
      if (isConditionalCheckFailed(err)) return
      throw err
    }
  },
}
