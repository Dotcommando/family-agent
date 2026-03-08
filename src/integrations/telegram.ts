import { IntegrationStatus } from './types.js'
import type { IIntegration } from './types.js'
import type { IAppSecrets } from '../config/types.js'
import type { EventBus } from '../queue/event-bus.js'
import { EventSource, EventPriority } from '../queue/types.js'
import { TelegramAdapter } from '../channels/telegram-adapter.js'

export class TelegramIntegration implements IIntegration {
  readonly name = 'telegram'
  readonly adapter = new TelegramAdapter()
  private currentStatus: IntegrationStatus = IntegrationStatus.NotConfigured
  private readonly secrets: IAppSecrets
  private readonly eventBus: EventBus
  private disconnectFn: (() => Promise<void>) | undefined

  constructor(secrets: IAppSecrets, eventBus: EventBus) {
    this.secrets = secrets
    this.eventBus = eventBus
  }

  status(): IntegrationStatus {
    return this.currentStatus
  }

  async start(): Promise<void> {
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

    console.log('[telegram] starting MTProto user account client')
    this.currentStatus = IntegrationStatus.Connecting

    try {
      const { TelegramClient, sessions, } = await import('telegram')
      const { NewMessage } = await import('telegram/events')

      const session = new sessions.StringSession(this.secrets.telegramSession)
      const client = new TelegramClient(session, apiId, this.secrets.telegramApiHash, {
        connectionRetries: 5,
      })

      await client.connect()

      this.disconnectFn = async () => {
        await client.disconnect()
      }

      this.adapter.setSendFn(async (chatId: string, text: string) => {
        await client.sendMessage(chatId, { message: text })
        console.log(`[telegram] sent response to chat ${chatId} (${text.length} chars)`)
      })

      client.addEventHandler((event) => {
        const message = event.message
        if (!message || !message.text) {
          return
        }

        const chatId = message.chatId !== undefined ? String(message.chatId) : 'unknown'
        const senderId = message.senderId !== undefined ? String(message.senderId) : 'unknown'

        console.log(`[telegram] incoming message from chat=${chatId} sender=${senderId} msgId=${message.id}`)

        this.eventBus.emit({
          source: EventSource.Telegram,
          priority: EventPriority.User,
          chatId,
          payload: message.text,
          batchable: true,
        })
      }, new NewMessage({}))

      this.currentStatus = IntegrationStatus.Connected
      console.log('[telegram] MTProto client connected and listening for messages')
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[telegram] failed to connect: ${errMsg}`)
      this.currentStatus = IntegrationStatus.Error
    }
  }

  async stop(): Promise<void> {
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
}
