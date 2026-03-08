import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function readSecret(secretDir: string, fileName: string): string {
  const filePath = join(secretDir, fileName)
  return readFileSync(filePath, 'utf8').trim()
}

export function maskSecret(value: string): string {
  if (!value) {
    return 'missing'
  }

  if (value.length <= 4) {
    return `${value[0] ?? '*'}***`
  }

  const start = value.slice(0, 2)
  const end = value.slice(-2)
  return `${start}***${end}`
}
