import { IntegrationStatus } from './types.js'
import type { IIntegration } from './types.js'

export class BrowserIntegration implements IIntegration {
  readonly name = 'browser'
  private currentStatus: IntegrationStatus = IntegrationStatus.NotConfigured

  status(): IntegrationStatus {
    return this.currentStatus
  }

  async start(): Promise<void> {
    console.log('[browser] initializing Playwright integration')
    this.currentStatus = IntegrationStatus.Connecting

    // TODO: Wire Playwright with persistent browser profile
    // const { chromium } = await import('playwright')
    // this.browser = await chromium.launchPersistentContext('/app/data/browser-profile', {
    //   headless: true,
    // })

    this.currentStatus = IntegrationStatus.Connected
    console.log('[browser] Playwright ready (stub mode — real browser pending)')
  }

  async stop(): Promise<void> {
    // TODO: await this.browser?.close()
    this.currentStatus = IntegrationStatus.NotConfigured
    console.log('[browser] stopped')
  }
}
