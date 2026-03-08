export interface IRequiredSecret {
  fileName: string
  displayName: string
}

export interface ISecretStatus {
  name: string
  isPresent: boolean
  maskedValue: string
}

export interface IAppSecrets {
  telegramApiId: string
  telegramApiHash: string
  telegramSession: string
  n8nApiKey: string
}
