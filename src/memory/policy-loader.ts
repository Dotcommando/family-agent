import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { IEnvConfig } from '../config/env.js'

export function loadPolicy(config: IEnvConfig, channelName: string): string {
  const filePath = join(config.policiesDir, `${channelName}.md`)
  if (!existsSync(filePath)) {
    return ''
  }
  try {
    const content = readFileSync(filePath, 'utf8')
    console.log(`[policy] loaded policy for channel "${channelName}" (${content.length} chars)`)
    return content
  } catch {
    return ''
  }
}
