import { IntegrationStatus } from './types.js'
import type { IIntegration } from './types.js'
import { TelegramChatKind } from './telegram-types.js'
import type { IAppSecrets } from '../config/types.js'
import type { IEnvConfig } from '../config/env.js'
import type { EventBus } from '../queue/event-bus.js'
import { EventSource, EventPriority, TelegramChatKindEvent } from '../queue/types.js'
import type { ITelegramMeta } from '../queue/types.js'
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

function chatKindToEventKind(kind: TelegramChatKind): TelegramChatKindEvent {
  switch (kind) {
    case TelegramChatKind.Private: return TelegramChatKindEvent.Private
    case TelegramChatKind.Group: return TelegramChatKindEvent.Group
    case TelegramChatKind.Supergroup: return TelegramChatKindEvent.Supergroup
    case TelegramChatKind.Channel: return TelegramChatKindEvent.Channel
    case TelegramChatKind.Unknown: return TelegramChatKindEvent.Unknown
  }
}

export class TelegramIntegration implements IIntegration {
  readonly name = 'telegram'
  readonly adapter = new TelegramAdapter()
  private currentStatus: IntegrationStatus = IntegrationStatus.NotConfigured
  private readonly secrets: IAppSecrets
  private readonly config: IEnvConfig
  private readonly eventBus: EventBus
  private client: InstanceType<ITelegramModules['TelegramClient']> | undefined
  private tgModules: ITelegramModules | undefined
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

    if (this.client) {
      try {
        await this.client.disconnect()
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`[telegram] error during disconnect: ${errMsg}`)
      }
      this.client = undefined
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
      this.tgModules = tg

      const session = new tg.sessions.StringSession(this.secrets.telegramSession)
      const client = new tg.TelegramClient(session, apiId, this.secrets.telegramApiHash, {
        connectionRetries: 5,
      })

      await client.connect()
      this.reconnectAttempt = 0
      this.client = client

      await this.fetchSelfInfo(client)
      this.wireSendFn(client)
      this.wireEventHandler(client, tg)
      this.wireDisconnectDetection(client, apiId)

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
      void this.reconnect(apiId)
    }, delayMs)
  }

  private async reconnect(apiId: number): Promise<void> {
    if (this.client) {
      try {
        await this.client.disconnect()
      } catch {
        // ignore cleanup errors
      }
      this.client = undefined
    }

    await this.connect(apiId)
  }

  private wireDisconnectDetection(
    client: InstanceType<ITelegramModules['TelegramClient']>,
    apiId: number,
  ): void {
    const checkInterval = setInterval(() => {
      if (this.stopped) {
        clearInterval(checkInterval)
        return
      }
      if (client !== this.client) {
        clearInterval(checkInterval)
        return
      }
      if (!client.connected) {
        console.log('[telegram] runtime disconnect detected — scheduling reconnect')
        this.currentStatus = IntegrationStatus.Error
        clearInterval(checkInterval)
        this.scheduleReconnect(apiId)
      }
    }, 30_000)
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
      const numericId = Number(chatId)
      const entity = Number.isFinite(numericId) ? numericId : chatId

      try {
        const result = await client.sendMessage(entity, { message: text })
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
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`[telegram] failed to send message to chat ${chatId}: ${errMsg}`)
      }
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

      if (this.selfId && message.senderId !== undefined && String(message.senderId) === this.selfId) {
        return
      }

      if (message.id !== undefined && this.sentMessageIds.has(message.id)) {
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

      const isMentioned = this.checkMention(content)
      const isReplyToSelf = this.checkReplyToSelf(message)

      if (chatKind === TelegramChatKind.Channel) {
        console.log(`[telegram] channel post chat=${chatId} — observation event, no response will be sent`)
        const meta: ITelegramMeta = {
          senderId,
          chatKind: chatKindToEventKind(chatKind),
          isMention: false,
          isReplyToSelf: false,
        }
        this.eventBus.emit({
          source: EventSource.TelegramChannel,
          priority: EventPriority.Background,
          chatId,
          payload: content,
          batchable: true,
          requiresResponse: false,
          telegramMeta: meta,
        })
        return
      }

      if (
        (chatKind === TelegramChatKind.Group || chatKind === TelegramChatKind.Supergroup) &&
        this.config.telegramRequireMentionInGroups
      ) {
        if (!isMentioned && !isReplyToSelf) {
          console.log(`[telegram] group message skipped — no mention/reply (chat=${chatId})`)
          return
        }
        console.log(`[telegram] group message accepted — mention=${isMentioned} replyToSelf=${isReplyToSelf}`)
      }

      const meta: ITelegramMeta = {
        senderId,
        chatKind: chatKindToEventKind(chatKind),
        isMention: isMentioned,
        isReplyToSelf,
      }
      this.eventBus.emit({
        source: EventSource.Telegram,
        priority: EventPriority.User,
        chatId,
        payload: content,
        batchable: true,
        requiresResponse: true,
        telegramMeta: meta,
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
