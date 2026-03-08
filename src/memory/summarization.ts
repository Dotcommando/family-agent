import { readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { IEnvConfig } from '../config/env.js'
import type { IMilestoneSpec, ISummaryMeta, ISummaryTask } from './types.js'
import { isRecord } from '../lib/type-utils.js'

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

export function parseMilestones(labels: ReadonlyArray<string>): IMilestoneSpec[] {
  return labels.map(parseMilestone).sort((a, b) => a.seconds - b.seconds)
}

function alignPeriodEnd(now: Date, milestoneSeconds: number): Date {
  const msPerSlot = milestoneSeconds * 1000
  const aligned = Math.floor(now.getTime() / msPerSlot) * msPerSlot
  return new Date(aligned)
}

function isSummaryMeta(value: unknown): value is ISummaryMeta {
  if (!isRecord(value)) {
    return false
  }
  return (
    typeof value['milestone'] === 'string' &&
    typeof value['periodStart'] === 'string' &&
    typeof value['periodEnd'] === 'string' &&
    typeof value['createdAt'] === 'string' &&
    typeof value['sourceMilestone'] === 'string' &&
    typeof value['sourceCount'] === 'number' &&
    Array.isArray(value['sourceRefs'])
  )
}

function readSummaryMeta(metaPath: string): ISummaryMeta | undefined {
  if (!existsSync(metaPath)) {
    return undefined
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(metaPath, 'utf8'))
    return isSummaryMeta(raw) ? raw : undefined
  } catch {
    return undefined
  }
}

function listSummaryMetas(dir: string): ISummaryMeta[] {
  if (!existsSync(dir)) {
    return []
  }
  const metaFiles = readdirSync(dir).filter((f) => f.endsWith('.meta.json'))
  const metas: ISummaryMeta[] = []
  for (const file of metaFiles) {
    const meta = readSummaryMeta(join(dir, file))
    if (meta) {
      metas.push(meta)
    }
  }
  return metas.sort((a, b) => a.periodEnd.localeCompare(b.periodEnd))
}

function parseFinishedAtFromRun(fileName: string): string | undefined {
  const base = fileName.replace(/\.md$/, '')
  const tsMatch = base.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/)
  if (!tsMatch?.[1]) {
    return undefined
  }
  const restored = tsMatch[1]
    .replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z')
  const d = new Date(restored)
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined
}

function findRunsInWindow(runsDir: string, periodStart: string, periodEnd: string, maxItems: number): string[] {
  if (!existsSync(runsDir)) {
    return []
  }
  const files = readdirSync(runsDir).filter((f) => f.endsWith('.md')).sort()
  const matched: string[] = []
  for (const file of files) {
    const finishedAt = parseFinishedAtFromRun(file)
    if (!finishedAt) {
      continue
    }
    if (finishedAt >= periodStart && finishedAt < periodEnd) {
      matched.push(file)
    }
  }
  return matched.slice(-maxItems)
}

function findSummariesForUpperLevel(
  prevDir: string,
  targetEnd: string,
  sourceCount: number,
): string[] {
  const metas = listSummaryMetas(prevDir)
  const eligible = metas.filter((m) => m.periodEnd <= targetEnd)
  const selected = eligible.slice(-sourceCount)
  return selected.map((m) => {
    const baseName = m.createdAt.replace(/[:.]/g, '-')
    return `${baseName}.md`
  })
}

export function findNextSummaryTask(
  config: IEnvConfig,
  milestones: ReadonlyArray<IMilestoneSpec>,
): ISummaryTask | undefined {
  const now = new Date()
  const runsDir = join(config.memoryDir, 'runs')

  for (let i = 0; i < milestones.length; i++) {
    const milestone = milestones[i]
    if (!milestone) {
      continue
    }

    const periodEnd = alignPeriodEnd(now, milestone.seconds)
    const periodStart = new Date(periodEnd.getTime() - milestone.seconds * 1000)

    const summaryDir = join(config.memoryDir, 'summaries', milestone.label)
    mkdirSync(summaryDir, { recursive: true })

    const existingMetas = listSummaryMetas(summaryDir)
    const alreadyCovered = existingMetas.some((m) => m.periodEnd === periodEnd.toISOString())
    if (alreadyCovered) {
      continue
    }

    const isBottomLevel = i === 0
    const previousMilestone = i > 0 ? milestones[i - 1] : undefined

    if (isBottomLevel) {
      const inputFiles = findRunsInWindow(
        runsDir,
        periodStart.toISOString(),
        periodEnd.toISOString(),
        config.summarizationMaxInputItems,
      )
      if (inputFiles.length === 0) {
        return undefined
      }
      return {
        milestone,
        previousMilestone: undefined,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        inputFiles,
        inputDir: runsDir,
        sourceMilestone: 'runs',
        sourceCount: inputFiles.length,
      }
    }

    if (!previousMilestone) {
      return undefined
    }

    const sourceCount = Math.ceil(milestone.seconds / previousMilestone.seconds)
    const prevDir = join(config.memoryDir, 'summaries', previousMilestone.label)

    const inputFiles = findSummariesForUpperLevel(
      prevDir,
      periodEnd.toISOString(),
      sourceCount,
    )

    if (inputFiles.length < sourceCount) {
      return undefined
    }

    return {
      milestone,
      previousMilestone,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      inputFiles,
      inputDir: prevDir,
      sourceMilestone: previousMilestone.label,
      sourceCount,
    }
  }

  return undefined
}

export function readInputContents(inputDir: string, fileNames: ReadonlyArray<string>): string {
  return fileNames
    .map((f) => {
      const filePath = join(inputDir, f)
      return existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
    })
    .filter(Boolean)
    .join('\n\n---\n\n')
}

export function writeSummary(
  config: IEnvConfig,
  task: ISummaryTask,
  content: string,
): string {
  const summaryDir = join(config.memoryDir, 'summaries', task.milestone.label)
  mkdirSync(summaryDir, { recursive: true })

  const createdAt = new Date().toISOString()
  const baseName = createdAt.replace(/[:.]/g, '-')
  const mdFileName = `${baseName}.md`
  const metaFileName = `${baseName}.meta.json`

  writeFileSync(join(summaryDir, mdFileName), content)

  const meta: ISummaryMeta = {
    milestone: task.milestone.label,
    periodStart: task.periodStart,
    periodEnd: task.periodEnd,
    createdAt,
    sourceMilestone: task.sourceMilestone,
    sourceCount: task.sourceCount,
    sourceRefs: task.inputFiles,
  }
  writeFileSync(join(summaryDir, metaFileName), JSON.stringify(meta, null, 2))

  console.log(`[summarization] wrote ${task.milestone.label} summary: ${mdFileName} (${task.sourceCount} sources from ${task.sourceMilestone})`)
  return mdFileName
}

export function cleanupOldRuns(config: IEnvConfig): number {
  const runsDir = join(config.memoryDir, 'runs')
  if (!existsSync(runsDir)) {
    return 0
  }

  const maxAgeMs = config.summaryRawRetentionDays * 86400 * 1000
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString()
  const files = readdirSync(runsDir).filter((f) => f.endsWith('.md'))
  let removed = 0

  for (const file of files) {
    const finishedAt = parseFinishedAtFromRun(file)
    if (finishedAt && finishedAt < cutoff) {
      unlinkSync(join(runsDir, file))
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
