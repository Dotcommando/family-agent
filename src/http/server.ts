import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { ISecretStatus } from '../config/types.js'
import type { IEnvConfig } from '../config/env.js'
import type { IIntegration } from '../integrations/types.js'
import type { EventBus } from '../queue/event-bus.js'
import type { TerminalAdapter } from '../channels/terminal-adapter.js'
import { EventSource, EventPriority } from '../queue/types.js'
import { TERMINAL_CHAT_ID } from '../channels/terminal-adapter.js'

interface IServerOptions {
  port: number
  agentName: string
  secretStatuses: ISecretStatus[]
  envConfig: IEnvConfig
  integrations: ReadonlyArray<IIntegration>
  eventBus: EventBus
  terminalAdapter: TerminalAdapter
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8'
  })
  response.end(JSON.stringify(payload, null, 2))
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

export function startHttpServer(options: IServerOptions): void {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url === '/health') {
      sendJson(response, 200, {
        ok: true,
        secrets: options.secretStatuses,
        integrations: options.integrations.map((i) => ({
          name: i.name,
          status: i.status(),
        })),
        config: {
          ollamaModel: options.envConfig.ollamaModel,
          thoughtLoopSeconds: options.envConfig.thoughtLoopSeconds,
          eventPollSeconds: options.envConfig.eventPollSeconds,
          coalesceWindowSeconds: options.envConfig.coalesceWindowSeconds,
          messageBatchWindowSeconds: options.envConfig.messageBatchWindowSeconds,
          chatCoalesceMaxItems: options.envConfig.chatCoalesceMaxItems,
          eventQueueStrategy: options.envConfig.eventQueueStrategy,
          summarizationMilestones: options.envConfig.summarizationMilestones,
          summarizationMaxInputItems: options.envConfig.summarizationMaxInputItems,
          queueDir: options.envConfig.queueDir
        },
        timestamp: new Date().toISOString()
      })
      return
    }

    if (request.url === '/terminal/send' && request.method === 'POST') {
      void (async () => {
        try {
          const body = await readBody(request)
          const parsed = JSON.parse(body) as { message?: string }
          const message = parsed.message
          if (!message) {
            sendJson(response, 400, { ok: false, error: 'missing "message" field' })
            return
          }

          options.terminalAdapter.logUserMessage(message)
          options.eventBus.emit({
            source: EventSource.Terminal,
            priority: EventPriority.User,
            chatId: TERMINAL_CHAT_ID,
            payload: message,
            batchable: true,
          })

          sendJson(response, 200, { ok: true, queued: true })
        } catch {
          sendJson(response, 400, { ok: false, error: 'invalid JSON body' })
        }
      })()
      return
    }

    if (request.url?.startsWith('/terminal/history')) {
      const url = new URL(request.url, `http://localhost:${options.port}`)
      const count = Number(url.searchParams.get('n') ?? '20')
      const entries = options.terminalAdapter.readHistory(Number.isFinite(count) ? count : 20)
      sendJson(response, 200, { ok: true, entries })
      return
    }

    sendJson(response, 200, {
      ok: true,
      service: options.agentName,
      message: 'Agent is running'
    })
  })

  server.listen(options.port, () => {
    console.log(`[http] listening on port ${options.port}`)
  })
}
