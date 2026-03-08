import { IntegrationStatus } from './types.js'
import type { IIntegration } from './types.js'
import type { IAppSecrets } from '../config/types.js'

export class N8nIntegration implements IIntegration {
  readonly name = 'n8n'
  private currentStatus: IntegrationStatus = IntegrationStatus.NotConfigured
  private readonly secrets: IAppSecrets

  constructor(secrets: IAppSecrets) {
    this.secrets = secrets
  }

  status(): IntegrationStatus {
    return this.currentStatus
  }

  async start(): Promise<void> {
    if (!this.secrets.n8nApiKey) {
      console.log('[n8n] missing n8n_api_key, skipping start')
      this.currentStatus = IntegrationStatus.NotConfigured
      return
    }

    console.log('[n8n] integration initialized (stub mode — webhook listener pending)')
    this.currentStatus = IntegrationStatus.Connected
  }

  async stop(): Promise<void> {
    this.currentStatus = IntegrationStatus.NotConfigured
    console.log('[n8n] stopped')
  }
}
