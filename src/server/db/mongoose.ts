import mongoose from 'mongoose'

const MONGODB_URI = process.env.MONGODB_URI

interface MongooseCache {
  conn: typeof mongoose | null
  promise: Promise<typeof mongoose> | null
}

const globalForMongoose = globalThis as typeof globalThis & {
  __mongooseCache?: MongooseCache
}

const cache: MongooseCache = (globalForMongoose.__mongooseCache ??= {
  conn: null,
  promise: null,
})

export async function connectToDatabase(): Promise<typeof mongoose> {
  if (cache.conn) return cache.conn

  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is not set. Add it to your .env file (see .env.example).')
  }

  if (!cache.promise) {
    cache.promise = mongoose
      .connect(MONGODB_URI, {
        bufferCommands: false,
      })
      .then((m) => {
        console.log('MongoDB connected successfully!')
        return m
      })
      .catch((err) => {
        // Reset so a later call can retry the connection.
        console.log('MongoDB connection failed:', err)
        cache.promise = null
        throw err
      })
  }

  cache.conn = await cache.promise
  return cache.conn
}
