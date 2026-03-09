/**
 * Patches the `telegram` package to expose subpath type declarations
 * for `telegram/events` and `telegram/events/*`.
 *
 * The package ships .d.ts files under `events/` but does not declare
 * `typesVersions` or `exports`, so TypeScript with `moduleResolution: NodeNext`
 * cannot resolve `import('telegram/events')`.
 *
 * This script adds a `typesVersions` entry to the installed package.json,
 * which is the standard mechanism for subpath type resolution without `exports`.
 *
 * Run automatically via npm `postinstall`.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgPath = resolve(__dirname, '..', 'node_modules', 'telegram', 'package.json')

const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))

if (pkg.typesVersions) {
  process.exit(0)
}

pkg.typesVersions = {
  '*': {
    'events': ['events/index.d.ts'],
    'events/*': ['events/*.d.ts'],
  },
}

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')

console.log('[patch-telegram-types] added typesVersions to telegram/package.json')
