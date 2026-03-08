import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { IEnvConfig } from '../config/env.js'
import type { IRunHandoff } from './types.js'

export function writeRunHandoff(config: IEnvConfig, handoff: IRunHandoff): void {
  const runsDir = join(config.memoryDir, 'runs')
  mkdirSync(runsDir, { recursive: true })

  const safeFinished = handoff.finishedAt.replace(/[:.]/g, '-')
  const baseName = `${safeFinished}_${handoff.runId}`
  const mdFileName = `${baseName}.md`
  const metaFileName = `${baseName}.meta.json`

  const content = [
    `# Run ${handoff.runId}`,
    '',
    `Started: ${handoff.startedAt}`,
    `Finished: ${handoff.finishedAt}`,
    '',
    '## Summary',
    '',
    handoff.summary,
    '',
  ].join('\n')

  writeFileSync(join(runsDir, mdFileName), content)

  const meta = {
    runId: handoff.runId,
    startedAt: handoff.startedAt,
    finishedAt: handoff.finishedAt,
  }
  writeFileSync(join(runsDir, metaFileName), JSON.stringify(meta, null, 2))

  console.log(`[memory] wrote run handoff: ${mdFileName}`)

  const planDir = join(config.memoryDir, 'plans')
  mkdirSync(planDir, { recursive: true })
  const planPath = join(planDir, 'next-run.md')
  writeFileSync(planPath, handoff.nextRunPlan)
  console.log('[memory] updated next-run plan')
}
