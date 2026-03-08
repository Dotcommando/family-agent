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
