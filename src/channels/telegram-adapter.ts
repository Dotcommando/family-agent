import { EventSource } from '../queue/types.js'
import { ChannelKind } from './types.js'
import type { IChannelAdapter } from './types.js'

export class TelegramAdapter implements IChannelAdapter {
  readonly kind = ChannelKind.Telegram
  readonly eventSource = EventSource.Telegram

  async sendResponse(chatId: string, text: string): Promise<void> {
    // TODO: Send message via MTProto client
    console.log(`[telegram-adapter] response for chat ${chatId} (${text.length} chars) — send not yet wired`)
  }
}
