#!/usr/bin/env node

const AGENT_URL = process.env.AGENT_URL ?? 'http://localhost:3000'

interface IHistoryEntry {
  role: string
  channel: string
  text: string
  timestamp: string
}

interface IHistoryResponse {
  ok: boolean
  entries: IHistoryEntry[]
}

interface ISendResponse {
  ok: boolean
  queued?: boolean
  error?: string
}

interface IHealthResponse {
  ok: boolean
  integrations?: Array<{ name: string; status: string }>
  config?: Record<string, unknown>
  timestamp?: string
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

    const data = (await res.json()) as ISendResponse
    if (data.ok) {
      console.log(`✓ Сообщение поставлено в очередь`)
      console.log(`  Агент обработает его в следующем цикле.`)
      console.log(`  Чтобы увидеть ответ: famagent --history 5`)
    } else {
      console.error(`✗ Ошибка: ${data.error ?? 'unknown'}`)
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
    const data = (await res.json()) as IHistoryResponse

    if (!data.ok || data.entries.length === 0) {
      console.log('(пусто — пока нет сообщений)')
      return
    }

    for (const entry of data.entries) {
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
    const data = (await res.json()) as IHealthResponse

    console.log(`Статус: ${data.ok ? 'работает' : 'проблема'}`)
    console.log(`Время:  ${data.timestamp ?? 'unknown'}`)

    if (data.integrations) {
      console.log('\nИнтеграции:')
      for (const integration of data.integrations) {
        console.log(`  ${integration.name}: ${integration.status}`)
      }
    }

    if (data.config) {
      console.log('\nКонфигурация:')
      for (const [key, value] of Object.entries(data.config)) {
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
