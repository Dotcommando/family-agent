import { IntegrationStatus } from './types.js'
import type { IIntegration } from './types.js'

export class BlogIntegration implements IIntegration {
  readonly name = 'blog'
  private currentStatus: IntegrationStatus = IntegrationStatus.NotConfigured

  status(): IntegrationStatus {
    return this.currentStatus
  }

  async start(): Promise<void> {
    console.log('[blog] blog tools initialized (stub mode — publishing pipeline pending)')
    this.currentStatus = IntegrationStatus.Connected
  }

  async stop(): Promise<void> {
    this.currentStatus = IntegrationStatus.NotConfigured
    console.log('[blog] stopped')
  }
}
