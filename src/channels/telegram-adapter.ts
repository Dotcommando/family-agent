import { EventSource } from '../queue/types.js'
import { ChannelKind } from './types.js'
import type { IChannelAdapter } from './types.js'

export class TelegramAdapter implements IChannelAdapter {
  readonly kind = ChannelKind.Telegram
  readonly eventSource = EventSource.Telegram
  private sendFn: ((chatId: string, text: string) => Promise<void>) | undefined

  setSendFn(fn: (chatId: string, text: string) => Promise<void>): void {
    this.sendFn = fn
  }

  async sendResponse(chatId: string, text: string): Promise<void> {
    if (!this.sendFn) {
      console.log(`[telegram-adapter] send not wired, dropping response for chat ${chatId} (${text.length} chars)`)
      return
    }
    await this.sendFn(chatId, text)
  }
}
