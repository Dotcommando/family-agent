import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readEnvConfig } from './config/env.js'
import { getSecretStatuses, readAppSecrets } from './config/secrets.js'
import { initLanceDb } from './lib/lancedb.js'
import { startHttpServer } from './http/server.js'

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

  console.log(`[boot] telegram_api_id numeric check: ${/^\d+$/.test(appSecrets.telegramApiId)}`)
  console.log(`[boot] ollama base url: ${envConfig.ollamaBaseUrl}`)
  console.log(`[boot] thought loop seconds: ${envConfig.thoughtLoopSeconds}`)
  console.log(`[boot] event poll seconds: ${envConfig.eventPollSeconds}`)
  console.log(`[boot] coalesce window seconds: ${envConfig.coalesceWindowSeconds}`)
  console.log(`[boot] summarization milestones: ${envConfig.summarizationMilestones.join(', ')}`)
  console.log(`[boot] summarization max input items: ${envConfig.summarizationMaxInputItems}`)

  ensureMemoryFiles(envConfig.memoryDir, envConfig.summarizationMilestones)
  ensureQueueDirs(envConfig.queueDir)
  await initLanceDb(envConfig.lanceDbDir)
  console.log(`[boot] LanceDB is ready at ${envConfig.lanceDbDir}`)

  startHttpServer({
    port: envConfig.agentPort,
    agentName: envConfig.agentName,
    secretStatuses,
    envConfig
  })
}

bootstrap().catch((error: unknown) => {
  console.error('[boot] failed to start agent')
  console.error(error)
  process.exit(1)
})
