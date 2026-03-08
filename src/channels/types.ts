import { EventSource } from '../queue/types.js'

export enum ChannelKind {
  Terminal = 'terminal',
  Telegram = 'telegram',
  Http = 'http',
}

export interface IChatEntry {
  role: 'user' | 'agent'
  channel: ChannelKind
  text: string
  timestamp: string
}

export interface IChannelAdapter {
  readonly kind: ChannelKind
  readonly eventSource: EventSource
  sendResponse(chatId: string, text: string): Promise<void>
}
