import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { ISecretStatus } from '../config/types.js'
import type { IEnvConfig } from '../config/env.js'
import type { IIntegration } from '../integrations/types.js'

interface IServerOptions {
  port: number
  agentName: string
  secretStatuses: ISecretStatus[]
  envConfig: IEnvConfig
  integrations: ReadonlyArray<IIntegration>
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8'
  })
  response.end(JSON.stringify(payload, null, 2))
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
