import { randomUUID } from 'node:crypto'
import type { ICoalescedBatch } from '../queue/types.js'
import type { IEnvConfig } from '../config/env.js'
import type { IMemoryContext } from '../memory/types.js'
import { buildPromptContext } from '../memory/memory-loader.js'
import { writeRunHandoff } from '../memory/memory-writer.js'
import { ollamaChat, ollamaHealthCheck } from '../lib/ollama.js'
import type { IChatMessage } from '../lib/ollama.js'

const DEFAULT_CONTEXT_TOKEN_BUDGET = 4096

export async function runReasoning(
  config: IEnvConfig,
  memory: IMemoryContext,
  batch: ICoalescedBatch,
): Promise<string> {
  const runId = randomUUID().slice(0, 8)
  const startedAt = new Date().toISOString()

  console.log(`[reasoning] === start run ${runId} ===`)
  console.log(`[reasoning] chat=${batch.chatId} events=${batch.events.length} window=${batch.firstAt}..${batch.lastAt}`)

  const ollamaOk = await ollamaHealthCheck(config)
  if (!ollamaOk) {
    const msg = `[reasoning] Ollama is not reachable at ${config.ollamaBaseUrl}, skipping LLM call`
    console.log(msg)

    const finishedAt = new Date().toISOString()
    writeRunHandoff(config, {
      runId,
      startedAt,
      finishedAt,
      summary: `Ollama unreachable. ${batch.events.length} event(s) acknowledged but not processed by LLM.`,
      nextRunPlan: `# Next run\n\n- Retry processing ${batch.events.length} queued event(s) once Ollama is available.\n`,
    })

    return msg
  }

  const promptContext = buildPromptContext(memory, DEFAULT_CONTEXT_TOKEN_BUDGET)

  const userPayload = batch.events
    .map((e, idx) => `[${idx + 1}] (${e.createdAt}) [source:${e.source}] ${e.payload}`)
    .join('\n')

  const messages: IChatMessage[] = [
    {
      role: 'system',
      content: [
        'You are a persistent family assistant.',
        'Below is your memory context. Use it to understand ongoing plans and history.',
        '',
        promptContext,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `The following ${batch.events.length} message(s) arrived from chat ${batch.chatId}:`,
        '',
        userPayload,
        '',
        'If later messages override earlier ones, follow the latest intent.',
        'Respond concisely. State what you will do and any notes for your next iteration.',
      ].join('\n'),
    },
  ]

  console.log(`[reasoning] sending ${messages.length} messages to Ollama (model=${config.ollamaModel})`)

  let response: string
  try {
    response = await ollamaChat(config, config.ollamaModel, messages)
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error(`[reasoning] Ollama error: ${errMsg}`)
    response = `LLM error: ${errMsg}`
  }

  const finishedAt = new Date().toISOString()
  console.log(`[reasoning] === end run ${runId} (${finishedAt}) ===`)

  writeRunHandoff(config, {
    runId,
    startedAt,
    finishedAt,
    summary: response.slice(0, 2000),
    nextRunPlan: `# Next run\n\n- Follow up on run ${runId} results.\n- Check for new events.\n`,
  })

  return response
}

export async function runThoughtLoop(
  config: IEnvConfig,
  memory: IMemoryContext,
): Promise<string> {
  const runId = randomUUID().slice(0, 8)
  const startedAt = new Date().toISOString()

  console.log(`[thought-loop] === background reflection ${runId} ===`)

  const ollamaOk = await ollamaHealthCheck(config)
  if (!ollamaOk) {
    console.log(`[thought-loop] Ollama unreachable, skipping reflection`)
    return 'skipped: ollama unreachable'
  }

  const promptContext = buildPromptContext(memory, DEFAULT_CONTEXT_TOKEN_BUDGET)

  const messages: IChatMessage[] = [
    {
      role: 'system',
      content: [
        'You are a persistent family assistant reflecting on your state.',
        '',
        promptContext,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'This is a scheduled background reflection cycle. No new user messages arrived.',
        'Review your current plan and memory. Decide if any proactive actions are needed.',
        'If nothing is needed, say so briefly.',
        'Leave a clear handoff note for the next iteration.',
      ].join('\n'),
    },
  ]

  console.log(`[thought-loop] sending reflection to Ollama (model=${config.ollamaModel})`)

  let response: string
  try {
    response = await ollamaChat(config, config.ollamaModel, messages)
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error(`[thought-loop] Ollama error: ${errMsg}`)
    response = `LLM error: ${errMsg}`
  }

  const finishedAt = new Date().toISOString()
  console.log(`[thought-loop] === end reflection ${runId} (${finishedAt}) ===`)

  writeRunHandoff(config, {
    runId,
    startedAt,
    finishedAt,
    summary: `Background reflection: ${response.slice(0, 1500)}`,
    nextRunPlan: `# Next run\n\n- Continue from reflection ${runId}.\n`,
  })

  return response
}

export async function runSummarization(
  config: IEnvConfig,
  milestone: string,
  rawContent: string,
): Promise<string> {
  console.log(`[summarization] starting ${milestone} summarization`)

  const ollamaOk = await ollamaHealthCheck(config)
  if (!ollamaOk) {
    console.log(`[summarization] Ollama unreachable, skipping ${milestone} summary`)
    return ''
  }

  const messages: IChatMessage[] = [
    {
      role: 'system',
      content: 'You are a summarization assistant. Compress the following run logs into a concise summary preserving key facts, decisions, and pending items.',
    },
    {
      role: 'user',
      content: [
        `Summarize these run logs for the ${milestone} horizon:`,
        '',
        rawContent.slice(0, 8000),
        '',
        'Be concise. Preserve important facts and pending action items.',
      ].join('\n'),
    },
  ]

  try {
    const response = await ollamaChat(config, config.ollamaModel, messages)
    console.log(`[summarization] ${milestone} summary generated (${response.length} chars)`)
    return response
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error(`[summarization] error: ${errMsg}`)
    return ''
  }
}
