import type { IEnvConfig } from '../config/env.js'
import { isRecord } from './type-utils.js'

export interface IChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface IOllamaResponse {
  message: { content: string }
}

function isOllamaResponse(value: unknown): value is IOllamaResponse {
  if (!isRecord(value)) {
    return false
  }
  const msg = value['message']
  if (!isRecord(msg)) {
    return false
  }
  return typeof msg['content'] === 'string'
}

export async function ollamaChat(
  config: IEnvConfig,
  model: string,
  messages: ReadonlyArray<IChatMessage>,
): Promise<string> {
  const url = `${config.ollamaBaseUrl}/api/chat`
  const body = JSON.stringify({
    model,
    messages,
    stream: false,
  })

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Ollama chat failed: ${response.status} ${text}`)
  }

  const data: unknown = await response.json()
  if (!isOllamaResponse(data)) {
    throw new Error('Ollama response does not match expected format')
  }
  return data.message.content
}

export async function ollamaHealthCheck(config: IEnvConfig): Promise<boolean> {
  try {
    const response = await fetch(`${config.ollamaBaseUrl}/api/tags`)
    return response.ok
  } catch {
    return false
  }
}
