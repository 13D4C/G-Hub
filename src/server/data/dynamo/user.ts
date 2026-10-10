import {
  BatchGetCommand,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { docClient, isConditionalCheckFailed, TABLES } from './client.ts'
import { newObjectId } from '../object-id.ts'
import {
  DuplicateEmail,
  type GoogleLinkFields,
  type Id,
  type UserCreateFields,
  type UserProfilePatch,
  type UserRepo,
  type UserRow,
} from '../types.ts'

const TABLE = TABLES.users

const emailGuard = (email: string) => `EMAIL#${email.trim().toLowerCase()}`
const googleGuard = (googleId: string) => `GOOGLE#${googleId}`

type Item = Record<string, unknown>

function toRow(item: Item): UserRow {
  return {
    id: String(item.id),
    email: String(item.email),
    passwordHash: item.passwordHash ? String(item.passwordHash) : null,
    googleId: item.googleId ? String(item.googleId) : null,
    name: String(item.name ?? ''),
    avatarUrl: String(item.avatarUrl ?? ''),
    channelName: String(item.channelName ?? ''),
    channelDescription: String(item.channelDescription ?? ''),
    channelCurrency: String(item.channelCurrency || 'usd'),
    stripeCustomerId: String(item.stripeCustomerId ?? ''),
  }
}

function isUserItem(item: Item | undefined): item is Item {
  return item !== undefined && typeof item.email === 'string'
}

async function getUser(id: Id): Promise<UserRow | null> {
  const out = await docClient().send(new GetCommand({ TableName: TABLE, Key: { id } }))
  return isUserItem(out.Item) ? toRow(out.Item) : null
}

async function followGuard(guardId: string): Promise<UserRow | null> {
  const out = await docClient().send(new GetCommand({ TableName: TABLE, Key: { id: guardId } }))
  const userId = out.Item?.userId
  return userId ? getUser(String(userId)) : null
}

function setExpression(patch: Record<string, unknown>) {
  const sets: string[] = []
  const names: Record<string, string> = {}
  const values: Record<string, unknown> = {}

  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue
    names[`#${field}`] = field
    values[`:${field}`] = value
    sets.push(`#${field} = :${field}`)
  }

  return { sets, names, values }
}

export const users: UserRepo = {
  findById: getUser,

  async findByEmail(email: string): Promise<UserRow | null> {
    return followGuard(emailGuard(email))
  },

  async findByGoogleId(googleId: string): Promise<UserRow | null> {
    return followGuard(googleGuard(googleId))
  },

  async listByIds(ids: readonly Id[]): Promise<UserRow[]> {
    if (ids.length === 0) return []
    const client = docClient()
    const unique = [...new Set(ids)]
    const rows: UserRow[] = []

    for (let i = 0; i < unique.length; i += 100) {
      let keys = unique.slice(i, i + 100).map((id) => ({ id }))

      while (keys.length > 0) {
        const out = await client.send(
          new BatchGetCommand({ RequestItems: { [TABLE]: { Keys: keys } } }),
        )
        for (const item of out.Responses?.[TABLE] ?? []) {
          if (isUserItem(item)) rows.push(toRow(item))
        }
        keys = (out.UnprocessedKeys?.[TABLE]?.Keys ?? []) as Array<{ id: string }>
      }
    }

    return rows
  },

  async create(fields: UserCreateFields): Promise<UserRow> {
    const email = fields.email.trim().toLowerCase()
    const row: UserRow = {
      id: newObjectId(),
      email,
      passwordHash: fields.passwordHash ?? null,
      googleId: fields.googleId ?? null,
      name: fields.name ?? '',
      avatarUrl: fields.avatarUrl ?? '',
      channelName: '',
      channelDescription: '',
      channelCurrency: 'usd',
      stripeCustomerId: '',
    }

    const items = [
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
          Item: { id: emailGuard(email), userId: row.id },
          ConditionExpression: 'attribute_not_exists(id)',
        },
      },
    ]

    if (row.googleId) {
      items.push({
        Put: {
          TableName: TABLE,
          Item: { id: googleGuard(row.googleId), userId: row.id },
          ConditionExpression: 'attribute_not_exists(id)',
        },
      })
    }

    try {
      await docClient().send(new TransactWriteCommand({ TransactItems: items }))
    } catch (err) {
      if ((err as { name?: string }).name === 'TransactionCanceledException') {
        throw new DuplicateEmail()
      }
      throw err
    }

    return row
  },

  async updateProfile(id: Id, patch: UserProfilePatch): Promise<void> {
    const { sets, names, values } = setExpression(patch)
    if (sets.length === 0) return

    await docClient().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { id },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: 'attribute_exists(id)',
      }),
    )
  },

  async linkGoogle(id: Id, fields: GoogleLinkFields): Promise<void> {
    const patch: Record<string, unknown> = { googleId: fields.googleId }
    if (fields.name) patch.name = fields.name
    if (fields.avatarUrl) patch.avatarUrl = fields.avatarUrl
    const { sets, names, values } = setExpression(patch)

    await docClient().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: { id },
              UpdateExpression: `SET ${sets.join(', ')}`,
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
              ConditionExpression: 'attribute_exists(id)',
            },
          },
          {
            Put: {
              TableName: TABLE,
              Item: { id: googleGuard(fields.googleId), userId: id },
              ConditionExpression: 'attribute_not_exists(id)',
            },
          },
        ],
      }),
    )
  },

  async setAvatar(id: Id, avatarUrl: string): Promise<void> {
    await docClient().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { id },
        UpdateExpression: 'SET avatarUrl = :a',
        ExpressionAttributeValues: { ':a': avatarUrl },
        ConditionExpression: 'attribute_exists(id)',
      }),
    )
  },

  async claimStripeCustomerId(id: Id, customerId: string): Promise<string> {
    try {
      const out = await docClient().send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { id },
          UpdateExpression: 'SET stripeCustomerId = :c',
          ConditionExpression:
            'attribute_exists(id) AND (attribute_not_exists(stripeCustomerId) OR stripeCustomerId = :empty)',
          ExpressionAttributeValues: { ':c': customerId, ':empty': '' },
          ReturnValues: 'ALL_NEW',
        }),
      )
      return String(out.Attributes?.stripeCustomerId || customerId)
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err
      const existing = await getUser(id)
      return existing?.stripeCustomerId || customerId
    }
  },
}
