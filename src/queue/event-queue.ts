import { writeFileSync, readFileSync, readdirSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { EventPriority, JobStatus } from './types.js'
import type { IAgentEvent, ICoalescedBatch, IJob } from './types.js'
import type { IEnvConfig } from '../config/env.js'

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
      const event = JSON.parse(raw) as IAgentEvent
      if (event.priority === EventPriority.User) {
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
      events.push(JSON.parse(raw) as IAgentEvent)
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
      batches.push({
        chatId,
        events: limited,
        firstAt: limited[0]?.createdAt ?? '',
        lastAt: limited[limited.length - 1]?.createdAt ?? '',
      })
    }

    for (const event of noChatEvents) {
      batches.push({
        chatId: event.id,
        events: [event],
        firstAt: event.createdAt,
        lastAt: event.createdAt,
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

  persistJob(job: IJob): void {
    const dirMap: Record<JobStatus, string> = {
      [JobStatus.Pending]: this.pendingDir,
      [JobStatus.Processing]: this.processingDir,
      [JobStatus.Done]: this.doneDir,
      [JobStatus.Failed]: this.failedDir,
    }
    const dir = dirMap[job.status]
    const fileName = `job_${job.id}.json`
    writeFileSync(join(dir, fileName), JSON.stringify(job, null, 2))
  }

  moveJob(job: IJob, from: JobStatus, to: JobStatus): void {
    const dirMap: Record<JobStatus, string> = {
      [JobStatus.Pending]: this.pendingDir,
      [JobStatus.Processing]: this.processingDir,
      [JobStatus.Done]: this.doneDir,
      [JobStatus.Failed]: this.failedDir,
    }
    const fileName = `job_${job.id}.json`
    const oldPath = join(dirMap[from], fileName)
    const newPath = join(dirMap[to], fileName)
    job.status = to
    try {
      unlinkSync(oldPath)
    } catch {
      // file might already be removed
    }
    writeFileSync(newPath, JSON.stringify(job, null, 2))
  }
}
