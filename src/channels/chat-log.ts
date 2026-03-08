import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { IChatEntry } from './types.js'

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
    return JSON.parse(raw) as IChatEntry[]
  }

  readLast(count: number): IChatEntry[] {
    return this.readAll().slice(-count)
  }
}
