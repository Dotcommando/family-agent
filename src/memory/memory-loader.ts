import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { IEnvConfig } from '../config/env.js'
import type { IMemoryContext, IRunSummary, IMilestoneSummary } from './types.js'

function safeReadFile(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
}

function readMdFiles(dir: string, limit: number): IRunSummary[] {
  if (!existsSync(dir)) {
    return []
  }

  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((fileName) => ({
      fileName,
      content: readFileSync(join(dir, fileName), 'utf8'),
      createdAt: fileName.replace(/\.md$/, ''),
    }))
}

export function loadMemoryContext(config: IEnvConfig): IMemoryContext {
  console.log('[memory] loading purpose file')
  const purpose = safeReadFile(join(config.purposeDir, 'main.md'))

  console.log('[memory] loading identity file')
  const identity = safeReadFile(join(config.memoryDir, 'identity', 'agent.md'))

  console.log('[memory] loading next-run plan')
  const nextRunPlan = safeReadFile(join(config.memoryDir, 'plans', 'next-run.md'))

  console.log('[memory] loading recent runs')
  const recentRuns = readMdFiles(join(config.memoryDir, 'runs'), 5)
  console.log(`[memory] loaded ${recentRuns.length} recent runs`)

  console.log('[memory] loading milestone summaries')
  const summaries: IMilestoneSummary[] = []
  for (const milestone of config.summarizationMilestones) {
    const dir = join(config.memoryDir, 'summaries', milestone)
    if (!existsSync(dir)) {
      continue
    }
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, 1)

    for (const fileName of files) {
      summaries.push({
        milestone,
        fileName,
        content: readFileSync(join(dir, fileName), 'utf8'),
      })
    }
  }
  console.log(`[memory] loaded ${summaries.length} milestone summaries`)

  return { purpose, identity, nextRunPlan, recentRuns, summaries }
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function buildPromptContext(memory: IMemoryContext, maxTokens: number): string {
  const sections: string[] = []
  let tokenBudget = maxTokens

  if (memory.purpose) {
    const purposeTokens = estimateTokens(memory.purpose)
    sections.push(`## Purpose\n\n${memory.purpose}`)
    tokenBudget -= purposeTokens
  }

  if (memory.identity && tokenBudget > 0) {
    const identityTokens = estimateTokens(memory.identity)
    if (identityTokens <= tokenBudget) {
      sections.push(`## Identity\n\n${memory.identity}`)
      tokenBudget -= identityTokens
    }
  }

  if (memory.nextRunPlan && tokenBudget > 0) {
    const planTokens = estimateTokens(memory.nextRunPlan)
    if (planTokens <= tokenBudget) {
      sections.push(`## Plan for this run\n\n${memory.nextRunPlan}`)
      tokenBudget -= planTokens
    }
  }

  for (const summary of memory.summaries) {
    if (tokenBudget <= 0) {
      break
    }
    const summaryTokens = estimateTokens(summary.content)
    if (summaryTokens <= tokenBudget) {
      sections.push(`## Summary (${summary.milestone})\n\n${summary.content}`)
      tokenBudget -= summaryTokens
    }
  }

  for (const run of memory.recentRuns) {
    if (tokenBudget <= 0) {
      break
    }
    const runTokens = estimateTokens(run.content)
    if (runTokens <= tokenBudget) {
      sections.push(`## Recent run: ${run.fileName}\n\n${run.content}`)
      tokenBudget -= runTokens
    }
  }

  const result = sections.join('\n\n---\n\n')
  console.log(`[memory] built prompt context: ${estimateTokens(result)} tokens (budget was ${maxTokens})`)
  return result
}
