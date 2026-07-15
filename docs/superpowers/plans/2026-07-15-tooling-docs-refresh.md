# Exo Tooling and Worker Documentation Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove stale Cue/WebSocket assumptions from Exo's Worker documentation and integration tooling without changing production runtime behavior.

**Architecture:** Keep `/ws` in the Worker as a legacy diagnostic route, but document HTTP `/transcribe` and `/suggest` as Exo's production path. Add a small static contract test so future edits cannot silently restore the removed Cue mode or WebSocket requirement. Validate the changed tooling with syntax checks, unit tests, Worker integration tests, simulator e2e, and a user-run live WebKit test that keeps the bearer outside the repository.

**Tech Stack:** TypeScript, Vitest, Node.js ESM scripts, Playwright/WebKit, Cloudflare Workers, Even Hub simulator.

## Global Constraints

- Do not change `src/even.ts` or its `enqueue()` rendering serialization.
- Do not add or upgrade dependencies.
- Do not remove the Worker's legacy `/ws` route; Exo simply does not use it in production.
- Do not write `SHARED_SECRET`, Deepgram keys, or Anthropic keys into source, tests, logs, or commits.
- Keep `app.json.supported_languages` as `en` and `zh`; Deepgram alone uses `zh-TW`.
- Run `npm test` after every implementation change.

---

### Task 1: Add a tooling-contract regression test

**Files:**
- Create: `tests/tooling-contract.test.ts`
- Test: `tests/tooling-contract.test.ts`

**Interfaces:**
- Consumes: repository text files `worker-template/README.md`, `scripts/test-webkit.mjs`, and `scripts/regression.mjs`.
- Produces: a Vitest guard that encodes Exo's supported HTTP integration contract.

- [ ] **Step 1: Write the failing test**

```ts
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
  })

  it('documents the current Exo simulator prerequisites', () => {
    const script = repoFile('scripts/regression.mjs')
    expect(script).toContain('cd ~/projects/exo')
    expect(script).toContain('npm run dev -- --port 5173')
    expect(script).toContain('http://localhost:5173 --automation-port 9897')
    expect(script).toContain('Exo regression test')
  })
})
```

- [ ] **Step 2: Run the targeted test to verify it fails**

Run: `npm test -- tests/tooling-contract.test.ts`

Expected: FAIL because the current Worker README and scripts still contain Cue/WebSocket paths.

- [ ] **Step 3: Commit only after Tasks 2–3 make the test pass**

No commit in this task; the failing guard and matching maintenance edits form one reviewable tooling fix.

### Task 2: Rewrite the Worker README and simulator prerequisites

**Files:**
- Modify: `worker-template/README.md`
- Modify: `scripts/regression.mjs`
- Test: `tests/tooling-contract.test.ts`

**Interfaces:**
- Consumes: current Worker routes in `worker-template/index.ts` and package scripts in `package.json`.
- Produces: accurate deployment, endpoint, authentication, audio, streaming, and simulator instructions.

- [ ] **Step 1: Replace the Worker README flow**

Document these exact production requests:

```text
POST /transcribe?lang=zh|en&gated=1|0
Authorization: Bearer <SHARED_SECRET>
Content-Type: application/octet-stream
Body: PCM16 16 kHz mono little-endian

POST /suggest?stream=1
Authorization: Bearer <SHARED_SECRET>
Content-Type: application/json
Body: mode, transcript, scene/model/length/lang, selected KB

POST /suggest?stream=0
Same request, JSON fallback response

GET /healthz
No authentication
```

State that `/ws` is legacy compatibility/diagnostics only and is not used by Exo's Even App WKWebView path.

- [ ] **Step 2: Correct simulator prerequisite comments**

Replace the stale comments with:

```js
// Prereqs (run manually first):
//   1. cd ~/projects/exo && npm run dev -- --port 5173
//   2. npx evenhub-simulator http://localhost:5173 --automation-port 9897
//
// Then: npm run test:e2e
```

Change the console heading from `Cue regression test` to `Exo regression test`; do not change the tested gesture flow.

- [ ] **Step 3: Run the targeted test**

Run: `npm test -- tests/tooling-contract.test.ts`

Expected: Worker README assertions pass; WebKit assertions still fail until Task 3.

### Task 3: Update the live WebKit integration test to Exo HTTP

**Files:**
- Modify: `scripts/test-webkit.mjs`
- Test: `tests/tooling-contract.test.ts`

**Interfaces:**
- Consumes: `EXO_WORKER_URL` or backwards-compatible `CUE_WORKER_URL`, and `SHARED_SECRET` or a local temp secret file.
- Produces: four WebKit checks: health, JSON fallback suggestion, streamed suggestion, and Blob transcription.

- [ ] **Step 1: Keep secrets local and support the Exo variable name**

Use this lookup order:

```js
const WORKER_URL =
  process.env.EXO_WORKER_URL ||
  process.env.CUE_WORKER_URL ||
  'https://cue-worker.jiazuo.workers.dev'

const SECRET_FILES = ['/tmp/exo-shared-secret.txt', '/tmp/cue-shared-secret.txt']
const secretFile = SECRET_FILES.find(path => existsSync(path))
const SHARED_SECRET =
  process.env.SHARED_SECRET ||
  (secretFile ? readFileSync(secretFile, 'utf8').trim() : '')
```

The missing-secret error must tell Evan to set `SHARED_SECRET` or write `/tmp/exo-shared-secret.txt`; it must never print the secret.

- [ ] **Step 2: Replace the obsolete WebSocket/date checks**

The JSON fallback request uses:

```js
fetch(`${args.url}/suggest?stream=0`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${args.bearer}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    mode: 'work',
    transcript: '請用一句話說明目前工作重點。',
    lang: 'zh',
    length: 'short',
  }),
})
```

The streaming request uses the same JSON body against `/suggest?stream=1`, reads `await response.text()`, and passes only when status is 200, content type contains `text/plain`, and the body is non-empty.

The transcription request posts a one-second silent PCM `Blob` to `/transcribe?lang=zh&gated=1` and passes when status is 200 and the JSON body contains an `ok` field.

Delete the entire `new WebSocket(...)` check.

- [ ] **Step 3: Verify syntax and the targeted contract**

Run: `node --check scripts/test-webkit.mjs`

Expected: exit 0.

Run: `npm test -- tests/tooling-contract.test.ts`

Expected: 3 tests pass.

- [ ] **Step 4: Run the full local verification set**

Run: `npm test`

Expected: all unit/JSDOM tests pass.

Run: `npm run test:worker`

Expected: 10 local Worker contract checks pass; real Deepgram/Anthropic calls may be skipped without `.dev.vars` keys.

Run the Vite server and simulator, then run: `npm run test:e2e`

Expected: 5 simulator regression checks pass.

- [ ] **Step 5: Have Evan run the live WebKit test without sharing the bearer**

Evan runs locally:

```bash
read -rsp 'SHARED_SECRET: ' SHARED_SECRET
printf '%s' "$SHARED_SECRET" > /tmp/exo-shared-secret.txt
unset SHARED_SECRET
chmod 600 /tmp/exo-shared-secret.txt
cd ~/projects/exo
npm run test:webkit
rm /tmp/exo-shared-secret.txt
```

Expected: health, JSON suggestion, streamed suggestion, and Blob transcription checks pass. Never paste the bearer into chat or commit it.

- [ ] **Step 6: Commit the maintenance fix**

```bash
git add tests/tooling-contract.test.ts worker-template/README.md scripts/regression.mjs scripts/test-webkit.mjs
git commit -m "test: align tooling with Exo HTTP transport"
```
