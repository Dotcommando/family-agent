import { readSecret, maskSecret } from './read-secret.js'
import type { IAppSecrets, IRequiredSecret, ISecretStatus } from './types.js'

const REQUIRED_SECRETS: IRequiredSecret[] = [
  {
    fileName: 'telegram_api_id',
    displayName: 'telegram_api_id'
  },
  {
    fileName: 'telegram_api_hash',
    displayName: 'telegram_api_hash'
  },
  {
    fileName: 'telegram_session',
    displayName: 'telegram_session'
  },
  {
    fileName: 'n8n_api_key',
    displayName: 'n8n_api_key'
  }
]

export function readAppSecrets(secretDir: string): IAppSecrets {
  return {
    telegramApiId: readSecret(secretDir, 'telegram_api_id'),
    telegramApiHash: readSecret(secretDir, 'telegram_api_hash'),
    telegramSession: readSecret(secretDir, 'telegram_session'),
    n8nApiKey: readSecret(secretDir, 'n8n_api_key')
  }
}

export function getSecretStatuses(secretDir: string): ISecretStatus[] {
  return REQUIRED_SECRETS.map((secret) => {
    try {
      const value = readSecret(secretDir, secret.fileName)
      return {
        name: secret.displayName,
        isPresent: Boolean(value),
        maskedValue: maskSecret(value)
      }
    } catch {
      return {
        name: secret.displayName,
        isPresent: false,
        maskedValue: 'missing'
      }
    }
  })
}
