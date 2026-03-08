import { randomUUID } from 'node:crypto'
import { EventSource } from '../queue/types.js'
import type { ICoalescedBatch } from '../queue/types.js'
import type { IEnvConfig } from '../config/env.js'
import type { IMemoryContext } from '../memory/types.js'
import { buildPromptContext } from '../memory/memory-loader.js'
import { loadPolicy } from '../memory/policy-loader.js'
import { writeRunHandoff } from '../memory/memory-writer.js'
import { ollamaChat, ollamaHealthCheck } from '../lib/ollama.js'
import type { IChatMessage } from '../lib/ollama.js'

const DEFAULT_CONTEXT_TOKEN_BUDGET = 4096

const SOURCE_TO_POLICY_NAME: ReadonlyMap<EventSource, string> = new Map([
  [EventSource.Telegram, 'telegram'],
  [EventSource.TelegramChannel, 'telegram'],
  [EventSource.Terminal, 'terminal'],
])

function isObservationBatch(batch: ICoalescedBatch): boolean {
  return !batch.requiresResponse
}

function buildBatchPrompt(batch: ICoalescedBatch): string {
  const lines: string[] = []
  const observation = isObservationBatch(batch)

  if (observation) {
    lines.push(`[OBSERVATION] The following was received from an external channel (no response required):`)
    lines.push('')
    lines.push(batch.latestPayload)
    lines.push('')
    lines.push('This is an observation event. Analyze the content, consider if it affects your plans,')
    lines.push('and include any relevant insights in your notes. Do NOT produce a reply message.')
  } else if (batch.messageCount === 1) {
    lines.push(`A message arrived from chat ${batch.chatId}:`)
    lines.push('')
    lines.push(batch.latestPayload)
  } else {
    lines.push(`${batch.messageCount} messages arrived from chat ${batch.chatId} (oldest first):`)
    lines.push('')
    for (let i = 0; i < batch.events.length; i++) {
      const event = batch.events[i]
      if (event) {
        lines.push(`[${i + 1}/${batch.messageCount}] (${event.createdAt}) ${event.payload}`)
      }
    }
    lines.push('')
    lines.push(`--- Latest message (${batch.messageCount}/${batch.messageCount}) ---`)
    lines.push(batch.latestPayload)
    lines.push('---')
    lines.push('')
    lines.push('IMPORTANT: Later messages may override, refine, or cancel earlier ones.')
    lines.push('The latest message represents the most current user intent.')
    lines.push('If messages contradict each other, follow the latest one.')
  }

  if (!observation) {
    lines.push('')
    lines.push('Respond concisely. State what you will do and any notes for your next iteration.')
  }

  return lines.join('\n')
}

export async function runReasoning(
  config: IEnvConfig,
  memory: IMemoryContext,
  batch: ICoalescedBatch,
): Promise<string> {
  const runId = randomUUID().slice(0, 8)
  const startedAt = new Date().toISOString()

  console.log(`[reasoning] === start run ${runId} ===`)
  console.log(`[reasoning] chat=${batch.chatId} events=${batch.messageCount} window=${batch.firstAt}..${batch.lastAt} requiresResponse=${batch.requiresResponse}`)

  const ollamaOk = await ollamaHealthCheck(config)
  if (!ollamaOk) {
    const msg = `[reasoning] Ollama is not reachable at ${config.ollamaBaseUrl}, skipping LLM call`
    console.log(msg)

    const finishedAt = new Date().toISOString()
    writeRunHandoff(config, {
      runId,
      startedAt,
      finishedAt,
      summary: `Ollama unreachable. ${batch.messageCount} event(s) acknowledged but not processed by LLM.`,
      nextRunPlan: `# Next run\n\n- Retry processing ${batch.messageCount} queued event(s) once Ollama is available.\n`,
    })

    return msg
  }

  const promptContext = buildPromptContext(memory, DEFAULT_CONTEXT_TOKEN_BUDGET)

  const batchSource = batch.events[0]?.source
  const policyName = batchSource ? SOURCE_TO_POLICY_NAME.get(batchSource) : undefined
  const policy = policyName ? loadPolicy(config, policyName) : ''

  const systemParts: string[] = [
    'You are a persistent family assistant.',
    'Below is your memory context. Use it to understand ongoing plans and history.',
    '',
    promptContext,
  ]

  if (policy) {
    systemParts.push('')
    systemParts.push('## Channel policy')
    systemParts.push('')
    systemParts.push(policy)
  }

  const messages: IChatMessage[] = [
    {
      role: 'system',
      content: systemParts.join('\n'),
    },
    {
      role: 'user',
      content: buildBatchPrompt(batch),
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
