import { spawn } from 'node:child_process'

const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? 'http://ollama:11434'
const ollamaModel = process.env.OLLAMA_MODEL ?? 'llama3.2'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForModel() {
  for (;;) {
    try {
      const versionRes = await fetch(`${ollamaBaseUrl}/api/version`)
      if (!versionRes.ok) {
        await sleep(1000)
        continue
      }

      const showRes = await fetch(`${ollamaBaseUrl}/api/show`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: ollamaModel }),
      })

      if (showRes.ok) {
        console.log(`[entrypoint] ollama is ready and model "${ollamaModel}" is available`)
        return
      }

      console.log(`[entrypoint] waiting for model "${ollamaModel}" to become available`)
    } catch {
      console.log('[entrypoint] waiting for ollama API')
    }

    await sleep(2000)
  }
}

async function main() {
  console.log(`[entrypoint] waiting for ollama at ${ollamaBaseUrl}`)
  await waitForModel()

  const child = spawn('npm', ['run', 'start'], {
    stdio: 'inherit',
    env: process.env,
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }

    process.exit(code ?? 1)
  })
}

main().catch((error) => {
  console.error('[entrypoint] failed before agent start')
  console.error(error)
  process.exit(1)
})
