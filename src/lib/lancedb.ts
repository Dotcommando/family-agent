import { mkdirSync } from 'node:fs'
import * as lancedb from '@lancedb/lancedb'

export async function initLanceDb(dbDir: string): Promise<void> {
  mkdirSync(dbDir, { recursive: true })
  const db = await lancedb.connect(dbDir)
  await db.tableNames()
}
