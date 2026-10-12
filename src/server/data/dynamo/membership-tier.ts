import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb'
import { docClient, TABLES } from './client.ts'
import { newObjectId } from '../object-id.ts'
import {
  DuplicateTierName,
  type Id,
  type MembershipTierRepo,
  type TierCreateFields,
  type TierRow,
  type TierUpdateFields,
} from '../types.ts'

const TABLE = TABLES.membershipTiers
export const CREATOR_INDEX = 'by-creator'

type Item = Record<string, unknown>

const guardId = (creatorId: Id, name: string) => `NAME#${creatorId}#${name.trim()}`

function toRow(item: Item): TierRow {
  return {
    id: String(item.id),
    creatorId: String(item.creatorId),
    name: String(item.name ?? ''),
    description: String(item.description ?? ''),
    priceCents: Number(item.priceCents) || 0,
    currency: String(item.currency || 'usd'),
    rank: Number(item.rank) || 0,
    active: item.active === true,
  }
}

function byRankThenName(a: TierRow, b: TierRow): number {
  return a.rank - b.rank || a.name.localeCompare(b.name)
}

async function allByCreator(creatorId: Id): Promise<TierRow[]> {
  const client = docClient()
  const rows: TierRow[] = []
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
}

export const membershipTiers: MembershipTierRepo = {
  async findById(tierId: Id): Promise<TierRow | null> {
    const out = await docClient().send(new GetCommand({ TableName: TABLE, Key: { id: tierId } }))
    return out.Item?.creatorId ? toRow(out.Item) : null
  },

  async findActiveOwned(tierId: Id, creatorId: Id): Promise<TierRow | null> {
    const out = await docClient().send(new GetCommand({ TableName: TABLE, Key: { id: tierId } }))
    if (!out.Item?.creatorId) return null
    const row = toRow(out.Item)
    return row.creatorId === creatorId && row.active ? row : null
  },

  async listActiveByCreator(creatorId: Id): Promise<TierRow[]> {
    const rows = await allByCreator(creatorId)
    return rows.filter((row) => row.active).sort(byRankThenName)
  },

  async listByIds(ids: readonly Id[]): Promise<TierRow[]> {
    if (ids.length === 0) return []
    const client = docClient()
    const unique = [...new Set(ids)]
    const rows: TierRow[] = []

    for (let i = 0; i < unique.length; i += 100) {
      let keys = unique.slice(i, i + 100).map((id) => ({ id }))

      while (keys.length > 0) {
        const out = await client.send(
          new BatchGetCommand({ RequestItems: { [TABLE]: { Keys: keys } } }),
        )
        for (const item of out.Responses?.[TABLE] ?? []) {
          if (item.creatorId) rows.push(toRow(item))
        }
        keys = (out.UnprocessedKeys?.[TABLE]?.Keys ?? []) as Array<{ id: string }>
      }
    }

    return rows
  },

  async countActiveByCreator(creatorId: Id): Promise<number> {
    const rows = await allByCreator(creatorId)
    return rows.filter((row) => row.active).length
  },

  async create(creatorId: Id, fields: TierCreateFields): Promise<TierRow> {
    const row: TierRow = { id: newObjectId(), creatorId, active: true, ...fields }

    try {
      await docClient().send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: TABLE,
                Item: { ...row },
                ConditionExpression: 'attribute_not_exists(id)',
              },
            },
            {
              Put: {
                TableName: TABLE,
                Item: { id: guardId(creatorId, fields.name), tierId: row.id },
                ConditionExpression: 'attribute_not_exists(id)',
              },
            },
          ],
        }),
      )
    } catch (err) {
      if ((err as { name?: string }).name === 'TransactionCanceledException') {
        throw new DuplicateTierName()
      }
      throw err
    }

    return row
  },

  async updateOwn(
    tierId: Id,
    creatorId: Id,
    fields: TierUpdateFields,
  ): Promise<TierRow | null> {
    const current = await membershipTiers.findActiveOwned(tierId, creatorId)
    if (!current) return null

    const next: TierRow = { ...current, ...fields }
    const renamed = next.name.trim() !== current.name.trim()

    const items: NonNullable<
      ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
    > = [
      {
        Put: {
          TableName: TABLE,
          Item: { ...next },
          ConditionExpression: 'creatorId = :c AND active = :t',
          ExpressionAttributeValues: { ':c': creatorId, ':t': true },
        },
      },
    ]

    if (renamed) {
      items.push({
        Put: {
          TableName: TABLE,
          Item: { id: guardId(creatorId, next.name), tierId },
          ConditionExpression: 'attribute_not_exists(id)',
        },
      })
      items.push({ Delete: { TableName: TABLE, Key: { id: guardId(creatorId, current.name) } } })
    }

    try {
      await docClient().send(new TransactWriteCommand({ TransactItems: items }))
    } catch (err) {
      if ((err as { name?: string }).name === 'TransactionCanceledException') {
        if (renamed) throw new DuplicateTierName()
        return null
      }
      throw err
    }

    return next
  },

  async archive(tierId: Id, creatorId: Id): Promise<boolean> {
    const current = await membershipTiers.findActiveOwned(tierId, creatorId)
    if (!current) return false

    try {
      await docClient().send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: TABLE,
                Item: { ...current, active: false },
                ConditionExpression: 'creatorId = :c AND active = :t',
                ExpressionAttributeValues: { ':c': creatorId, ':t': true },
              },
            },
            { Delete: { TableName: TABLE, Key: { id: guardId(creatorId, current.name) } } },
          ],
        }),
      )
    } catch (err) {
      if ((err as { name?: string }).name === 'TransactionCanceledException') return false
      throw err
    }

    return true
  },
}
