import { EventSource } from '../queue/types.js'
import { ChannelKind } from './types.js'
import type { IChannelAdapter, IChatEntry } from './types.js'
import { ChatLog } from './chat-log.js'

export const TERMINAL_CHAT_ID = 'terminal-local'

export class TerminalAdapter implements IChannelAdapter {
  readonly kind = ChannelKind.Terminal
  readonly eventSource = EventSource.Internal
  private readonly chatLog: ChatLog

  constructor(chatDir: string) {
    this.chatLog = new ChatLog(chatDir, TERMINAL_CHAT_ID)
  }

  async sendResponse(chatId: string, text: string): Promise<void> {
    const entry: IChatEntry = {
      role: 'agent',
      channel: ChannelKind.Terminal,
      text,
      timestamp: new Date().toISOString(),
    }
    this.chatLog.append(entry)
    console.log(`[terminal] agent response saved to chat log`)
  }

  logUserMessage(text: string): void {
    const entry: IChatEntry = {
      role: 'user',
      channel: ChannelKind.Terminal,
      text,
      timestamp: new Date().toISOString(),
    }
    this.chatLog.append(entry)
  }

  readHistory(count: number): ReadonlyArray<IChatEntry> {
    return this.chatLog.readLast(count)
  }
}
