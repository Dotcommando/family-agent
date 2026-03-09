import type { BrowserContext } from 'playwright'
import type { IEnvConfig } from '../config/env.js'
import type { IChatMessage } from '../lib/ollama.js'
import { ollamaChat } from '../lib/ollama.js'
import { isRecord } from '../lib/type-utils.js'
import { BrowserActionKind } from './types.js'
import type { IBrowserAction, IBrowserObservation, IBrowserConfig, IFinalAnswerParams } from './types.js'
import { executeBrowserAction } from './actions.js'

function isBrowserActionKind(value: string): value is BrowserActionKind {
  const validActions: ReadonlyArray<string> = Object.values(BrowserActionKind)
  return validActions.includes(value)
}

function extractFinalAnswerParams(params: unknown): IFinalAnswerParams | undefined {
  if (!isRecord(params)) return undefined
  if (typeof params['answer'] !== 'string') return undefined
  const result: IFinalAnswerParams = { answer: params['answer'] }
  if (typeof params['nextStep'] === 'string') result.nextStep = params['nextStep']
  if (typeof params['suppressReply'] === 'boolean') result.suppressReply = params['suppressReply']
  return result
}

const BROWSER_SYSTEM_PROMPT = `You have access to a browser. To use it, respond with a JSON object on a single line.

Available actions:
- open_url: {"action":"open_url","params":{"url":"https://example.com"}}
- search_web: {"action":"search_web","params":{"query":"search terms"}}
- click: {"action":"click","params":{"selector":"css-selector"}}
- fill: {"action":"fill","params":{"selector":"css-selector","value":"text"}}
- press: {"action":"press","params":{"key":"Enter"}} or {"action":"press","params":{"key":"Enter","selector":"css-selector"}}
- select_option: {"action":"select_option","params":{"selector":"css-selector","value":"option-value"}}
- wait_for_selector: {"action":"wait_for_selector","params":{"selector":"css-selector"}}
- wait_for_text: {"action":"wait_for_text","params":{"text":"expected text"}}
- extract_text: {"action":"extract_text","params":{}} or {"action":"extract_text","params":{"selector":"css-selector"}}
- final_answer: {"action":"final_answer","params":{"answer":"Your answer to the user","nextStep":"optional follow-up","suppressReply":false}}

Rules:
1. Return exactly ONE JSON object per response — nothing else, no explanation.
2. Inspect the observation after each step before deciding the next action.
3. When done, use final_answer with the complete answer for the user.
4. If a step fails, try an alternative approach or report the failure via final_answer.
5. Use CSS selectors for click, fill, select_option, wait_for_selector.
6. After submitting a form, use wait_for_selector, wait_for_text or extract_text to check the result.`

function formatObservation(obs: IBrowserObservation): string {
  const parts: string[] = [
    `Action: ${obs.action}`,
    `Success: ${obs.success}`,
  ]
  if (obs.url) parts.push(`URL: ${obs.url}`)
  if (obs.title) parts.push(`Title: ${obs.title}`)
  if (obs.error) parts.push(`Error: ${obs.error}`)
  if (obs.navigated !== undefined) parts.push(`Navigated: ${obs.navigated}`)
  if (obs.text) parts.push(`\nPage text:\n${obs.text}`)
  if (obs.buttons && obs.buttons.length > 0) {
    const btns = obs.buttons.map(b => b.selector ? `${b.text} → ${b.selector}` : b.text).join(', ')
    parts.push(`\nButtons: ${btns}`)
  }
  if (obs.formFields && obs.formFields.length > 0) {
    const fields = obs.formFields.map(f => `${f.label} (${f.type}) → ${f.selector}`).join('\n  ')
    parts.push(`\nForm fields:\n  ${fields}`)
  }
  if (obs.links && obs.links.length > 0) {
    const links = obs.links.map(l => l.selector ? `[${l.text}](${l.href}) → ${l.selector}` : `[${l.text}](${l.href})`).join('\n  ')
    parts.push(`\nLinks:\n  ${links}`)
  }
  return parts.join('\n')
}

function extractJsonFromResponse(raw: string): string | undefined {
  const trimmed = raw.trim()

  const fencedMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fencedMatch?.[1]) return fencedMatch[1].trim()

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1)
  }

  return undefined
}

function parseBrowserAction(raw: string): IBrowserAction | undefined {
  const jsonStr = extractJsonFromResponse(raw)
  if (!jsonStr) return undefined

  try {
    const parsed: unknown = JSON.parse(jsonStr)
    if (!isRecord(parsed)) return undefined
    const action = parsed['action']
    const params = parsed['params']
    if (typeof action !== 'string') return undefined
    if (!isRecord(params)) return undefined
    if (!isBrowserActionKind(action)) return undefined

    return { action, params }
  } catch {
    return undefined
  }
}

export interface IBrowserToolResult {
  answer: string
  usedBrowser: boolean
  steps: number
  suppressReply: boolean
}

export async function runBrowserToolLoop(
  config: IEnvConfig,
  browserConfig: IBrowserConfig,
  context: BrowserContext,
  systemPrompt: string,
  userPrompt: string,
): Promise<IBrowserToolResult> {
  const messages: IChatMessage[] = [
    { role: 'system', content: systemPrompt + '\n\n' + BROWSER_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ]

  let steps = 0
  let parseRetries = 0
  const maxSteps = browserConfig.maxStepsPerRun
  const maxParseRetries = 2

  console.log(`[browser-loop] starting tool loop (max ${maxSteps} steps)`)

  while (steps < maxSteps) {
    console.log(`[browser-loop] calling LLM (${steps} real steps so far, max ${maxSteps})`)

    let llmResponse: string
    try {
      llmResponse = await ollamaChat(config, config.ollamaModel, messages)
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[browser-loop] LLM error after ${steps} steps: ${errMsg}`)
      return { answer: `LLM error during browser tool loop: ${errMsg}`, usedBrowser: true, steps, suppressReply: false }
    }

    console.log(`[browser-loop] LLM responded (${llmResponse.length} chars)`)

    const action = parseBrowserAction(llmResponse)
    if (!action) {
      if (parseRetries < maxParseRetries) {
        parseRetries++
        console.log(`[browser-loop] invalid JSON, corrective retry ${parseRetries}/${maxParseRetries} (not counted as browser step)`)
        messages.push({ role: 'assistant', content: llmResponse })
        messages.push({ role: 'user', content: 'Your response is not valid JSON. Respond with exactly ONE JSON object: {"action":"...","params":{...}}. No extra text.' })
        continue
      }
      console.log(`[browser-loop] could not parse action after ${maxParseRetries} retries, aborting loop (${steps} real steps completed)`)
      return { answer: `Browser tool loop stopped: model returned invalid action format ${maxParseRetries + 1} times. Could not continue browser interaction reliably.`, usedBrowser: true, steps, suppressReply: false }
    }

    parseRetries = 0
    steps++

    console.log(`[browser-loop] step ${steps}/${maxSteps} — action: ${action.action}`)

    if (action.action === BrowserActionKind.FinalAnswer) {
      const finalParams = extractFinalAnswerParams(action.params)
      console.log(`[browser-loop] final answer at step ${steps}`)
      return {
        answer: finalParams?.answer ?? llmResponse,
        usedBrowser: true,
        steps,
        suppressReply: finalParams?.suppressReply === true,
      }
    }

    const observation = await executeBrowserAction(context, action, browserConfig)
    const obsText = formatObservation(observation)
    console.log(`[browser-loop] step ${steps} — ${action.action} ${observation.success ? 'OK' : 'FAILED'}`)

    messages.push({ role: 'assistant', content: llmResponse })
    messages.push({ role: 'user', content: `Browser observation:\n${obsText}` })
  }

  console.log(`[browser-loop] max steps (${maxSteps}) reached, extracting final answer`)

  messages.push({
    role: 'user',
    content: 'You have reached the maximum number of browser steps. Provide your best final_answer now based on what you have seen so far.',
  })

  try {
    const finalResponse = await ollamaChat(config, config.ollamaModel, messages)
    const finalAction = parseBrowserAction(finalResponse)
    if (finalAction?.action === BrowserActionKind.FinalAnswer) {
      const fp = extractFinalAnswerParams(finalAction.params)
      return { answer: fp?.answer ?? finalResponse, usedBrowser: true, steps, suppressReply: fp?.suppressReply === true }
    }
    console.log(`[browser-loop] max steps reached and model did not return valid final_answer`)
    return { answer: `Browser tool loop reached ${steps} steps limit. Model could not produce a valid final_answer. Browser interaction ended without reliable result.`, usedBrowser: true, steps, suppressReply: false }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    return { answer: `Browser tool loop ended after ${steps} steps with LLM error: ${errMsg}`, usedBrowser: true, steps, suppressReply: false }
  }
}
