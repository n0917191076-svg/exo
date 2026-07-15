import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function repoFile(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')
}

describe('Exo tooling contract', () => {
  it('documents HTTP transcription and suggestion routes as the production path', () => {
    const readme = repoFile('worker-template/README.md')

    expect(readme).toContain('POST `/transcribe?lang=zh|en&gated=1|0`')
    expect(readme).toContain('POST `/suggest?stream=1`')
    expect(readme).toContain('`Content-Type: application/octet-stream`')
    expect(readme).toContain('`Content-Type: application/json`')
    expect(readme).toContain('Legacy `/ws`')
    expect(readme).not.toContain('Open a WebSocket to `<worker>/ws')
  })

  it('tests the deployed Worker through current HTTP endpoints', () => {
    const script = repoFile('scripts/test-webkit.mjs')

    expect(script).toContain('/suggest?stream=0')
    expect(script).toContain('/suggest?stream=1')
    expect(script).toContain('/transcribe?lang=zh&gated=1')
    expect(script).toContain("mode: 'work'")
    expect(script).not.toContain("mode: 'date'")
    expect(script).not.toContain('new WebSocket')
    expect(script).toContain('const REQUEST_TIMEOUT_MS')
    expect(script.match(/new AbortController\(\)/g)).toHaveLength(4)
    expect(script).toContain('finally {\n  await browser.close()')
  })

  it('documents the current Exo simulator prerequisites', () => {
    const script = repoFile('scripts/regression.mjs')

    expect(script).toContain('cd ~/projects/exo')
    expect(script).toContain('npm run dev -- --port 5173')
    expect(script).toContain('http://localhost:5173 --automation-port 9897')
    expect(script).toContain('Exo regression test')
  })
})
