import { IntegrationStatus } from './types.js'
import type { IIntegration } from './types.js'
import { TelegramChatKind } from './telegram-types.js'
import type { IAppSecrets } from '../config/types.js'
import type { IEnvConfig } from '../config/env.js'
import type { EventBus } from '../queue/event-bus.js'
import { EventSource, EventPriority } from '../queue/types.js'
import { TelegramAdapter } from '../channels/telegram-adapter.js'

const RECONNECT_BASE_MS = 5_000
const RECONNECT_MAX_MS = 300_000
const RECONNECT_MULTIPLIER = 2

interface ITelegramModules {
  TelegramClient: typeof import('telegram').TelegramClient
  sessions: typeof import('telegram').sessions
  Api: typeof import('telegram').Api
  NewMessage: typeof import('telegram/events').NewMessage
}

export class TelegramIntegration implements IIntegration {
  readonly name = 'telegram'
  readonly adapter = new TelegramAdapter()
  private currentStatus: IntegrationStatus = IntegrationStatus.NotConfigured
  private readonly secrets: IAppSecrets
  private readonly config: IEnvConfig
  private readonly eventBus: EventBus
  private disconnectFn: (() => Promise<void>) | undefined
  private selfUsername: string | undefined
  private selfId: string | undefined
  private sentMessageIds = new Set<number>()
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectAttempt = 0
  private stopped = false

  constructor(secrets: IAppSecrets, config: IEnvConfig, eventBus: EventBus) {
    this.secrets = secrets
    this.config = config
    this.eventBus = eventBus
  }

  status(): IntegrationStatus {
    return this.currentStatus
  }

  async start(): Promise<void> {
    this.stopped = false

    if (!this.secrets.telegramApiId || !this.secrets.telegramApiHash || !this.secrets.telegramSession) {
      console.log('[telegram] missing required secrets (telegram_api_id, telegram_api_hash, telegram_session), skipping start')
      this.currentStatus = IntegrationStatus.NotConfigured
      return
    }

    const apiId = Number(this.secrets.telegramApiId)
    if (!Number.isFinite(apiId) || apiId <= 0) {
      console.log('[telegram] telegram_api_id is not a valid number, skipping start')
      this.currentStatus = IntegrationStatus.NotConfigured
      return
    }

    await this.connect(apiId)
  }

  async stop(): Promise<void> {
    this.stopped = true

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }

    if (this.disconnectFn) {
      try {
        await this.disconnectFn()
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`[telegram] error during disconnect: ${errMsg}`)
      }
      this.disconnectFn = undefined
    }
    this.currentStatus = IntegrationStatus.NotConfigured
    console.log('[telegram] stopped')
  }

  private async loadModules(): Promise<ITelegramModules> {
    const { TelegramClient, sessions, Api } = await import('telegram')
    const { NewMessage } = await import('telegram/events')
    return { TelegramClient, sessions, Api, NewMessage }
  }

  private async connect(apiId: number): Promise<void> {
    console.log('[telegram] starting MTProto user account client')
    this.currentStatus = IntegrationStatus.Connecting

    try {
      const tg = await this.loadModules()

      const session = new tg.sessions.StringSession(this.secrets.telegramSession)
      const client = new tg.TelegramClient(session, apiId, this.secrets.telegramApiHash, {
        connectionRetries: 5,
      })

      await client.connect()
      this.reconnectAttempt = 0

      this.disconnectFn = async () => {
        await client.disconnect()
      }

      await this.fetchSelfInfo(client)
      this.wireSendFn(client)
      this.wireEventHandler(client, tg)

      this.currentStatus = IntegrationStatus.Connected
      console.log('[telegram] MTProto client connected and listening for messages')
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[telegram] failed to connect: ${errMsg}`)
      this.currentStatus = IntegrationStatus.Error
      this.scheduleReconnect(apiId)
    }
  }

  private scheduleReconnect(apiId: number): void {
    if (this.stopped) {
      return
    }

    const delayMs = Math.min(
      RECONNECT_BASE_MS * Math.pow(RECONNECT_MULTIPLIER, this.reconnectAttempt),
      RECONNECT_MAX_MS,
    )
    this.reconnectAttempt++

    console.log(`[telegram] scheduling reconnect #${this.reconnectAttempt} in ${Math.round(delayMs / 1000)}s`)
    this.currentStatus = IntegrationStatus.Connecting

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connect(apiId)
    }, delayMs)
  }

  private async fetchSelfInfo(client: InstanceType<ITelegramModules['TelegramClient']>): Promise<void> {
    try {
      const me = await client.getMe(false)
      this.selfUsername = me.username ?? undefined
      this.selfId = me.id ? String(me.id) : undefined
      if (this.selfUsername) {
        console.log(`[telegram] self username: @${this.selfUsername}`)
      } else {
        console.log('[telegram] self username not set — mention detection in groups will rely on reply-to-agent only')
      }
      if (this.selfId) {
        console.log(`[telegram] self id: ${this.selfId}`)
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.log(`[telegram] could not fetch self info: ${errMsg}`)
    }
  }

  private wireSendFn(client: InstanceType<ITelegramModules['TelegramClient']>): void {
    this.adapter.setSendFn(async (chatId: string, text: string) => {
      const result = await client.sendMessage(chatId, { message: text })
      if (result && typeof result.id === 'number') {
        this.sentMessageIds.add(result.id)
        if (this.sentMessageIds.size > 500) {
          const oldest = this.sentMessageIds.values().next()
          if (!oldest.done) {
            this.sentMessageIds.delete(oldest.value)
          }
        }
      }
      console.log(`[telegram] sent response to chat ${chatId} (${text.length} chars)`)
    })
  }

  private wireEventHandler(
    client: InstanceType<ITelegramModules['TelegramClient']>,
    tg: ITelegramModules,
  ): void {
    client.addEventHandler((event) => {
      const message = event.message
      if (!message) {
        return
      }

      const text = message.text || ''
      const rawMessage = typeof message.message === 'string' ? message.message : ''
      const content = text || rawMessage

      if (!content) {
        return
      }

      const chatKind = this.detectChatKind(message, tg.Api)
      const chatId = message.chatId !== undefined ? String(message.chatId) : 'unknown'
      const senderId = message.senderId !== undefined ? String(message.senderId) : 'unknown'

      console.log(`[telegram] incoming message chat=${chatId} sender=${senderId} kind=${chatKind} msgId=${message.id}`)

      if (!this.isAllowed(chatId, senderId)) {
        console.log(`[telegram] ignored — chat=${chatId} sender=${senderId} not in whitelist`)
        return
      }

      if (chatKind === TelegramChatKind.Channel) {
        console.log(`[telegram] channel post chat=${chatId} — observation event, no response will be sent`)
        this.eventBus.emit({
          source: EventSource.TelegramChannel,
          priority: EventPriority.Background,
          chatId,
          payload: content,
          batchable: true,
          requiresResponse: false,
        })
        return
      }

      if (
        (chatKind === TelegramChatKind.Group || chatKind === TelegramChatKind.Supergroup) &&
        this.config.telegramRequireMentionInGroups
      ) {
        const isMentioned = this.checkMention(content)
        const isReplyToSelf = this.checkReplyToSelf(message)

        if (!isMentioned && !isReplyToSelf) {
          console.log(`[telegram] group message skipped — no mention/reply (chat=${chatId})`)
          return
        }
        console.log(`[telegram] group message accepted — mention=${isMentioned} replyToSelf=${isReplyToSelf}`)
      }

      this.eventBus.emit({
        source: EventSource.Telegram,
        priority: EventPriority.User,
        chatId,
        payload: content,
        batchable: true,
        requiresResponse: true,
      })
    }, new tg.NewMessage({}))
  }

  private detectChatKind(
    message: { peerId?: unknown; post?: boolean },
    Api: ITelegramModules['Api'],
  ): TelegramChatKind {
    const peerId = message.peerId
    if (!peerId || typeof peerId !== 'object') {
      return TelegramChatKind.Unknown
    }

    if (peerId instanceof Api.PeerUser) {
      return TelegramChatKind.Private
    }

    if (peerId instanceof Api.PeerChat) {
      return TelegramChatKind.Group
    }

    if (peerId instanceof Api.PeerChannel) {
      return message.post === true
        ? TelegramChatKind.Channel
        : TelegramChatKind.Supergroup
    }

    return TelegramChatKind.Unknown
  }

  private checkMention(text: string): boolean {
    if (!this.selfUsername) {
      return false
    }
    return text.toLowerCase().includes(`@${this.selfUsername.toLowerCase()}`)
  }

  private checkReplyToSelf(message: { replyTo?: unknown }): boolean {
    const replyTo = message.replyTo
    if (!replyTo || typeof replyTo !== 'object') {
      return false
    }
    const header = replyTo
    if (!('replyToMsgId' in header) || typeof header.replyToMsgId !== 'number') {
      return false
    }
    return this.sentMessageIds.has(header.replyToMsgId)
  }

  private isAllowed(chatId: string, senderId: string): boolean {
    const chatWhitelist = this.config.telegramAllowedChats
    const userWhitelist = this.config.telegramAllowedUsers

    if (chatWhitelist.length === 0 && userWhitelist.length === 0) {
      return true
    }

    if (chatWhitelist.length > 0 && chatWhitelist.includes(chatId)) {
      return true
    }

    if (userWhitelist.length > 0 && userWhitelist.includes(senderId)) {
      return true
    }

    return false
  }
}
