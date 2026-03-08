export interface IMemoryContext {
  purpose: string
  identity: string
  nextRunPlan: string
  recentRuns: ReadonlyArray<IRunSummary>
  summaries: ReadonlyArray<IMilestoneSummary>
}

export interface IRunSummary {
  fileName: string
  content: string
  createdAt: string
}

export interface IMilestoneSummary {
  milestone: string
  fileName: string
  content: string
}

export interface IRunHandoff {
  runId: string
  startedAt: string
  finishedAt: string
  summary: string
  nextRunPlan: string
}

export interface ISummaryMeta {
  milestone: string
  periodStart: string
  periodEnd: string
  createdAt: string
  sourceMilestone: string
  sourceCount: number
  sourceRefs: string[]
}

export interface IMilestoneSpec {
  label: string
  seconds: number
}

export interface ISummaryTask {
  milestone: IMilestoneSpec
  previousMilestone: IMilestoneSpec | undefined
  periodStart: string
  periodEnd: string
  inputFiles: string[]
  inputDir: string
  sourceMilestone: string
  sourceCount: number
}
