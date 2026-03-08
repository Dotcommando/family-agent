import { randomUUID } from 'node:crypto'
import type { IRuntimeContext } from './types.js'
import { loadMemoryContext } from '../memory/memory-loader.js'
import { runReasoning, runThoughtLoop, runSummarization } from './reasoning.js'
import { parseMilestones, findSummarizationCandidates, readRunContents, writeSummary, cleanupOldRuns } from '../memory/summarization.js'
import { EventPriority, EventSource, JobStatus } from '../queue/types.js'
import type { IJob } from '../queue/types.js'

export class Orchestrator {
  private readonly ctx: IRuntimeContext
  private running = false
  private currentJobId: string | undefined
  private eventPollTimer: ReturnType<typeof setInterval> | undefined
  private thoughtLoopTimer: ReturnType<typeof setInterval> | undefined
  private lastThoughtLoopId: string | undefined
  private lastSummaryId: string | undefined
  private lastJobFinishedAt = 0

  constructor(ctx: IRuntimeContext) {
    this.ctx = ctx
  }

  async start(): Promise<void> {
    this.running = true
    console.log('[orchestrator] starting three-loop architecture')

    this.ctx.eventBus.on((event) => {
      this.ctx.eventQueue.enqueue(event)
    })

    this.startEventPollLoop()
    this.startThoughtLoop()

    console.log('[orchestrator] all loops active')
  }

  async stop(): Promise<void> {
    this.running = false

    if (this.eventPollTimer) {
      clearInterval(this.eventPollTimer)
      this.eventPollTimer = undefined
    }

    if (this.thoughtLoopTimer) {
      clearInterval(this.thoughtLoopTimer)
      this.thoughtLoopTimer = undefined
    }

    console.log('[orchestrator] stopped')
  }

  // --- Loop 1: Event poll ---

  private startEventPollLoop(): void {
    const pollMs = this.ctx.config.eventPollSeconds * 1000
    console.log(`[loop-1:events] polling every ${this.ctx.config.eventPollSeconds}s`)

    this.eventPollTimer = setInterval(() => {
      void this.tickEventPoll()
    }, pollMs)
  }

  private async tickEventPoll(): Promise<void> {
    if (!this.running) {
      return
    }

    if (this.currentJobId) {
      return
    }

    const pendingCount = this.ctx.eventQueue.pendingCount()
    if (pendingCount === 0) {
      return
    }

    const coalesceMs = this.ctx.config.coalesceWindowSeconds * 1000
    const batchMs = this.ctx.config.messageBatchWindowSeconds * 1000
    const windowMs = Math.max(coalesceMs, batchMs)

    await this.sleep(windowMs)

    if (this.currentJobId) {
      return
    }

    const events = this.ctx.eventQueue.drainPending()
    if (events.length === 0) {
      return
    }

    console.log(`[loop-2:executor] drained ${events.length} events from queue`)

    const batches = this.ctx.eventQueue.coalesceByChat(events)
    console.log(`[loop-2:executor] coalesced into ${batches.length} batch(es)`)

    for (const batch of batches) {
      if (!this.running) {
        break
      }

      const job: IJob = {
        id: randomUUID().slice(0, 8),
        status: JobStatus.Processing,
        priority: Math.min(...batch.events.map((e) => e.priority)),
        source: batch.events[0]?.source ?? EventSource.Internal,
        events: batch.events,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        finishedAt: undefined,
        result: undefined,
      }

      this.currentJobId = job.id
      console.log(`[loop-2:executor] === job ${job.id} started (${batch.events.length} events, chat=${batch.chatId}) ===`)

      this.ctx.eventQueue.persistJob(job)

      try {
        const memory = loadMemoryContext(this.ctx.config)
        const result = await runReasoning(this.ctx.config, memory, batch)
        job.result = result.slice(0, 2000)
        job.finishedAt = new Date().toISOString()
        job.status = JobStatus.Done
        this.ctx.eventQueue.moveJob(job, JobStatus.Processing, JobStatus.Done)
        console.log(`[loop-2:executor] === job ${job.id} done ===`)
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`[loop-2:executor] job ${job.id} failed: ${errMsg}`)
        job.result = errMsg
        job.finishedAt = new Date().toISOString()
        job.status = JobStatus.Failed
        this.ctx.eventQueue.moveJob(job, JobStatus.Processing, JobStatus.Failed)
      }

      this.currentJobId = undefined
      this.lastJobFinishedAt = Date.now()
    }
  }

  // --- Loop 3: Thought loop + summarization ---

  private startThoughtLoop(): void {
    const intervalMs = this.ctx.config.thoughtLoopSeconds * 1000
    console.log(`[loop-3:reflection] thought loop every ${this.ctx.config.thoughtLoopSeconds}s`)

    this.thoughtLoopTimer = setInterval(() => {
      void this.tickThoughtLoop()
    }, intervalMs)
  }

  private async tickThoughtLoop(): Promise<void> {
    if (!this.running) {
      return
    }

    if (this.ctx.config.thoughtLoopSkipWhenQueueNotEmpty && this.ctx.eventQueue.hasUserEvents()) {
      console.log('[loop-3:reflection] skipping — user events in queue')
      return
    }

    if (this.currentJobId) {
      console.log('[loop-3:reflection] skipping — job in progress')
      return
    }

    if (this.ctx.config.dedupThoughtLoop && this.lastThoughtLoopId) {
      const timeSinceLastJob = Date.now() - this.lastJobFinishedAt
      if (timeSinceLastJob < this.ctx.config.thoughtLoopSeconds * 1000 && this.lastJobFinishedAt > 0) {
        console.log('[loop-3:reflection] dedup — recent job finished, skipping redundant reflection')
        this.lastThoughtLoopId = undefined
        return
      }
    }

    const thoughtId = randomUUID().slice(0, 8)
    this.lastThoughtLoopId = thoughtId
    console.log(`[loop-3:reflection] === thought loop ${thoughtId} ===`)

    if (this.ctx.config.proactiveMode) {
      try {
        const memory = loadMemoryContext(this.ctx.config)
        await runThoughtLoop(this.ctx.config, memory)
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`[loop-3:reflection] thought loop error: ${errMsg}`)
      }
    } else {
      console.log('[loop-3:reflection] proactive mode disabled, skipping LLM reflection')
    }

    await this.tickSummarization()
  }

  private async tickSummarization(): Promise<void> {
    const idleSeconds = (Date.now() - this.lastJobFinishedAt) / 1000
    if (this.ctx.config.summaryRunOnlyWhenIdle && idleSeconds < this.ctx.config.summaryMinIdleSeconds && this.lastJobFinishedAt > 0) {
      console.log(`[summarization] skipping — not idle long enough (${Math.round(idleSeconds)}s < ${this.ctx.config.summaryMinIdleSeconds}s)`)
      return
    }

    const milestones = parseMilestones(this.ctx.config.summarizationMilestones)
    const candidates = findSummarizationCandidates(this.ctx.config, milestones)

    if (candidates.length === 0) {
      console.log('[summarization] no candidates for summarization')
      return
    }

    if (this.ctx.config.dedupSummaryJobs && this.lastSummaryId) {
      console.log('[summarization] dedup — skipping redundant summary run')
      this.lastSummaryId = undefined
      return
    }

    const summaryId = randomUUID().slice(0, 8)
    this.lastSummaryId = summaryId

    for (const candidate of candidates.slice(0, this.ctx.config.summaryMaxConcurrent)) {
      console.log(`[summarization] processing ${candidate.milestone.label} with ${candidate.inputFiles.length} input files`)
      const rawContent = readRunContents(this.ctx.config, candidate.inputFiles)
      const summary = await runSummarization(this.ctx.config, candidate.milestone.label, rawContent)
      if (summary) {
        writeSummary(this.ctx.config, candidate.milestone.label, summary)
      }
    }

    cleanupOldRuns(this.ctx.config)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
