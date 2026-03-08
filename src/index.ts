import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readEnvConfig } from './config/env.js'
import { getSecretStatuses, readAppSecrets } from './config/secrets.js'
import { initLanceDb, getLanceDb, ensureMemoryTable } from './lib/lancedb.js'
import { startHttpServer } from './http/server.js'
import { EventBus } from './queue/event-bus.js'
import { EventQueue } from './queue/event-queue.js'
import { Orchestrator } from './runtime/orchestrator.js'
import { TelegramIntegration } from './integrations/telegram.js'
import { BrowserIntegration } from './integrations/browser.js'
import { N8nIntegration } from './integrations/n8n.js'
import { BlogIntegration } from './integrations/blog.js'
import { TerminalAdapter } from './channels/terminal-adapter.js'

function ensureMemoryFiles(memoryDir: string, milestones: string[]): void {
  const nextRunPath = join(memoryDir, 'plans', 'next-run.md')
  mkdirSync(join(memoryDir, 'plans'), { recursive: true })
  mkdirSync(join(memoryDir, 'runs'), { recursive: true })

  for (const milestone of milestones) {
    mkdirSync(join(memoryDir, 'summaries', milestone), { recursive: true })
  }

  try {
    writeFileSync(nextRunPath, '# Next run\n\n- Bootstrap pending tasks here.\n', {
      flag: 'wx'
    })
  } catch {
    // File already exists.
  }
}

function ensureQueueDirs(queueDir: string): void {
  mkdirSync(join(queueDir, 'pending'), { recursive: true })
  mkdirSync(join(queueDir, 'processing'), { recursive: true })
  mkdirSync(join(queueDir, 'done'), { recursive: true })
  mkdirSync(join(queueDir, 'failed'), { recursive: true })
}

async function bootstrap(): Promise<void> {
  const envConfig = readEnvConfig()
  const secretStatuses = getSecretStatuses(envConfig.secretsDir)
  const appSecrets = readAppSecrets(envConfig.secretsDir)

  console.log('[boot] secrets status:')
  for (const status of secretStatuses) {
    const label = status.isPresent ? 'present' : 'missing'
    console.log(`- ${status.name}: ${label} (${status.maskedValue})`)
  }

  console.log(`[boot] ollama base url: ${envConfig.ollamaBaseUrl}`)
  console.log(`[boot] ollama model: ${envConfig.ollamaModel}`)
  console.log(`[boot] thought loop seconds: ${envConfig.thoughtLoopSeconds}`)
  console.log(`[boot] event poll seconds: ${envConfig.eventPollSeconds}`)
  console.log(`[boot] coalesce window seconds: ${envConfig.coalesceWindowSeconds}`)
  console.log(`[boot] message batch window seconds: ${envConfig.messageBatchWindowSeconds}`)
  console.log(`[boot] chat coalesce max items: ${envConfig.chatCoalesceMaxItems}`)
  console.log(`[boot] event queue strategy: ${envConfig.eventQueueStrategy}`)
  console.log(`[boot] thought loop skip when queue not empty: ${envConfig.thoughtLoopSkipWhenQueueNotEmpty}`)
  console.log(`[boot] summarization milestones: ${envConfig.summarizationMilestones.join(', ')}`)
  console.log(`[boot] summarization max input items: ${envConfig.summarizationMaxInputItems}`)

  console.log('[boot] ensuring memory directories')
  ensureMemoryFiles(envConfig.memoryDir, envConfig.summarizationMilestones)
  ensureQueueDirs(envConfig.queueDir)

  console.log('[boot] initializing LanceDB')
  await initLanceDb(envConfig.lanceDbDir)
  const db = getLanceDb()
  await ensureMemoryTable(db)
  console.log(`[boot] LanceDB is ready at ${envConfig.lanceDbDir}`)

  console.log('[boot] loading purpose file')
  mkdirSync(envConfig.purposeDir, { recursive: true })

  console.log('[boot] initializing event bus and queue')
  const eventBus = new EventBus()
  const eventQueue = new EventQueue(envConfig)

  console.log('[boot] initializing channel adapters')
  mkdirSync(envConfig.terminalChatDir, { recursive: true })
  const terminalAdapter = new TerminalAdapter(envConfig.terminalChatDir)
  console.log('[boot] terminal adapter ready — use famagent CLI to send messages')

  console.log('[boot] initializing integrations')
  const telegram = new TelegramIntegration(appSecrets, eventBus)
  const browser = new BrowserIntegration()
  const n8n = new N8nIntegration(appSecrets)
  const blog = new BlogIntegration()

  const integrations = [telegram, browser, n8n, blog]

  for (const integration of integrations) {
    try {
      await integration.start()
      console.log(`[boot] integration ${integration.name}: ${integration.status()}`)
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[boot] integration ${integration.name} failed to start: ${errMsg}`)
    }
  }

  console.log('[boot] starting orchestrator (three-loop architecture)')
  const orchestrator = new Orchestrator({
    config: envConfig,
    secrets: appSecrets,
    eventBus,
    eventQueue,
    integrations,
    channels: [terminalAdapter, telegram.adapter],
  })
  await orchestrator.start()

  startHttpServer({
    port: envConfig.agentPort,
    agentName: envConfig.agentName,
    secretStatuses,
    envConfig,
    integrations,
    eventBus,
    terminalAdapter,
  })

  const shutdown = async (): Promise<void> => {
    console.log('[boot] shutting down gracefully')
    await orchestrator.stop()
    for (const integration of integrations) {
      await integration.stop()
    }
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())

  console.log('[boot] === family agent is alive ===')
}

bootstrap().catch((error: unknown) => {
  console.error('[boot] failed to start agent')
  console.error(error)
  process.exit(1)
})
