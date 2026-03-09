import { mkdirSync } from 'node:fs'
import type { BrowserContext } from 'playwright'
import { IntegrationStatus } from './types.js'
import type { IIntegration } from './types.js'
import type { IBrowserConfig } from '../browser/types.js'

export class BrowserIntegration implements IIntegration {
  readonly name = 'browser'
  private currentStatus: IntegrationStatus = IntegrationStatus.NotConfigured
  private browserContext: BrowserContext | undefined
  private readonly browserConfig: IBrowserConfig

  constructor(browserConfig: IBrowserConfig) {
    this.browserConfig = browserConfig
  }

  status(): IntegrationStatus {
    return this.currentStatus
  }

  getContext(): BrowserContext | undefined {
    return this.browserContext
  }

  getBrowserConfig(): IBrowserConfig {
    return this.browserConfig
  }

  async start(): Promise<void> {
    console.log('[browser] initializing Playwright integration')
    this.currentStatus = IntegrationStatus.Connecting

    try {
      mkdirSync(this.browserConfig.profileDir, { recursive: true })
      console.log(`[browser] profile directory: ${this.browserConfig.profileDir}`)

      const { chromium } = await import('playwright')
      this.browserContext = await chromium.launchPersistentContext(this.browserConfig.profileDir, {
        headless: this.browserConfig.headless,
        args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
      })

      this.currentStatus = IntegrationStatus.Connected
      console.log('[browser] Playwright ready (persistent profile)')
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[browser] failed to start Playwright: ${errMsg}`)
      this.currentStatus = IntegrationStatus.Error
      this.browserContext = undefined
    }
  }

  async stop(): Promise<void> {
    if (this.browserContext) {
      try {
        await this.browserContext.close()
        console.log('[browser] browser context closed')
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`[browser] error closing browser context: ${errMsg}`)
      }
      this.browserContext = undefined
    }
    this.currentStatus = IntegrationStatus.NotConfigured
    console.log('[browser] stopped')
  }
}
