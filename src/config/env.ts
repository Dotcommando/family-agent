interface IEnvConfig {
  agentName: string
  agentPort: number
  ollamaBaseUrl: string
  lanceDbDir: string
  memoryDir: string
  secretsDir: string
  queueDir: string
  eventPollSeconds: number
  idleBackoffSeconds: number
  thoughtLoopSeconds: number
  maxConcurrentJobs: number
  proactiveMode: boolean
  coalesceWindowSeconds: number
  messageBatchWindowSeconds: number
  chatCoalesceMaxItems: number
  eventQueueStrategy: string
  thoughtLoopSkipWhenQueueNotEmpty: boolean
  dedupThoughtLoop: boolean
  dedupSummaryJobs: boolean
  summarizationMilestones: string[]
  summarizationMaxInputItems: number
  summaryRunOnlyWhenIdle: boolean
  summaryMinIdleSeconds: number
  summaryMaxConcurrent: number
  summaryRawRetentionDays: number
  purposeDir: string
}

function readNumberEnv(name: string, fallback: number): number {
  const rawValue = process.env[name]
  if (!rawValue) {
    return fallback
  }

  const parsedValue = Number(rawValue)
  return Number.isFinite(parsedValue) ? parsedValue : fallback
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const rawValue = process.env[name]?.trim().toLowerCase()
  if (!rawValue) {
    return fallback
  }

  if (rawValue === 'true') {
    return true
  }

  if (rawValue === 'false') {
    return false
  }

  return fallback
}

function readListEnv(name: string, fallback: string[]): string[] {
  const rawValue = process.env[name]
  if (!rawValue) {
    return fallback
  }

  const values = rawValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  return values.length > 0 ? values : fallback
}

export function readEnvConfig(): IEnvConfig {
  return {
    agentName: process.env.AGENT_NAME ?? 'family-agent',
    agentPort: readNumberEnv('AGENT_PORT', 3000),
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? 'http://ollama:11434',
    lanceDbDir: process.env.LANCEDB_DIR ?? '/app/data/lancedb',
    memoryDir: process.env.MEMORY_DIR ?? '/app/memory',
    secretsDir: process.env.SECRETS_DIR ?? '/run/secrets',
    queueDir: process.env.AGENT_QUEUE_DIR ?? '/app/state/queue',
    eventPollSeconds: readNumberEnv('AGENT_EVENT_POLL_SECONDS', 10),
    idleBackoffSeconds: readNumberEnv('AGENT_IDLE_BACKOFF_SECONDS', 30),
    thoughtLoopSeconds: readNumberEnv('AGENT_THOUGHT_LOOP_SECONDS', 240),
    maxConcurrentJobs: readNumberEnv('AGENT_MAX_CONCURRENT_JOBS', 1),
    proactiveMode: readBooleanEnv('AGENT_PROACTIVE_MODE', true),
    coalesceWindowSeconds: readNumberEnv('AGENT_COALESCE_WINDOW_SECONDS', 45),
    messageBatchWindowSeconds: readNumberEnv('AGENT_MESSAGE_BATCH_WINDOW_SECONDS', 30),
    chatCoalesceMaxItems: readNumberEnv('AGENT_CHAT_COALESCE_MAX_ITEMS', 20),
    eventQueueStrategy: process.env.AGENT_EVENT_QUEUE_STRATEGY ?? 'priority-fifo',
    thoughtLoopSkipWhenQueueNotEmpty: readBooleanEnv('AGENT_THOUGHT_LOOP_SKIP_WHEN_QUEUE_NOT_EMPTY', true),
    dedupThoughtLoop: readBooleanEnv('AGENT_DEDUP_THOUGHT_LOOP', true),
    dedupSummaryJobs: readBooleanEnv('AGENT_DEDUP_SUMMARY_JOBS', true),
    summarizationMilestones: readListEnv('AGENT_SUMMARIZATION_MILESTONES', ['1h', '3h', '6h', '24h', '7d', '30d', '90d', '180d', '365d']),
    summarizationMaxInputItems: readNumberEnv('AGENT_SUMMARIZATION_MAX_INPUT_ITEMS', 200),
    summaryRunOnlyWhenIdle: readBooleanEnv('AGENT_SUMMARY_RUN_ONLY_WHEN_IDLE', true),
    summaryMinIdleSeconds: readNumberEnv('AGENT_SUMMARY_MIN_IDLE_SECONDS', 60),
    summaryMaxConcurrent: readNumberEnv('AGENT_SUMMARY_MAX_CONCURRENT', 1),
    summaryRawRetentionDays: readNumberEnv('AGENT_SUMMARY_RAW_RETENTION_DAYS', 14),
    purposeDir: process.env.PURPOSE_DIR ?? '/app/state/purpose'
  }
}

export type { IEnvConfig }
