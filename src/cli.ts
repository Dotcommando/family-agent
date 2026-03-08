#!/usr/bin/env node

const AGENT_URL = process.env.AGENT_URL ?? 'http://localhost:3000'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface IHistoryEntry {
  role: string
  channel: string
  text: string
  timestamp: string
}

function isHistoryEntry(value: unknown): value is IHistoryEntry {
  if (!isRecord(value)) {
    return false
  }
  return (
    typeof value['role'] === 'string' &&
    typeof value['text'] === 'string' &&
    typeof value['timestamp'] === 'string'
  )
}

interface IHistoryResponse {
  ok: boolean
  entries: IHistoryEntry[]
}

function isHistoryResponse(value: unknown): value is IHistoryResponse {
  if (!isRecord(value)) {
    return false
  }
  return typeof value['ok'] === 'boolean' && Array.isArray(value['entries'])
}

interface ISendResponse {
  ok: boolean
  queued?: boolean
  error?: string
}

function isSendResponse(value: unknown): value is ISendResponse {
  if (!isRecord(value)) {
    return false
  }
  return typeof value['ok'] === 'boolean'
}

interface IHealthIntegration {
  name: string
  status: string
}

function isHealthIntegration(value: unknown): value is IHealthIntegration {
  if (!isRecord(value)) {
    return false
  }
  return typeof value['name'] === 'string' && typeof value['status'] === 'string'
}

interface IHealthResponse {
  ok: boolean
  integrations?: IHealthIntegration[]
  config?: Record<string, string | number | boolean>
  timestamp?: string
}

function isHealthResponse(value: unknown): value is IHealthResponse {
  if (!isRecord(value)) {
    return false
  }
  return typeof value['ok'] === 'boolean'
}

function usage(): void {
  console.log(`
famagent — CLI для общения с family-agent

Команды:
  famagent -m "текст"         Отправить сообщение агенту
  famagent --history [N]      Показать последние N сообщений (по умолчанию 20)
  famagent --status           Показать статус агента
  famagent --help             Показать справку
`)
}

async function sendMessage(text: string): Promise<void> {
  try {
    const res = await fetch(`${AGENT_URL}/terminal/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    })

    const raw: unknown = await res.json()
    if (!isSendResponse(raw)) {
      console.error('✗ Неожиданный ответ от агента')
      return
    }

    if (raw.ok) {
      console.log(`✓ Сообщение поставлено в очередь`)
      console.log(`  Агент обработает его в следующем цикле.`)
      console.log(`  Чтобы увидеть ответ: famagent --history 5`)
    } else {
      console.error(`✗ Ошибка: ${raw.error ?? 'unknown'}`)
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error(`✗ Не удалось подключиться к агенту (${AGENT_URL}): ${errMsg}`)
    console.error(`  Убедитесь, что агент запущен: docker compose up -d`)
  }
}

async function showHistory(count: number): Promise<void> {
  try {
    const res = await fetch(`${AGENT_URL}/terminal/history?n=${count}`)
    const raw: unknown = await res.json()

    if (!isHistoryResponse(raw)) {
      console.log('(неожиданный формат ответа)')
      return
    }

    const entries = raw.entries.filter(isHistoryEntry)
    if (!raw.ok || entries.length === 0) {
      console.log('(пусто — пока нет сообщений)')
      return
    }

    for (const entry of entries) {
      const time = new Date(entry.timestamp).toLocaleString()
      const prefix = entry.role === 'user' ? '👤 Вы' : '🤖 Агент'
      console.log(`[${time}] ${prefix}:`)
      console.log(`  ${entry.text}`)
      console.log()
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error(`✗ Не удалось подключиться к агенту (${AGENT_URL}): ${errMsg}`)
  }
}

async function showStatus(): Promise<void> {
  try {
    const res = await fetch(`${AGENT_URL}/health`)
    const raw: unknown = await res.json()

    if (!isHealthResponse(raw)) {
      console.log('(неожиданный формат ответа)')
      return
    }

    console.log(`Статус: ${raw.ok ? 'работает' : 'проблема'}`)
    console.log(`Время:  ${raw.timestamp ?? 'unknown'}`)

    if (Array.isArray(raw.integrations)) {
      console.log('\nИнтеграции:')
      for (const item of raw.integrations) {
        if (isHealthIntegration(item)) {
          console.log(`  ${item.name}: ${item.status}`)
        }
      }
    }

    if (isRecord(raw.config)) {
      console.log('\nКонфигурация:')
      for (const [key, value] of Object.entries(raw.config)) {
        console.log(`  ${key}: ${String(value)}`)
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error(`✗ Агент недоступен (${AGENT_URL}): ${errMsg}`)
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes('--help')) {
    usage()
    return
  }

  const mIndex = args.indexOf('-m')
  if (mIndex !== -1) {
    const message = args[mIndex + 1]
    if (!message) {
      console.error('✗ Укажите текст сообщения: famagent -m "ваш текст"')
      process.exit(1)
    }
    await sendMessage(message)
    return
  }

  const historyIndex = args.indexOf('--history')
  if (historyIndex !== -1) {
    const countArg = args[historyIndex + 1]
    const count = countArg ? Number(countArg) : 20
    await showHistory(Number.isFinite(count) ? count : 20)
    return
  }

  if (args.includes('--status')) {
    await showStatus()
    return
  }

  usage()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
