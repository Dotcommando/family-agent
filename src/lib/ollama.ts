import type { IEnvConfig } from '../config/env.js'

export interface IChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface IOllamaResponse {
  message: { content: string }
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

  const data = (await response.json()) as IOllamaResponse
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
