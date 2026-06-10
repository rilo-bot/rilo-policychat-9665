import { MongoClient, type Db } from 'mongodb';

let client: MongoClient | null = null;
let database: Db | null = null;

/**
 * Connect to MongoDB once and reuse the connection. Reads MONGODB_URI (and an
 * optional DB_NAME) from the environment — the deploy sets these. Use the
 * native driver everywhere: `getDb().collection('things')`. No schemas.
 */
export async function connectDb(): Promise<Db> {
  if (database) return database;
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set — cannot connect to the database.');
  }
  client = new MongoClient(uri);
  await client.connect();
  database = client.db(process.env.DB_NAME || undefined);
  return database;
}

/** The connected database. Throws if called before connectDb() resolves. */
export function getDb(): Db {
  if (!database) throw new Error('Database not connected yet.');
  return database;
}
