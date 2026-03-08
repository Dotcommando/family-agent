import { readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { IEnvConfig } from '../config/env.js'

interface IMilestoneSpec {
  label: string
  seconds: number
}

const UNIT_MAP: Record<string, number> = {
  h: 3600,
  d: 86400,
}

function parseMilestone(label: string): IMilestoneSpec {
  const match = label.match(/^(\d+)([hd])$/)
  if (!match?.[1] || !match[2]) {
    throw new Error(`Invalid milestone format: ${label}`)
  }
  const value = Number(match[1])
  const unitSeconds = UNIT_MAP[match[2]] ?? 3600
  return { label, seconds: value * unitSeconds }
}

function ageInSeconds(filePath: string): number {
  const stat = statSync(filePath)
  return (Date.now() - stat.mtimeMs) / 1000
}

export function parseMilestones(labels: ReadonlyArray<string>): IMilestoneSpec[] {
  return labels.map(parseMilestone).sort((a, b) => a.seconds - b.seconds)
}

export function findSummarizationCandidates(
  config: IEnvConfig,
  milestones: ReadonlyArray<IMilestoneSpec>,
): ReadonlyArray<{ milestone: IMilestoneSpec; inputFiles: string[] }> {
  const runsDir = join(config.memoryDir, 'runs')
  if (!existsSync(runsDir)) {
    return []
  }

  const now = Date.now()
  const candidates: Array<{ milestone: IMilestoneSpec; inputFiles: string[] }> = []

  for (const milestone of milestones) {
    const summaryDir = join(config.memoryDir, 'summaries', milestone.label)
    mkdirSync(summaryDir, { recursive: true })

    const existingSummaries = readdirSync(summaryDir).filter((f) => f.endsWith('.md'))
    const latestSummaryAge = existingSummaries.length > 0
      ? Math.min(...existingSummaries.map((f) => ageInSeconds(join(summaryDir, f))))
      : Infinity

    if (latestSummaryAge < milestone.seconds) {
      continue
    }

    const runFiles = readdirSync(runsDir)
      .filter((f) => f.endsWith('.md'))
      .filter((f) => ageInSeconds(join(runsDir, f)) <= milestone.seconds)
      .sort()
      .slice(-config.summarizationMaxInputItems)

    if (runFiles.length > 0) {
      candidates.push({ milestone, inputFiles: runFiles })
    }
  }

  return candidates
}

export function writeSummary(config: IEnvConfig, milestone: string, content: string): string {
  const summaryDir = join(config.memoryDir, 'summaries', milestone)
  mkdirSync(summaryDir, { recursive: true })

  const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}.md`
  writeFileSync(join(summaryDir, fileName), content)
  console.log(`[summarization] wrote ${milestone} summary: ${fileName}`)
  return fileName
}

export function cleanupOldRuns(config: IEnvConfig): number {
  const runsDir = join(config.memoryDir, 'runs')
  if (!existsSync(runsDir)) {
    return 0
  }

  const maxAgeSeconds = config.summaryRawRetentionDays * 86400
  const files = readdirSync(runsDir).filter((f) => f.endsWith('.md'))
  let removed = 0

  for (const file of files) {
    const filePath = join(runsDir, file)
    if (ageInSeconds(filePath) > maxAgeSeconds) {
      unlinkSync(filePath)
      removed++
    }
  }

  if (removed > 0) {
    console.log(`[summarization] cleaned up ${removed} old run files`)
  }

  return removed
}

export function readRunContents(config: IEnvConfig, fileNames: ReadonlyArray<string>): string {
  const runsDir = join(config.memoryDir, 'runs')
  return fileNames
    .map((f) => readFileSync(join(runsDir, f), 'utf8'))
    .join('\n\n---\n\n')
}
