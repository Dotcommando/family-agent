export enum IntegrationStatus {
  NotConfigured = 'not-configured',
  Connecting = 'connecting',
  Connected = 'connected',
  Error = 'error',
}

export interface IIntegration {
  readonly name: string
  status(): IntegrationStatus
  start(): Promise<void>
  stop(): Promise<void>
}
