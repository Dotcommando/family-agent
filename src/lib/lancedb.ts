import { mkdirSync } from 'node:fs'
import * as lancedb from '@lancedb/lancedb'

interface ILanceDbContext {
  db: lancedb.Connection
}

let dbContext: ILanceDbContext | undefined

export async function initLanceDb(dbDir: string): Promise<void> {
  mkdirSync(dbDir, { recursive: true })
  const db = await lancedb.connect(dbDir)
  await db.tableNames()
  dbContext = { db }
}

export function getLanceDb(): lancedb.Connection {
  if (!dbContext) {
    throw new Error('LanceDB not initialized. Call initLanceDb first.')
  }
  return dbContext.db
}

export interface IMemoryDocument {
  id: string
  source: string
  content: string
  milestone: string
  createdAt: string
  vector: number[]
}

function toRecord(doc: IMemoryDocument): Record<string, unknown> {
  return {
    id: doc.id,
    source: doc.source,
    content: doc.content,
    milestone: doc.milestone,
    createdAt: doc.createdAt,
    vector: doc.vector,
  }
}

export async function ensureMemoryTable(db: lancedb.Connection): Promise<lancedb.Table> {
  const tables = await db.tableNames()
  if (tables.includes('memory')) {
    return db.openTable('memory')
  }

  const seed: Record<string, unknown>[] = [toRecord({
    id: '_seed',
    source: 'system',
    content: 'Memory table initialized',
    milestone: 'none',
    createdAt: new Date().toISOString(),
    vector: new Array<number>(384).fill(0),
  })]

  return db.createTable('memory', seed)
}

export async function upsertMemoryDocuments(
  table: lancedb.Table,
  documents: ReadonlyArray<IMemoryDocument>,
): Promise<void> {
  if (documents.length === 0) {
    return
  }
  await table.add(documents.map(toRecord))
  console.log(`[lancedb] upserted ${documents.length} documents`)
}
