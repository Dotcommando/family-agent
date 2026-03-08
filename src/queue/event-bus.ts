import { randomUUID } from 'node:crypto'
import { EventPriority, EventSource } from './types.js'
import type { IAgentEvent } from './types.js'

type EventHandler = (event: IAgentEvent) => void

export class EventBus {
  private readonly handlers: EventHandler[] = []

  on(handler: EventHandler): void {
    this.handlers.push(handler)
  }

  emit(partial: {
    source: EventSource
    priority?: EventPriority
    chatId?: string
    payload: string
    batchable?: boolean
    requiresResponse?: boolean
  }): IAgentEvent {
    const event: IAgentEvent = {
      id: randomUUID(),
      source: partial.source,
      priority: partial.priority ?? EventPriority.User,
      chatId: partial.chatId,
      payload: partial.payload,
      createdAt: new Date().toISOString(),
      batchable: partial.batchable ?? true,
      requiresResponse: partial.requiresResponse ?? true,
    }

    for (const handler of this.handlers) {
      handler(event)
    }

    return event
  }
}
