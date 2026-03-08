import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { IEnvConfig } from '../config/env.js'
import type { IRunHandoff } from './types.js'

export function writeRunHandoff(config: IEnvConfig, handoff: IRunHandoff): void {
  const runsDir = join(config.memoryDir, 'runs')
  mkdirSync(runsDir, { recursive: true })

  const fileName = `${handoff.finishedAt.replace(/[:.]/g, '-')}_${handoff.runId}.md`
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

  writeFileSync(join(runsDir, fileName), content)
  console.log(`[memory] wrote run handoff: ${fileName}`)

  const planPath = join(config.memoryDir, 'plans', 'next-run.md')
  writeFileSync(planPath, handoff.nextRunPlan)
  console.log('[memory] updated next-run plan')
}
