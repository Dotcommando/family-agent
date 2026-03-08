import { IntegrationStatus } from './types.js'
import type { IIntegration } from './types.js'
import type { IAppSecrets } from '../config/types.js'
import type { EventBus } from '../queue/event-bus.js'
import { EventSource, EventPriority } from '../queue/types.js'

export class TelegramIntegration implements IIntegration {
  readonly name = 'telegram'
  private currentStatus: IntegrationStatus = IntegrationStatus.NotConfigured
  private readonly secrets: IAppSecrets
  private readonly eventBus: EventBus
  private pollInterval: ReturnType<typeof setInterval> | undefined

  constructor(secrets: IAppSecrets, eventBus: EventBus) {
    this.secrets = secrets
    this.eventBus = eventBus
  }

  status(): IntegrationStatus {
    return this.currentStatus
  }

  async start(): Promise<void> {
    if (!this.secrets.telegramApiId || !this.secrets.telegramApiHash || !this.secrets.telegramSession) {
      console.log('[telegram] missing required secrets, skipping start')
      this.currentStatus = IntegrationStatus.NotConfigured
      return
    }

    console.log('[telegram] starting MTProto user account client')
    this.currentStatus = IntegrationStatus.Connecting

    // TODO: Initialize gram.js / telegram client with MTProto user session
    // const { TelegramClient } = await import('telegram')
    // const { StringSession } = await import('telegram/sessions')
    // const session = new StringSession(this.secrets.telegramSession)
    // this.client = new TelegramClient(
    //   session,
    //   Number(this.secrets.telegramApiId),
    //   this.secrets.telegramApiHash,
    //   { connectionRetries: 5 }
    // )
    // await this.client.connect()

    this.currentStatus = IntegrationStatus.Connected
    console.log('[telegram] client connected (stub mode — real MTProto pending)')

    // TODO: Replace stub with real message handler
    // this.client.addEventHandler((event) => { ... }, new NewMessage({}))
    this.startStubPoll()
  }

  async stop(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = undefined
    }
    // TODO: await this.client?.disconnect()
    this.currentStatus = IntegrationStatus.NotConfigured
    console.log('[telegram] stopped')
  }

  private startStubPoll(): void {
    console.log('[telegram] stub poll active — no real messages will arrive until MTProto is wired')
  }

  handleIncomingMessage(chatId: string, text: string): void {
    this.eventBus.emit({
      source: EventSource.Telegram,
      priority: EventPriority.User,
      chatId,
      payload: text,
      batchable: true,
    })
  }
}
