import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { IChatEntry } from './types.js'
import { isRecord } from '../lib/type-utils.js'

function isChatEntry(value: unknown): value is IChatEntry {
  if (!isRecord(value)) {
    return false
  }
  return (
    (value['role'] === 'user' || value['role'] === 'agent') &&
    typeof value['text'] === 'string' &&
    typeof value['timestamp'] === 'string'
  )
}

function parseChatEntries(raw: string): IChatEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  return Array.isArray(parsed) ? parsed.filter(isChatEntry) : []
}

export class ChatLog {
  private readonly filePath: string

  constructor(chatDir: string, chatId: string) {
    mkdirSync(chatDir, { recursive: true })
    this.filePath = join(chatDir, `${chatId}.json`)
  }

  append(entry: IChatEntry): void {
    const entries = this.readAll()
    entries.push(entry)
    writeFileSync(this.filePath, JSON.stringify(entries, null, 2))
  }

  readAll(): IChatEntry[] {
    if (!existsSync(this.filePath)) {
      return []
    }
    const raw = readFileSync(this.filePath, 'utf8')
    return parseChatEntries(raw)
  }

  readLast(count: number): IChatEntry[] {
    return this.readAll().slice(-count)
  }
}
