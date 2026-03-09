import { randomUUID } from 'node:crypto'
import type { IRuntimeContext } from './types.js'
import { loadMemoryContext } from '../memory/memory-loader.js'
import { runReasoning, runThoughtLoop, runSummarization } from './reasoning.js'
import type { IReasoningResult } from './reasoning.js'
import { parseMilestones, findNextSummaryTask, readInputContents, writeSummary, cleanupOldRuns } from '../memory/summarization.js'
import { ChannelKind } from '../channels/types.js'
import { EventPriority, EventSource, JobStatus } from '../queue/types.js'
import type { IAgentEvent, ICoalescedBatch, IJob } from '../queue/types.js'
import type { IMilestoneSpec } from '../memory/types.js'
import { BrowserIntegration } from '../integrations/browser.js'

const SOURCE_TO_CHANNEL_KIND: ReadonlyMap<EventSource, ChannelKind> = new Map([
  [EventSource.Telegram, ChannelKind.Telegram],
  [EventSource.TelegramChannel, ChannelKind.Telegram],
  [EventSource.Terminal, ChannelKind.Terminal],
])

const INTERACTIVE_FAST_PATH_WINDOW_MS = 500
const THOUGHT_LOOP_INITIAL_DELAY_MS = 0

export class Orchestrator {
  private readonly ctx: IRuntimeContext
  private running = false
  private currentJobId: string | undefined
  private eventPollTimer: ReturnType<typeof setInterval> | undefined
  private thoughtLoopTimer: ReturnType<typeof setInterval> | undefined
  private summaryTimer: ReturnType<typeof setInterval> | undefined
  private initialThoughtLoopTimer: ReturnType<typeof setTimeout> | undefined
  private lastThoughtLoopId: string | undefined
  private lastJobFinishedAt = 0
  private summaryRunning = false
  private milestones: ReadonlyArray<IMilestoneSpec> = []
  private pollRunning = false
  private immediatePollTimer: ReturnType<typeof setTimeout> | undefined
  private coalesceCancelFn: (() => void) | undefined
  private inInteractiveFastPath = false

  constructor(ctx: IRuntimeContext) {
    this.ctx = ctx
  }

  async start(): Promise<void> {
    this.running = true
    console.log('[orchestrator] starting three-loop architecture')

    this.milestones = parseMilestones(this.ctx.config.summarizationMilestones)

    this.ctx.eventBus.on((event) => {
      this.ctx.eventQueue.enqueue(event)
      this.onEventEnqueued(event)
    })

    this.startEventPollLoop()
    this.startThoughtLoop()
    this.startSummaryScheduler()

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

    if (this.summaryTimer) {
      clearInterval(this.summaryTimer)
      this.summaryTimer = undefined
    }

    if (this.initialThoughtLoopTimer) {
      clearTimeout(this.initialThoughtLoopTimer)
      this.initialThoughtLoopTimer = undefined
    }

    if (this.immediatePollTimer) {
      clearTimeout(this.immediatePollTimer)
      this.immediatePollTimer = undefined
    }

    if (this.coalesceCancelFn) {
      this.coalesceCancelFn()
      this.coalesceCancelFn = undefined
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

  private isInteractiveEvent(event: IAgentEvent): boolean {
    return event.priority === EventPriority.User && event.requiresResponse
  }

  private onEventEnqueued(event: IAgentEvent): void {
    if (!this.isInteractiveEvent(event)) {
      return
    }

    if (this.pollRunning) {
      if (this.coalesceCancelFn && !this.inInteractiveFastPath) {
        console.log(`[loop-1:events] interactive event from ${event.source} — cutting coalescing window short`)
        this.coalesceCancelFn()
      }
      return
    }

    if (this.currentJobId || this.summaryRunning) {
      return
    }

    if (this.immediatePollTimer) {
      return
    }

    console.log(`[loop-1:events] interactive event from ${event.source} — scheduling immediate poll`)
    this.immediatePollTimer = setTimeout(() => {
      this.immediatePollTimer = undefined
      void this.tickEventPoll()
    }, 0)
  }

  private async tickEventPoll(): Promise<void> {
    if (!this.running) {
      return
    }

    if (this.pollRunning) {
      return
    }

    if (this.currentJobId || this.summaryRunning) {
      return
    }

    const pendingCount = this.ctx.eventQueue.pendingCount()
    if (pendingCount === 0) {
      return
    }

    this.pollRunning = true
    try {
      await this.executeEventPoll()
    } finally {
      this.pollRunning = false
      this.scheduleImmediatePollIfNeeded()
    }
  }

  private async executeEventPoll(): Promise<void> {
    const hasInteractive = this.ctx.eventQueue.hasInteractiveEvents()

    if (hasInteractive) {
      console.log(`[loop-1:events] interactive fast path — coalescing window ${INTERACTIVE_FAST_PATH_WINDOW_MS}ms`)
      this.inInteractiveFastPath = true
      await this.cancellableSleep(INTERACTIVE_FAST_PATH_WINDOW_MS)
      this.inInteractiveFastPath = false
    } else {
      const coalesceMs = this.ctx.config.coalesceWindowSeconds * 1000
      const batchMs = this.ctx.config.messageBatchWindowSeconds * 1000
      const windowMs = Math.max(coalesceMs, batchMs)
      console.log(`[loop-1:events] standard coalescing path — window ${windowMs}ms`)
      await this.cancellableSleep(windowMs)

      if (!this.running) {
        return
      }

      if (this.ctx.eventQueue.hasInteractiveEvents()) {
        console.log(`[loop-1:events] interactive event arrived during standard window — applying fast path coalescing ${INTERACTIVE_FAST_PATH_WINDOW_MS}ms`)
        this.inInteractiveFastPath = true
        await this.cancellableSleep(INTERACTIVE_FAST_PATH_WINDOW_MS)
        this.inInteractiveFastPath = false
      }
    }

    if (!this.running) {
      return
    }

    if (this.currentJobId || this.summaryRunning) {
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

      const batchPriority = Math.min(...batch.events.map((e) => e.priority))
      const batchSource = batch.events[0]?.source ?? EventSource.Internal

      const job: IJob = {
        id: randomUUID().slice(0, 8),
        status: JobStatus.Processing,
        priority: batchPriority,
        source: batchSource,
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
        const reasoningResult: IReasoningResult = await runReasoning(this.ctx.config, memory, batch, this.getBrowser())
        job.result = reasoningResult.response.slice(0, 2000)
        job.finishedAt = new Date().toISOString()
        job.status = JobStatus.Done
        this.ctx.eventQueue.moveJob(job, JobStatus.Processing, JobStatus.Done)
        console.log(`[loop-2:executor] === job ${job.id} done ===`)

        if (batch.requiresResponse && !reasoningResult.suppressReply) {
          await this.dispatchResponse(batch, reasoningResult.response)
        } else if (reasoningResult.suppressReply) {
          console.log(`[loop-2:executor] job ${job.id} — suppressReply=true, skipping response dispatch`)
        } else {
          console.log(`[loop-2:executor] job ${job.id} — observation event, skipping response dispatch`)
        }
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

    if (this.ctx.eventQueue.hasInteractiveEvents()) {
      console.log('[loop-2:executor] interactive events pending after drain pass — deferring summary')
      this.scheduleImmediatePollIfNeeded()
    } else {
      await this.runSummaryIfIdle()
    }
  }

  private async dispatchResponse(batch: ICoalescedBatch, response: string): Promise<void> {
    const source = batch.events[0]?.source
    if (!source) {
      return
    }

    const channelKind = SOURCE_TO_CHANNEL_KIND.get(source)
    if (!channelKind) {
      return
    }

    const adapter = this.ctx.channels.find((ch) => ch.kind === channelKind)
    if (!adapter) {
      console.log(`[orchestrator] no channel adapter for ${channelKind}, response not delivered`)
      return
    }

    try {
      await adapter.sendResponse(batch.chatId, response)
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[orchestrator] failed to send response via ${channelKind}: ${errMsg}`)
    }
  }

  // --- Loop 3: Thought loop (reflection only, no summarization) ---

  private startThoughtLoop(): void {
    const intervalMs = this.ctx.config.thoughtLoopSeconds * 1000
    console.log(`[loop-3:reflection] thought loop every ${this.ctx.config.thoughtLoopSeconds}s`)

    this.thoughtLoopTimer = setInterval(() => {
      void this.tickThoughtLoop()
    }, intervalMs)

    this.initialThoughtLoopTimer = setTimeout(() => {
      this.initialThoughtLoopTimer = undefined
      void this.tickThoughtLoop()
    }, THOUGHT_LOOP_INITIAL_DELAY_MS)
  }

  private async tickThoughtLoop(): Promise<void> {
    if (!this.running) {
      return
    }

    if (this.ctx.config.thoughtLoopSkipWhenQueueNotEmpty && this.ctx.eventQueue.hasUserEvents()) {
      console.log('[loop-3:reflection] skipping — user events in queue')
      return
    }

    if (this.currentJobId || this.summaryRunning) {
      console.log('[loop-3:reflection] skipping — job or summary in progress')
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
    this.currentJobId = `thought-${thoughtId}`
    console.log(`[loop-3:reflection] === thought loop ${thoughtId} ===`)

    try {
      if (this.ctx.config.proactiveMode) {
        const memory = loadMemoryContext(this.ctx.config)
        await runThoughtLoop(this.ctx.config, memory, this.getBrowser())
      } else {
        console.log('[loop-3:reflection] proactive mode disabled, skipping LLM reflection')
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[loop-3:reflection] thought loop error: ${errMsg}`)
    } finally {
      this.currentJobId = undefined
      this.lastJobFinishedAt = Date.now()
      this.scheduleImmediatePollIfNeeded()
    }
  }

  // --- Independent summary scheduler ---

  private startSummaryScheduler(): void {
    const intervalMs = this.ctx.config.thoughtLoopSeconds * 1000
    console.log(`[summary-scheduler] summary check every ${this.ctx.config.thoughtLoopSeconds}s`)

    this.summaryTimer = setInterval(() => {
      void this.runSummaryIfIdle()
    }, intervalMs)
  }

  private async runSummaryIfIdle(): Promise<void> {
    if (!this.running || this.summaryRunning || this.currentJobId) {
      return
    }

    if (this.ctx.eventQueue.hasInteractiveEvents()) {
      console.log('[summary] skipping — interactive events pending')
      this.scheduleImmediatePollIfNeeded()
      return
    }

    this.summaryRunning = true
    try {
      await this.drainSummaryPipeline()
    } finally {
      this.summaryRunning = false
      this.scheduleImmediatePollIfNeeded()
    }
  }

  private async drainSummaryPipeline(): Promise<void> {
    let processed = 0
    for (;;) {
      if (!this.running) {
        break
      }

      const task = findNextSummaryTask(this.ctx.config, this.milestones)
      if (!task) {
        break
      }

      console.log(`[summarization] processing ${task.milestone.label}: ${task.inputFiles.length} files from ${task.sourceMilestone} [${task.periodStart} .. ${task.periodEnd}]`)

      const rawContent = readInputContents(task.inputDir, task.inputFiles)
      const summary = await runSummarization(this.ctx.config, task.milestone.label, rawContent)
      if (!summary) {
        console.log(`[summarization] summary generation failed for ${task.milestone.label} [${task.periodStart} .. ${task.periodEnd}] — drain pass stopped, will retry on next tick`)
        break
      }

      writeSummary(this.ctx.config, task, summary)
      processed++
    }

    cleanupOldRuns(this.ctx.config)

    if (processed > 0) {
      console.log(`[summarization] pipeline drained: ${processed} task(s) completed`)
    }
  }

  private scheduleImmediatePollIfNeeded(): void {
    if (!this.running) {
      return
    }

    if (this.immediatePollTimer || this.pollRunning) {
      return
    }

    if (!this.ctx.eventQueue.hasInteractiveEvents()) {
      return
    }

    console.log('[orchestrator] interactive events detected after idle work — scheduling immediate poll')
    this.immediatePollTimer = setTimeout(() => {
      this.immediatePollTimer = undefined
      void this.tickEventPoll()
    }, 0)
  }

  private getBrowser(): BrowserIntegration | undefined {
    for (const integration of this.ctx.integrations) {
      if (integration instanceof BrowserIntegration) {
        return integration
      }
    }

    return undefined
  }

  private cancellableSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.coalesceCancelFn = undefined
        resolve()
      }, ms)

      this.coalesceCancelFn = () => {
        clearTimeout(timer)
        this.coalesceCancelFn = undefined
        resolve()
      }
    })
  }
}
