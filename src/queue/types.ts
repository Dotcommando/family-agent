export enum EventPriority {
  User = 0,
  System = 10,
  Background = 20,
}

export enum EventSource {
  Telegram = 'telegram',
  TelegramChannel = 'telegram-channel',
  Terminal = 'terminal',
  Browser = 'browser',
  N8n = 'n8n',
  Rss = 'rss',
  Reddit = 'reddit',
  ThoughtLoop = 'thought-loop',
  Summarization = 'summarization',
  Internal = 'internal',
}

export enum JobStatus {
  Pending = 'pending',
  Processing = 'processing',
  Done = 'done',
  Failed = 'failed',
}

export enum TelegramChatKindEvent {
  Private = 'private',
  Group = 'group',
  Supergroup = 'supergroup',
  Channel = 'channel',
  Unknown = 'unknown',
}

export interface ITelegramMeta {
  senderId: string
  chatKind: TelegramChatKindEvent
  isMention: boolean
  isReplyToSelf: boolean
}

export interface IAgentEvent {
  id: string
  source: EventSource
  priority: EventPriority
  chatId: string | undefined
  payload: string
  createdAt: string
  batchable: boolean
  requiresResponse: boolean
  telegramMeta: ITelegramMeta | undefined
}

export interface ICoalescedBatch {
  chatId: string
  events: ReadonlyArray<IAgentEvent>
  firstAt: string
  lastAt: string
  latestPayload: string
  messageCount: number
  requiresResponse: boolean
}

export interface IJob {
  id: string
  status: JobStatus
  priority: EventPriority
  source: EventSource
  events: ReadonlyArray<IAgentEvent>
  createdAt: string
  startedAt: string | undefined
  finishedAt: string | undefined
  result: string | undefined
}
