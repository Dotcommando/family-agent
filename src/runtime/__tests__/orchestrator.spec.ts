import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  runReasoningMock,
  runThoughtLoopMock,
  runSummarizationMock,
  loadMemoryContextMock,
  parseMilestonesMock,
  findNextSummaryTaskMock,
  readInputContentsMock,
  writeSummaryMock,
  cleanupOldRunsMock,
} = vi.hoisted(() => ({
  runReasoningMock: vi.fn(),
  runThoughtLoopMock: vi.fn(),
  runSummarizationMock: vi.fn(),
  loadMemoryContextMock: vi.fn(),
  parseMilestonesMock: vi.fn(),
  findNextSummaryTaskMock: vi.fn(),
  readInputContentsMock: vi.fn(),
  writeSummaryMock: vi.fn(),
  cleanupOldRunsMock: vi.fn(),
}))

vi.mock('../reasoning.js', () => ({
  runReasoning: runReasoningMock,
  runThoughtLoop: runThoughtLoopMock,
  runSummarization: runSummarizationMock,
}))

vi.mock('../../memory/memory-loader.js', () => ({
  loadMemoryContext: loadMemoryContextMock,
}))

vi.mock('../../memory/summarization.js', () => ({
  parseMilestones: parseMilestonesMock,
  findNextSummaryTask: findNextSummaryTaskMock,
  readInputContents: readInputContentsMock,
  writeSummary: writeSummaryMock,
  cleanupOldRuns: cleanupOldRunsMock,
}))

import { Orchestrator } from '../orchestrator.js'
import { ChannelKind } from '../../channels/types.js'
import { EventPriority, EventSource, JobStatus } from '../../queue/types.js'
import type { IAgentEvent, ICoalescedBatch, IJob } from '../../queue/types.js'

class FakeEventBus {
  private listeners: Array<(event: IAgentEvent) => void> = []

  on(listener: (event: IAgentEvent) => void): void {
    this.listeners.push(listener)
  }

  emit(event: IAgentEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}

class FakeChannelAdapter {
  readonly kind: ChannelKind
  readonly sent: Array<{ chatId: string; response: string }> = []

  constructor(kind: ChannelKind) {
    this.kind = kind
  }

  async sendResponse(chatId: string, response: string): Promise<void> {
    this.sent.push({ chatId, response })
  }
}

class FakeEventQueue {
  private readonly config: { chatCoalesceMaxItems: number }
  private pendingEvents: IAgentEvent[] = []
  readonly jobs: IJob[] = []

  constructor(config: { chatCoalesceMaxItems: number }) {
    this.config = config
  }

  enqueue(event: IAgentEvent): void {
    this.pendingEvents.push(event)
  }

  pendingCount(): number {
    return this.pendingEvents.length
  }

  hasUserEvents(): boolean {
    return this.pendingEvents.some((event) => event.priority === EventPriority.User)
  }

  hasInteractiveEvents(): boolean {
    return this.pendingEvents.some(
      (event) => event.priority === EventPriority.User && event.requiresResponse,
    )
  }

  drainPending(): IAgentEvent[] {
    const drained = [...this.pendingEvents].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    this.pendingEvents = []
    return drained
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
        requiresResponse: limited.some((event) => event.requiresResponse),
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
      const priorityA = Math.min(...a.events.map((event) => event.priority))
      const priorityB = Math.min(...b.events.map((event) => event.priority))
      return priorityA !== priorityB
        ? priorityA - priorityB
        : a.firstAt.localeCompare(b.firstAt)
    })
  }

  persistJob(job: IJob): void {
    this.jobs.push({ ...job })
  }

  moveJob(job: IJob, _from: JobStatus, to: JobStatus): void {
    const index = this.jobs.findIndex((item) => item.id === job.id)
    if (index !== -1) {
      this.jobs[index] = { ...job, status: to }
    } else {
      this.jobs.push({ ...job, status: to })
    }
  }
}

type TOrchestratorContext = ConstructorParameters<typeof Orchestrator>[0]

function createConfig() {
  return {
    agentName: 'family-agent',
    agentPort: 3000,
    ollamaBaseUrl: 'http://ollama:11434',
    ollamaModel: 'qwen2.5:14b',
    lanceDbDir: '/tmp/lancedb',
    memoryDir: '/tmp/memory',
    secretsDir: '/tmp/secrets',
    queueDir: '/tmp/queue',
    eventPollSeconds: 10,
    idleBackoffSeconds: 30,
    thoughtLoopSeconds: 240,
    maxConcurrentJobs: 1,
    proactiveMode: true,
    coalesceWindowSeconds: 45,
    messageBatchWindowSeconds: 30,
    chatCoalesceMaxItems: 20,
    eventQueueStrategy: 'priority-fifo',
    thoughtLoopSkipWhenQueueNotEmpty: true,
    dedupThoughtLoop: true,
    summarizationMilestones: ['1h', '3h'],
    summarizationMaxInputItems: 200,
    summaryRawRetentionDays: 14,
    purposeDir: '/tmp/purpose',
    policiesDir: '/tmp/policies',
    terminalChatDir: '/tmp/terminal-chat',
    telegramAllowedChats: [],
    telegramAllowedUsers: [],
    telegramRequireMentionInGroups: true,
    browserProfileDir: '/tmp/browser-profile',
    browserHeadless: true,
    browserDefaultTimeout: 15000,
    browserMaxStepsPerRun: 15,
    browserSearchEngineUrl: 'https://www.google.com/search?q={query}',
  }
}

function createEvent(params: {
  id: string
  chatId: string
  payload: string
  createdAt: string
  source?: EventSource
  priority?: EventPriority
  requiresResponse?: boolean
  batchable?: boolean
}): IAgentEvent {
  return {
    id: params.id,
    source: params.source ?? EventSource.Terminal,
    priority: params.priority ?? EventPriority.User,
    payload: params.payload,
    createdAt: params.createdAt,
    batchable: params.batchable ?? true,
    requiresResponse: params.requiresResponse ?? true,
    chatId: params.chatId,
  }
}

function createHarness() {
  const config = createConfig()
  const eventBus = new FakeEventBus()
  const eventQueue = new FakeEventQueue({
    chatCoalesceMaxItems: config.chatCoalesceMaxItems,
  })
  const terminalChannel = new FakeChannelAdapter(ChannelKind.Terminal)

  const ctx = {
    config,
    secrets: {},
    eventBus,
    eventQueue,
    integrations: [],
    channels: [terminalChannel],
  } satisfies TOrchestratorContext

  const orchestrator = new Orchestrator(ctx)

  return {
    orchestrator,
    eventBus,
    eventQueue,
    terminalChannel,
  }
}

describe('Orchestrator interactive scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers()

    runReasoningMock.mockReset()
    runThoughtLoopMock.mockReset()
    runSummarizationMock.mockReset()
    loadMemoryContextMock.mockReset()
    parseMilestonesMock.mockReset()
    findNextSummaryTaskMock.mockReset()
    readInputContentsMock.mockReset()
    writeSummaryMock.mockReset()
    cleanupOldRunsMock.mockReset()

    loadMemoryContextMock.mockReturnValue({})
    parseMilestonesMock.mockReturnValue([{ label: '1h', seconds: 3600 }])
    findNextSummaryTaskMock.mockReturnValue(undefined)
    runReasoningMock.mockResolvedValue({
      response: 'ok',
      suppressReply: false,
    })
    runThoughtLoopMock.mockResolvedValue('idle')
    runSummarizationMock.mockResolvedValue('')
    readInputContentsMock.mockReturnValue('raw')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the full 500ms interactive coalescing window when another interactive event arrives during fast path', async () => {
    const { orchestrator, eventBus } = createHarness()

    await orchestrator.start()

    eventBus.emit(createEvent({
      id: 'event-1',
      chatId: 'chat-1',
      payload: 'first',
      createdAt: '2026-03-09T12:00:00.000Z',
    }))

    await vi.advanceTimersByTimeAsync(0)
    expect(runReasoningMock).not.toHaveBeenCalled()

    eventBus.emit(createEvent({
      id: 'event-2',
      chatId: 'chat-1',
      payload: 'second',
      createdAt: '2026-03-09T12:00:00.100Z',
    }))

    await Promise.resolve()
    expect(runReasoningMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(499)
    expect(runReasoningMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(runReasoningMock).toHaveBeenCalledTimes(1)

    const batch = runReasoningMock.mock.calls[0]?.[2] as ICoalescedBatch
    expect(batch.messageCount).toBe(2)
    expect(batch.latestPayload).toBe('second')

    await orchestrator.stop()
  })

  it('does not drain the queue after stop interrupts coalescing sleep', async () => {
    const { orchestrator, eventBus, eventQueue } = createHarness()

    await orchestrator.start()

    eventBus.emit(createEvent({
      id: 'event-1',
      chatId: 'chat-1',
      payload: 'hello',
      createdAt: '2026-03-09T12:00:00.000Z',
    }))

    await vi.advanceTimersByTimeAsync(0)
    expect(eventQueue.pendingCount()).toBe(1)
    expect(runReasoningMock).not.toHaveBeenCalled()

    await orchestrator.stop()
    await Promise.resolve()

    expect(runReasoningMock).not.toHaveBeenCalled()
    expect(eventQueue.pendingCount()).toBe(1)
  })

  it('runs summarization only after the whole drain pass finishes', async () => {
    const sequence: string[] = []
    const { orchestrator, eventBus } = createHarness()

    runReasoningMock.mockImplementation(async (_config, _memory, batch: ICoalescedBatch) => {
      sequence.push(`reasoning:${batch.chatId}`)
      return {
        response: `response:${batch.chatId}`,
        suppressReply: false,
      }
    })

    let summaryTaskIssued = false
    findNextSummaryTaskMock.mockImplementation(() => {
      if (summaryTaskIssued) {
        return undefined
      }

      summaryTaskIssued = true

      return {
        milestone: { label: '1h', seconds: 3600 },
        inputFiles: ['run-1.md'],
        sourceMilestone: 'runs',
        periodStart: '2026-03-09T11:00:00.000Z',
        periodEnd: '2026-03-09T12:00:00.000Z',
        inputDir: '/tmp/memory/runs',
      }
    })

    runSummarizationMock.mockImplementation(async () => {
      sequence.push('summarization')
      return 'summary text'
    })

    await orchestrator.start()

    eventBus.emit(createEvent({
      id: 'event-1',
      chatId: 'chat-1',
      payload: 'first chat',
      createdAt: '2026-03-09T12:00:00.000Z',
    }))

    eventBus.emit(createEvent({
      id: 'event-2',
      chatId: 'chat-2',
      payload: 'second chat',
      createdAt: '2026-03-09T12:00:00.050Z',
    }))

    await vi.advanceTimersByTimeAsync(500)

    expect(sequence).toEqual([
      'reasoning:chat-1',
      'reasoning:chat-2',
      'summarization',
    ])

    expect(writeSummaryMock).toHaveBeenCalledTimes(1)
    expect(cleanupOldRunsMock).toHaveBeenCalledTimes(1)

    await orchestrator.stop()
  })
})
