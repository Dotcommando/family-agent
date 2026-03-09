import { writeFileSync, readFileSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { EventPriority, JobStatus } from './types.js'
import type { IAgentEvent, ICoalescedBatch, IJob } from './types.js'
import type { IEnvConfig } from '../config/env.js'
import { isRecord } from '../lib/type-utils.js'

function isAgentEvent(value: unknown): value is IAgentEvent {
  if (!isRecord(value)) {
    return false
  }
  return (
    typeof value['id'] === 'string' &&
    typeof value['source'] === 'string' &&
    typeof value['priority'] === 'number' &&
    typeof value['payload'] === 'string' &&
    typeof value['createdAt'] === 'string' &&
    typeof value['batchable'] === 'boolean' &&
    typeof value['requiresResponse'] === 'boolean'
  )
}

function parseAgentEvent(raw: string): IAgentEvent | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  return isAgentEvent(parsed) ? parsed : undefined
}

export class EventQueue {
  private readonly pendingDir: string
  private readonly processingDir: string
  private readonly doneDir: string
  private readonly failedDir: string
  private readonly config: IEnvConfig

  constructor(config: IEnvConfig) {
    this.config = config
    this.pendingDir = join(config.queueDir, 'pending')
    this.processingDir = join(config.queueDir, 'processing')
    this.doneDir = join(config.queueDir, 'done')
    this.failedDir = join(config.queueDir, 'failed')

    for (const dir of [this.pendingDir, this.processingDir, this.doneDir, this.failedDir]) {
      mkdirSync(dir, { recursive: true })
    }
  }

  enqueue(event: IAgentEvent): void {
    const fileName = `${event.createdAt.replace(/[:.]/g, '-')}_${event.priority}_${event.id}.json`
    writeFileSync(join(this.pendingDir, fileName), JSON.stringify(event, null, 2))
    console.log(`[queue] enqueued event ${event.id} source=${event.source} priority=${event.priority} chat=${event.chatId ?? 'none'}`)
  }

  pendingCount(): number {
    return readdirSync(this.pendingDir).filter((f) => f.endsWith('.json')).length
  }

  hasUserEvents(): boolean {
    const files = readdirSync(this.pendingDir).filter((f) => f.endsWith('.json'))
    for (const file of files) {
      const raw = readFileSync(join(this.pendingDir, file), 'utf8')
      const event = parseAgentEvent(raw)
      if (event && event.priority === EventPriority.User) {
        return true
      }
    }
    return false
  }

  hasInteractiveEvents(): boolean {
    const files = readdirSync(this.pendingDir).filter((f) => f.endsWith('.json'))
    for (const file of files) {
      const raw = readFileSync(join(this.pendingDir, file), 'utf8')
      const event = parseAgentEvent(raw)
      if (event && event.priority === EventPriority.User && event.requiresResponse) {
        return true
      }
    }
    return false
  }

  drainPending(): IAgentEvent[] {
    const files = readdirSync(this.pendingDir)
      .filter((f) => f.endsWith('.json'))
      .sort()

    const events: IAgentEvent[] = []
    for (const file of files) {
      const filePath = join(this.pendingDir, file)
      const raw = readFileSync(filePath, 'utf8')
      const event = parseAgentEvent(raw)
      if (event) {
        events.push(event)
      }
      unlinkSync(filePath)
    }

    return events
  }

  coalesceByChat(events: ReadonlyArray<IAgentEvent>): ICoalescedBatch[] {
    const chatMap = new Map<string, IAgentEvent[]>()
    const noChatEvents: IAgentEvent[] = []

    for (const event of events) {
      if (event.chatId && event.batchable) {
        const existing = chatMap.get(event.chatId) ?? []
        existing.push(event)
        chatMap.set(event.chatId, existing)
      } else {
        noChatEvents.push(event)
      }
    }

    const batches: ICoalescedBatch[] = []

    for (const [chatId, chatEvents] of chatMap) {
      const limited = chatEvents.slice(-this.config.chatCoalesceMaxItems)
      const firstCreatedAt = limited[0]?.createdAt ?? ''
      const lastEvent = limited[limited.length - 1]
      const lastCreatedAt = lastEvent?.createdAt ?? ''
      const lastPayload = lastEvent?.payload ?? ''

      batches.push({
        chatId,
        events: limited,
        firstAt: firstCreatedAt,
        lastAt: lastCreatedAt,
        latestPayload: lastPayload,
        messageCount: limited.length,
        requiresResponse: limited.some((e) => e.requiresResponse),
      })
    }

    for (const event of noChatEvents) {
      batches.push({
        chatId: event.id,
        events: [event],
        firstAt: event.createdAt,
        lastAt: event.createdAt,
        latestPayload: event.payload,
        messageCount: 1,
        requiresResponse: event.requiresResponse,
      })
    }

    return batches.sort((a, b) => {
      const priorityA = Math.min(...a.events.map((e) => e.priority))
      const priorityB = Math.min(...b.events.map((e) => e.priority))
      return priorityA !== priorityB
        ? priorityA - priorityB
        : a.firstAt.localeCompare(b.firstAt)
    })
  }

  private jobDir(status: JobStatus): string {
    switch (status) {
      case JobStatus.Pending: return this.pendingDir
      case JobStatus.Processing: return this.processingDir
      case JobStatus.Done: return this.doneDir
      case JobStatus.Failed: return this.failedDir
    }
  }

  persistJob(job: IJob): void {
    const dir = this.jobDir(job.status)
    const fileName = `job_${job.id}.json`
    writeFileSync(join(dir, fileName), JSON.stringify(job, null, 2))
  }

  moveJob(job: IJob, from: JobStatus, to: JobStatus): void {
    const fileName = `job_${job.id}.json`
    const oldPath = join(this.jobDir(from), fileName)
    const newPath = join(this.jobDir(to), fileName)
    job.status = to
    try {
      unlinkSync(oldPath)
    } catch {
      // file might already be removed
    }
    writeFileSync(newPath, JSON.stringify(job, null, 2))
  }
}
