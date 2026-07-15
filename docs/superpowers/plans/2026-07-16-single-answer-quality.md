# Single-Answer Response Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Exo mode return one substantive, directly speakable answer with explicit length and anti-fabrication rules, while preserving the existing low-latency Worker stream and safe G2 rendering path.

**Architecture:** Keep the external `{ suggestions: string[] }` contract for compatibility, but normalize every successful response to exactly one element. Move Worker prompt assembly into a focused pure module so mode, length, language, KB ordering, and factual constraints can be tested without calling an LLM. Keep `src/even.ts` untouched; update `main.ts` to render one unnumbered answer and wrap long Chinese/English paragraphs before applying the existing 512-byte tail window.

**Tech Stack:** TypeScript 5.9, Vite 8, Vitest 4, Cloudflare Workers/Wrangler 3, Anthropic Messages API streaming, Even Hub SDK 0.0.12.

## Global Constraints

- `work`、`daily`、`custom` all return one complete answer; no `1. 2. 3.` alternatives.
- Chinese lengths: short 80–120 characters, medium 180–240, long 320–420.
- English lengths, excluding the translation line: short 30–45 words, medium 70–100, long 130–170.
- English mode is exactly one `譯：<中文翻譯>` line plus one complete CEFR-B1 English answer.
- Use 2–4 relevant English terms only when they improve the answer; never keyword-stuff.
- General professional knowledge is allowed. Hypothetical examples must be labelled `例如`.
- Never claim Evan or a company performed, validated, or improved something unless transcript, scene note, or mounted KB says so; never invent precise metrics.
- Keep the public Worker response type as `{ suggestions: string[] }`; successful new-version responses contain exactly one element.
- Keep HTTP chunked streaming, the 300ms glasses throttle, and `src/even.ts` `enqueue()` unchanged.
- Keep the conservative 512-byte tail window. Do not add swipe paging in this change.
- Do not add dependencies, upgrade packages, restructure unrelated files, or put any API key/token in source, tests, fixtures, logs, or commits.
- After every implementation change, run the relevant focused test and `npm test`; a red test blocks the next task.
- Use one focused commit per task.

## File Responsibility Map

- Create `worker-template/suggestion-policy.ts`: pure Worker-side mode/prompt assembly and model-text-to-single-answer normalization.
- Create `tests/suggestion-policy.test.ts`: deterministic prompt, ordering, length, language, fact-boundary, and Worker normalization tests.
- Modify `worker-template/index.ts`: consume the pure policy, return one answer, reject empty model text, and raise token ceilings for the approved long lengths.
- Modify `src/modes.ts`: mirror the built-in work/daily single-answer wording used by the phone UI and existing mode tests.
- Modify `src/utterance.ts`: add Plugin-side single-answer normalization and paragraph wrapping for the G2 text window.
- Modify `src/transport.ts`: normalize streamed and JSON suggestion responses to one answer and reject empty responses.
- Modify `src/main.ts`: remove final numbering/prefixes, render the single answer, preserve extension flow, and feed wrapped lines into the existing byte window.
- Modify `src/mock.ts`: replace reactive multi-suggestion fixtures with one complete answer per mode.
- Modify `scripts/dev-worker.mjs`: make local JSON and text-stream fixtures match production's one-answer shape.
- Modify `tests/modes.test.ts`, `tests/utterance.test.ts`, `tests/transport.test.ts`, `tests/mock.test.ts`, `tests/dev-worker.test.ts`, and `tests/audio.bridge.test.ts`: lock the new contract at each boundary.
- Do not modify `src/even.ts`.

---

### Task 1: Build and Test the Worker Prompt Policy

**Files:**
- Create: `worker-template/suggestion-policy.ts`
- Create: `tests/suggestion-policy.test.ts`
- Modify: `worker-template/index.ts:197-268`
- Modify: `src/modes.ts:18-60`
- Modify: `tests/modes.test.ts:42-53`

**Interfaces:**
- Consumes: the existing `/suggest` body fields `mode`, `customPrompt`, `recentSuggestions`, `sceneNote`, `length`, `lang`, `kbPersonal`, `kbExtra`, and `extendContext`.
- Produces: `buildSuggestPrompt(input: SuggestPromptInput): { systemPrompt: string; lang: SuggestLanguage }` for `worker-template/index.ts`.
- Produces: the unchanged `Mode.systemPrompt: string` mirror for work/daily phone metadata.

- [ ] **Step 1: Write the failing Worker prompt tests**

Create `tests/suggestion-policy.test.ts` with these concrete assertions:

```ts
import { describe, expect, it } from 'vitest'
import { buildSuggestPrompt } from '../worker-template/suggestion-policy'

describe('single-answer Worker prompt policy', () => {
  it.each(['work', 'daily', 'custom'])('%s enforces one unnumbered answer', mode => {
    const { systemPrompt } = buildSuggestPrompt({
      mode,
      customPrompt: mode === 'custom' ? '你是一位策略顧問，語氣直接。' : undefined,
    })
    expect(systemPrompt).toMatch(/只輸出一個完整答案/)
    expect(systemPrompt).toMatch(/不使用.*編號|不要.*編號/)
    expect(systemPrompt).toMatch(/可直接照著念/)
  })

  it('keeps a custom role but appends the non-overridable common contract', () => {
    const { systemPrompt } = buildSuggestPrompt({
      mode: 'custom',
      customPrompt: '你是一位策略顧問，使用商業分析語氣。',
    })
    expect(systemPrompt.indexOf('你是一位策略顧問')).toBeLessThan(systemPrompt.indexOf('【回答契約】'))
    expect(systemPrompt).toMatch(/只輸出一個完整答案/)
    expect(systemPrompt).toMatch(/不得聲稱.*我.*我們.*公司|不得.*做過.*驗證過/)
  })

  it('orders mode, scene, KB, contract, length, language, then dedupe', () => {
    const { systemPrompt } = buildSuggestPrompt({
      mode: 'work',
      sceneNote: '董事會簡報',
      kbPersonal: '個人資料標記',
      kbExtra: '補充資料標記',
      length: 'medium',
      lang: 'en',
      recentSuggestions: ['上一個完整回答'],
    })
    const markers = [
      '工作場合',
      '【目前場景】董事會簡報',
      '【個人資訊】',
      '【補充資料】',
      '【回答契約】',
      '70–100 words',
      '譯：',
      '【最近回答】',
    ]
    for (let i = 1; i < markers.length; i += 1) {
      expect(systemPrompt.indexOf(markers[i - 1]!)).toBeLessThan(systemPrompt.indexOf(markers[i]!))
    }
  })

  it.each([
    ['short', '80–120 個中文字'],
    ['medium', '180–240 個中文字'],
    ['long', '320–420 個中文字'],
  ])('maps Chinese %s length', (length, expected) => {
    expect(buildSuggestPrompt({ mode: 'work', lang: 'zh', length }).systemPrompt).toContain(expected)
  })

  it.each([
    ['short', '30–45 words'],
    ['medium', '70–100 words'],
    ['long', '130–170 words'],
  ])('maps English %s length', (length, expected) => {
    const prompt = buildSuggestPrompt({ mode: 'work', lang: 'en', length }).systemPrompt
    expect(prompt).toContain(expected)
    expect(prompt).toMatch(/第一行.*譯：/)
    expect(prompt).toMatch(/一個完整英文回答/)
    expect(prompt).toMatch(/CEFR B1/)
  })

  it('states the factual boundary and hypothetical-example marker', () => {
    const { systemPrompt } = buildSuggestPrompt({ mode: 'work' })
    expect(systemPrompt).toMatch(/通用專業知識/)
    expect(systemPrompt).toMatch(/例如/)
    expect(systemPrompt).toMatch(/不得.*具體.*數字|不得.*精確.*數據/)
    expect(systemPrompt).toMatch(/逐字稿.*場景.*知識庫/)
  })
})
```

- [ ] **Step 2: Replace the old mode test with a failing single-answer assertion**

In `tests/modes.test.ts`, replace the old `2–3 條` test with:

```ts
it('非 custom 模式的 systemPrompt 是繁中且含單一完整回答規則', () => {
  for (const m of MODES.filter(x => x.id !== 'custom')) {
    expect(m.systemPrompt).toMatch(/只輸出一個完整答案/)
    expect(m.systemPrompt).toMatch(/不使用.*編號|不要.*編號/)
    expect(m.systemPrompt).toMatch(/先結論|直接.*判斷|直接.*立場/)
    expect(m.systemPrompt).toMatch(/照著念/)
  }
})
```

- [ ] **Step 3: Run the focused tests and verify the red state**

Run:

```bash
npm test -- tests/suggestion-policy.test.ts tests/modes.test.ts
```

Expected: FAIL because `worker-template/suggestion-policy.ts` does not exist and `src/modes.ts` still requires 2–3 suggestions.

- [ ] **Step 4: Implement the pure Worker policy**

Create `worker-template/suggestion-policy.ts` with this complete public surface and assembly order:

```ts
export type SuggestLanguage = 'zh' | 'en'

export interface SuggestPromptInput {
  mode?: string
  customPrompt?: string
  recentSuggestions?: string[]
  sceneNote?: string
  length?: string
  lang?: string
  kbPersonal?: string
  kbExtra?: string
  extendContext?: string
}

const BASE_PROMPTS: Record<'work' | 'daily' | 'custom', string> = {
  work:
    '你是使用者的即時對話助手。逐字稿是對方剛說的話，請替使用者形成下一段可直接說出口的回答。' +
    '情境是工作場合（面試、會議、簡報），回答要專業、有結構、有明確觀點。' +
    '不用「我覺得」「可能」「應該吧」等無意義猶疑語；描述真實經歷時可自然使用 STAR，但不要硬套。',
  daily:
    '你是使用者的即時對話助手。逐字稿是對方剛說的話，請替使用者形成下一段可直接說出口的回答。' +
    '情境是日常交談，語氣自然、口語、像真人聊天，但仍要回答實質內容，不用空泛附和。',
  custom:
    '你是使用者的即時對話助手。逐字稿是對方剛說的話，請形成一段可直接說出口、內容完整的回答。',
}

const COMMON_CONTRACT = `

【回答契約】
只輸出一個完整答案，不使用編號、標題、前言或多個選項；整段必須可直接照著念。
開頭 1–2 句直接提出判斷或立場，不要只重述問題。後續依題目說明原因、機制、影響、演進或例子，形成連續論述。
題目適合時，自然加入 2–4 個相關英文術語，但不得堆砌；適合時在結尾補一個關鍵風險或落地條件，不要硬塞正反兩面。
可以使用通用專業知識。假設案例必須明確使用「例如」標示。
只有逐字稿、目前場景或知識庫明確提供時，才可聲稱我、我們或公司做過、驗證過或達成某結果；不得虛構經歷、成果、百分比或其他具體數字。
資料不足時改談機制、原則、條件或風險，不得為湊字數重複或虛構。`

const LENGTH_RULES: Record<string, { zh: string; en: string }> = {
  short: {
    zh: '單一答案全文以 80–120 個中文字為目標。',
    en: 'The single English answer should be 30–45 words, excluding the translation line.',
  },
  medium: {
    zh: '單一答案全文以 180–240 個中文字為目標。',
    en: 'The single English answer should be 70–100 words, excluding the translation line.',
  },
  long: {
    zh: '單一答案全文以 320–420 個中文字為目標。',
    en: 'The single English answer should be 130–170 words, excluding the translation line.',
  },
}

function tailTruncate(value: string, max: number): string {
  return value.length > max ? value.slice(value.length - max) : value
}

function normalizedMode(mode?: string): 'work' | 'daily' | 'custom' {
  if (mode === 'daily' || mode === 'custom') return mode
  return 'work'
}

export function buildSuggestPrompt(input: SuggestPromptInput): {
  systemPrompt: string
  lang: SuggestLanguage
} {
  const mode = normalizedMode(input.mode)
  const lang: SuggestLanguage = input.lang === 'en' ? 'en' : 'zh'
  const custom = input.customPrompt?.trim() ?? ''
  const base = mode === 'custom' && custom ? custom : BASE_PROMPTS[mode]
  const scene = input.sceneNote?.trim()
    ? `\n\n【目前場景】${input.sceneNote.trim()}`
    : ''
  const personal = tailTruncate((input.kbPersonal ?? '').trim(), 6000)
  const extra = tailTruncate((input.kbExtra ?? '').trim(), 6000)
  const kb =
    (personal ? `\n\n【個人資訊】\n${personal}` : '') +
    (extra ? `\n\n【補充資料】\n${extra}` : '')
  const extend = input.extendContext?.trim()
    ? `\n\n【延伸要求】\n請在以下回答基礎上接續深入，不要重複已說內容：\n${input.extendContext.trim()}`
    : ''
  const length = LENGTH_RULES[input.length ?? 'medium'] ?? LENGTH_RULES.medium!
  const lengthBlock = `\n\n【長度】${lang === 'en' ? length.en : length.zh}`
  const language = lang === 'en'
    ? '\n\n【英文格式】第一行必須是「譯：<對方那句話的中文翻譯>」。空一行後，只輸出一個完整英文回答；使用 CEFR B1 以內詞彙與句型。'
    : ''
  const recent = (input.recentSuggestions ?? [])
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .slice(-12)
  const dedupe = recent.length
    ? `\n\n【最近回答】\n${recent.map(item => `- ${item}`).join('\n')}\n避免逐字或近似重複，改用不同分析角度。`
    : ''

  return {
    lang,
    systemPrompt: base + scene + kb + extend + COMMON_CONTRACT + lengthBlock + language + dedupe,
  }
}
```

- [ ] **Step 5: Wire the Worker to the pure policy**

At the top of `worker-template/index.ts`, add:

```ts
import { buildSuggestPrompt } from './suggestion-policy'
```

Inside `handleSuggest`, replace the block from `const baseSystem` through construction of `systemPrompt` with:

```ts
const { systemPrompt, lang } = buildSuggestPrompt({
  mode: body.mode,
  customPrompt: body.customPrompt,
  recentSuggestions: body.recentSuggestions,
  sceneNote: body.sceneNote,
  length: body.length,
  lang: body.lang,
  kbPersonal: body.kbPersonal,
  kbExtra: body.kbExtra,
  extendContext: body.extendContext,
})
```

Delete the now-unused local `tailTruncate`, `systemPromptForMode`, `LENGTH_RULES`, scene/KB/extend/language/dedupe assembly, and their stale numbered-list comments. Keep model allowlisting and stream selection unchanged.

- [ ] **Step 6: Mirror the built-in contract in `src/modes.ts`**

Replace `COMMON_RULES` with:

```ts
const COMMON_RULES =
  '輸出規則：只輸出一個完整答案，不使用編號、標題、前言或多個選項；整段可直接照著念。' +
  '開頭直接提出判斷或立場，不只重述問題；後續說明原因、機制、影響、演進或例子。' +
  '可使用通用專業知識；假設案例必須標示「例如」。' +
  '除非逐字稿、場景或知識庫明確提供，不得聲稱我、我們或公司做過、驗證過或達成具體數字。'
```

Keep the existing work interview/STAR wording and daily tone wording. Keep `custom.systemPrompt` empty because the Worker appends the non-overridable contract after the stored custom prompt.

- [ ] **Step 7: Run focused and full tests**

Run:

```bash
npm test -- tests/suggestion-policy.test.ts tests/modes.test.ts
npm test
```

Expected: both commands PASS; the full run reports zero failed test files and zero failed tests.

- [ ] **Step 8: Commit the prompt policy**

```bash
git add worker-template/suggestion-policy.ts worker-template/index.ts src/modes.ts tests/suggestion-policy.test.ts tests/modes.test.ts
git commit -m "feat: enforce single-answer prompt policy"
```

---

### Task 2: Normalize Worker and Plugin Responses to One Answer

**Files:**
- Modify: `worker-template/suggestion-policy.ts`
- Modify: `worker-template/index.ts:276-430`
- Modify: `src/utterance.ts:229-248`
- Modify: `src/transport.ts:1,309-381`
- Modify: `tests/suggestion-policy.test.ts`
- Modify: `tests/utterance.test.ts:171-191`
- Modify: `tests/transport.test.ts:279-325`

**Interfaces:**
- Produces Worker helper: `singleAnswerFromText(text: string): string[]`.
- Produces Plugin helpers: `singleAnswerFromText(text: string): string[]` and `normalizeSuggestionArray(items: string[]): string[]`.
- Preserves `CueTransport.requestSuggestions*` return type; successful responses now contain one element.

- [ ] **Step 1: Add failing normalization tests**

In `tests/suggestion-policy.test.ts`, replace the existing policy import with:

```ts
import { buildSuggestPrompt, singleAnswerFromText } from '../worker-template/suggestion-policy'
```

Then append:

```ts
describe('Worker single-answer normalization', () => {
  it('keeps all model text as one answer even if it contains numbered lines', () => {
    expect(singleAnswerFromText('1. 第一段\n2. 第二段')).toEqual(['1. 第一段\n2. 第二段'])
  })

  it('rejects whitespace-only model text', () => {
    expect(singleAnswerFromText(' \n ')).toEqual([])
  })
})
```

Add to `tests/utterance.test.ts` and include both new imports:

```ts
describe('Plugin single-answer normalization', () => {
  it('wraps a full multiline response as exactly one element', () => {
    expect(singleAnswerFromText('譯：你好\n\nHello, it is good to meet you.')).toEqual([
      '譯：你好\n\nHello, it is good to meet you.',
    ])
  })

  it('joins a legacy Worker array without adding numbering', () => {
    expect(normalizeSuggestionArray(['甲', '乙'])).toEqual(['甲\n乙'])
  })

  it('rejects empty text and empty legacy arrays', () => {
    expect(singleAnswerFromText('   ')).toEqual([])
    expect(normalizeSuggestionArray([' ', ''])).toEqual([])
  })
})
```

- [ ] **Step 2: Change the transport expectations to the one-answer contract**

In `tests/transport.test.ts`, change the stream test body and final assertions to:

```ts
it('串流回應：onDelta 遞增累積、結束保留單一完整答案、streamed=true', async () => {
  const fetchSpy = vi.fn(async () => streamResponse([
    '我認為這個轉變是從 READ ONLY ',
    '走向 TAKE ACTION，核心是模型與工具整合。',
  ]))
  globalThis.fetch = fetchSpy as unknown as typeof fetch
  const t = createTransport('https://cue.example.workers.dev', 'secret')
  const deltas: string[] = []
  const r = await t.requestSuggestionsStream(
    { mode: 'work', transcript: '你怎麼看 AI Agent？' },
    { onDelta: acc => deltas.push(acc) },
  )
  expect(deltas.at(-1)).toBe('我認為這個轉變是從 READ ONLY 走向 TAKE ACTION，核心是模型與工具整合。')
  expect(r).toEqual({
    ok: true,
    streamed: true,
    suggestions: ['我認為這個轉變是從 READ ONLY 走向 TAKE ACTION，核心是模型與工具整合。'],
  })
})
```

Change both legacy JSON-array expectations to the one-answer contract:

- In the non-stream `requestSuggestions` test, change `['First', 'Second', 'Third']` to `['First\nSecond\nThird']`.
- In the stream method's JSON fallback test, change `['甲', '乙']` to `['甲\n乙']`.

Then add:

```ts
it('空白串流回應 → ok:false', async () => {
  globalThis.fetch = vi.fn(async () => streamResponse([' ', '\n'])) as unknown as typeof fetch
  const t = createTransport('https://cue.example.workers.dev', 'secret')
  const r = await t.requestSuggestionsStream(
    { mode: 'work', transcript: 'hi' },
    { onDelta: () => {} },
  )
  expect(r).toEqual({ ok: false, error: 'empty suggestion response' })
})
```

- [ ] **Step 3: Run focused tests and verify the red state**

```bash
npm test -- tests/suggestion-policy.test.ts tests/utterance.test.ts tests/transport.test.ts
```

Expected: FAIL because the normalization helpers do not exist and transport still calls `parseNumberedList`.

- [ ] **Step 4: Implement the normalization helpers**

Append to `worker-template/suggestion-policy.ts`:

```ts
export function singleAnswerFromText(text: string): string[] {
  const answer = text.trim()
  return answer ? [answer] : []
}
```

Add to `src/utterance.ts` next to the old list parser:

```ts
export function singleAnswerFromText(text: string): string[] {
  const answer = text.trim()
  return answer ? [answer] : []
}

export function normalizeSuggestionArray(items: string[]): string[] {
  return singleAnswerFromText(
    items
      .filter(item => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean)
      .join('\n'),
  )
}
```

Leave `parseNumberedList` exported for legacy tests/utilities, but remove its use from the production `/suggest` transport path.

- [ ] **Step 5: Normalize both Plugin transport paths**

Change the `src/transport.ts` import to:

```ts
import { normalizeSuggestionArray, singleAnswerFromText } from './utterance'
```

In `requestSuggestions`, after decoding JSON, use:

```ts
if (!json.ok) return json
const suggestions = normalizeSuggestionArray(json.suggestions)
return suggestions.length > 0
  ? { ok: true as const, suggestions }
  : { ok: false as const, error: 'empty suggestion response' }
```

In the JSON branch of `requestSuggestionsStream`, use:

```ts
if (!json.ok) return json
const suggestions = normalizeSuggestionArray(json.suggestions)
return suggestions.length > 0
  ? { ok: true as const, suggestions, streamed: false as const }
  : { ok: false as const, error: 'empty suggestion response' }
```

At the end of the text stream, replace `parseNumberedList(accumulated)` with:

```ts
const suggestions = singleAnswerFromText(accumulated)
return suggestions.length > 0
  ? { ok: true as const, suggestions, streamed: true as const }
  : { ok: false as const, error: 'empty suggestion response' }
```

- [ ] **Step 6: Normalize Worker fallback output and raise output ceilings**

Import the helper in `worker-template/index.ts`:

```ts
import { buildSuggestPrompt, singleAnswerFromText } from './suggestion-policy'
```

In both Anthropic request bodies, change `max_tokens` from `400` to `1024`. In the OpenAI fallback, change `max_tokens` from `200` to `1024`.

In `callAnthropic`, replace the numbered-list response with:

```ts
const text = json.content?.[0]?.text ?? ''
const suggestions = singleAnswerFromText(text)
return suggestions.length > 0
  ? jsonResponse(200, { ok: true, suggestions })
  : jsonResponse(502, { ok: false, error: 'anthropic returned empty text' })
```

In `callOpenAI`, use the same shape with error text `openai returned empty text`:

```ts
const text = json.choices?.[0]?.message?.content ?? ''
const suggestions = singleAnswerFromText(text)
return suggestions.length > 0
  ? jsonResponse(200, { ok: true, suggestions })
  : jsonResponse(502, { ok: false, error: 'openai returned empty text' })
```

Delete the Worker-local `parseNumberedList` function. The stream function continues forwarding raw `text_delta` chunks; the Plugin detects a completely empty stream.

- [ ] **Step 7: Run focused and full tests**

```bash
npm test -- tests/suggestion-policy.test.ts tests/utterance.test.ts tests/transport.test.ts
npm test
```

Expected: both commands PASS with zero failures.

- [ ] **Step 8: Commit the response contract**

```bash
git add worker-template/suggestion-policy.ts worker-template/index.ts src/utterance.ts src/transport.ts tests/suggestion-policy.test.ts tests/utterance.test.ts tests/transport.test.ts
git commit -m "feat: normalize suggestions to one complete answer"
```

---

### Task 3: Render and Simulate One Long Unnumbered Answer

**Files:**
- Modify: `src/utterance.ts:95-150`
- Modify: `src/main.ts:160-170,695-815,987-1022,1219-1235`
- Modify: `src/mock.ts`
- Modify: `scripts/dev-worker.mjs`
- Modify: `tests/utterance.test.ts`
- Modify: `tests/audio.bridge.test.ts:389-442,554-590`
- Modify: `tests/mock.test.ts`
- Modify: `tests/dev-worker.test.ts:64-107,141-150`

**Interfaces:**
- Produces: `wrapAnswerLines(text: string, width: number): string[]` for `main.ts`.
- Consumes: Task 2's one-element `suggestions` array.
- Preserves: `EvenRuntime.render(text)` and the existing `fitTailByBytes`/300ms throttle contract.

- [ ] **Step 1: Add failing paragraph-wrap tests**

Add to `tests/utterance.test.ts`:

```ts
describe('wrapAnswerLines', () => {
  it('chunks a Chinese paragraph without losing characters', () => {
    const text = '甲'.repeat(85)
    const lines = wrapAnswerLines(text, 38)
    expect(lines).toHaveLength(3)
    expect(lines.every(line => line.length <= 38)).toBe(true)
    expect(lines.join('')).toBe(text)
  })

  it('wraps English on a word boundary when possible', () => {
    const lines = wrapAnswerLines('READ ONLY becomes TAKE ACTION through connected tools', 20)
    expect(lines.every(line => line.length <= 20)).toBe(true)
    expect(lines.join(' ')).toBe('READ ONLY becomes TAKE ACTION through connected tools')
  })

  it('preserves one blank separator between translation and English answer', () => {
    expect(wrapAnswerLines('譯：你好\n\nHello there.', 38)).toEqual([
      '譯：你好',
      '',
      'Hello there.',
    ])
  })
})
```

- [ ] **Step 2: Update the bridge tests to describe the final behavior**

In the streaming test in `tests/audio.bridge.test.ts`, stream a single response:

```ts
controller.enqueue(encoder.encode('我認為 Agent 的演進，是從 READ ONLY '))
void gate.then(() => {
  controller.enqueue(encoder.encode('走向 TAKE ACTION，讓模型可以透過 MCP 與 API 執行任務。'))
  controller.close()
})
```

After releasing the second chunk, assert:

```ts
expect(liveEl.textContent).toBe(
  '我認為 Agent 的演進，是從 READ ONLY 走向 TAKE ACTION，讓模型可以透過 MCP 與 API 執行任務。',
)
expect(fake.lastRender()).not.toMatch(/1\.[■●★]/)
expect(fake.lastRender()).toContain('TAKE ACTION')
```

Replace the old 30-suggestion tail-window fixture with one long paragraph ending in a unique suffix:

```ts
const longAnswer = `${'這是一段有內容的專業分析。'.repeat(30)}唯一尾端標記`
```

Assert after the answer render:

```ts
const rendered = fake.lastRender()
expect(new TextEncoder().encode(rendered).length).toBeLessThanOrEqual(512)
expect(rendered).toContain('唯一尾端標記')
expect(rendered).not.toMatch(/1\.[■●★]/)
```

- [ ] **Step 3: Update mock/dev-worker tests to fail on the old three-item shape**

In `tests/mock.test.ts`, add `expect(ex.suggestions).toHaveLength(1)` inside the per-mode loop.

In `tests/dev-worker.test.ts`, change work, daily, unknown-mode, and real-transport expectations from length 3 to length 1. Replace the stream test with:

```ts
it('POST /suggest（預設）以 text/plain 串流出一個未編號完整回答', async () => {
  const r = await fetch(`${baseUrl}/suggest`, {
    method: 'POST',
    headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'work', transcript: '請自我介紹' }),
  })
  expect(r.status).toBe(200)
  expect(r.headers.get('content-type') ?? '').toContain('text/plain')
  const text = await r.text()
  expect(text.trim().length).toBeGreaterThan(40)
  expect(text).not.toMatch(/^\s*\d+[.)]\s/m)
})
```

- [ ] **Step 4: Run focused tests and verify the red state**

```bash
npm test -- tests/utterance.test.ts tests/audio.bridge.test.ts tests/mock.test.ts tests/dev-worker.test.ts
```

Expected: FAIL because paragraph wrapping does not exist, UI still prefixes answers, and fixtures still contain multiple suggestions.

- [ ] **Step 5: Implement paragraph wrapping**

Add this pure function to `src/utterance.ts`:

```ts
export function wrapAnswerLines(text: string, width: number): string[] {
  if (width <= 0) return []
  const lines: string[] = []

  for (const raw of text.split(/\r?\n/)) {
    let rest = raw.trim()
    if (!rest) {
      if (lines.length > 0 && lines.at(-1) !== '') lines.push('')
      continue
    }
    while (rest.length > width) {
      const candidate = rest.slice(0, width + 1)
      const boundary = candidate.lastIndexOf(' ')
      const cut = boundary > 0 ? boundary : width
      lines.push(rest.slice(0, cut).trimEnd())
      rest = rest.slice(cut).trimStart()
    }
    if (rest) lines.push(rest)
  }

  return lines
}
```

- [ ] **Step 6: Remove numbering from all main UI completion paths**

Import `wrapAnswerLines` in `src/main.ts` and make `currentAnswerText`:

```ts
function currentAnswerText(): string {
  if (extendedText) return extendedText
  return suggestions.join('\n')
}
```

Delete `SUGGESTION_MAX_LINES`, `MODE_BULLET`, and `emphasizeFirstWord`; they encode the obsolete three-short-suggestion layout.

In the mic-off answer view, replace the `trunc(ln, 76)` input with:

```ts
const answerLines = fitTailByBytes(
  wrapAnswerLines(currentAnswerText(), LINE_WIDTH),
  budget,
)
```

In the live view, replace numbered suggestion prefixes with one byte-budgeted answer area. Build the existing transcript/diagnostic lines first, then use:

```ts
const footer = mode.proactiveSupported
  ? '> 單擊 送出   > 雙擊 取消   > 戒指雙擊 話題'
  : '> 單擊 送出   > 雙擊 取消'
lines.push('')
lines.push('─'.repeat(20))
if (suggestions.length > 0) {
  const reserved = new TextEncoder().encode([...lines, '', footer].join('\n')).length + 1
  const budget = Math.max(0, GLASSES_CONTENT_MAX_BYTES - reserved)
  lines.push(...fitTailByBytes(
    wrapAnswerLines(currentAnswerText(), LINE_WIDTH),
    budget,
  ))
} else {
  lines.push('(answer appears here)')
}
lines.push('')
lines.push(footer)
```

In `runExtend`, change the JSON fallback from numbered mapping to:

```ts
const finalPart = result.streamed && lastAcc
  ? lastAcc
  : result.suggestions.join('\n')
```

In `maybeRequestSuggestions`, change final DOM rendering to:

```ts
liveSuggestionsEl.textContent = result.suggestions.join('\n')
suggestions = result.suggestions
```

Apply the same unnumbered join to the earlier completion path around `main.ts:1017`.

- [ ] **Step 7: Replace reactive mock fixtures with one complete answer**

Keep `suggestionsByMode` typed as `string[]` for compatibility, but make every reactive fixture array contain one paragraph. For example, the first work fixture becomes:

```ts
work: [
  '我是葉家佐，有八年製造產線督導經驗，也持續累積數據分析與金融風控能力。我曾以 Stacking 集成模型拿下輔大 AI 投資競賽第一名，並取得 WorldQuant Gold；我希望把現場異常管理、量化分析與風險意識，轉化成金融後台或數據職務的實際價值。',
],
```

Make daily and custom fixtures one substantive paragraph as well. Do not change `PROACTIVE_TOPICS_BY_MODE`; proactive rescue topics are a separate interaction, not `/suggest` alternatives.

In `scripts/dev-worker.mjs`, make each `SUGGEST_FIXTURES` value a one-element array. For the stream path, replace the numbered mapping with:

```js
const full = suggestions[0]
```

Update comments from `3-tuple`/`3 條編號建議` to `one complete answer`/`單一完整回答`.

Update the custom prompt placeholder in `src/main.ts` from a 2–3-response example to:

```html
placeholder="描述角色、立場與語氣；Exo 會套用單一完整回答與事實規則。"
```

- [ ] **Step 8: Run focused and full verification**

```bash
npm test -- tests/utterance.test.ts tests/audio.bridge.test.ts tests/mock.test.ts tests/dev-worker.test.ts
npm test
npm run build
```

Expected: all focused tests PASS, the full suite has zero failures, and TypeScript/Vite build exits 0.

- [ ] **Step 9: Commit the UI and fixtures**

```bash
git add src/utterance.ts src/main.ts src/mock.ts scripts/dev-worker.mjs tests/utterance.test.ts tests/audio.bridge.test.ts tests/mock.test.ts tests/dev-worker.test.ts
git commit -m "feat: render one complete unnumbered answer"
```

---

### Task 4: Verify, Deploy, and Run the G2 Acceptance Test

**Files:**
- Verify only: all files changed in Tasks 1–3
- Generated artifact: `exo.ehpk` from the existing pack script
- External deployment: Cloudflare Worker `cue-worker`
- Real device: Even App + G2 via the existing QR URL `http://192.168.1.102:5176`

**Interfaces:**
- Consumes: the three reviewed commits from Tasks 1–3.
- Produces: deployed `/suggest` single-answer behavior and a recorded handoff of the G2 acceptance result.

- [ ] **Step 1: Run the full local verification gate**

```bash
npm test
npm run build
npm run lint:app-json
npm run test:worker
npm run pack
```

Expected:

- Vitest reports zero failed test files and zero failed tests.
- TypeScript/Vite build exits 0.
- `lint:app-json` exits 0 with the real Worker whitelist.
- Worker offline tests report all cases passed.
- `exo.ehpk` is generated successfully.

- [ ] **Step 2: Run the simulator regression**

Confirm Vite is listening on `0.0.0.0:5176` and the existing simulator automation port is available, then run:

```bash
npm run test:e2e
```

Expected: all simulator regression checks pass. If the known stale-HMR quirk appears, stop only the simulator process, relaunch it against `http://localhost:5176`, and rerun the same command; do not change application code to mask the environment issue.

- [ ] **Step 3: Deploy the Worker**

```bash
cd worker-template
npx wrangler deploy
cd ..
```

Expected: Wrangler reports a successful deployment for `cue-worker`; no secret value is printed.

- [ ] **Step 4: Verify the deployed health and authenticated one-answer JSON path**

Run from WSL without printing the bearer value:

```bash
curl -fsS https://cue-worker.jiazuo.workers.dev/healthz
```

Expected: `{"ok":true}` or the currently documented healthy equivalent.

Then run:

```bash
cd worker-template
set -a
source .dev.vars
curl -fsS 'https://cue-worker.jiazuo.workers.dev/suggest?stream=0' \
  -H "Authorization: Bearer $SHARED_SECRET" \
  -H 'Content-Type: application/json' \
  --data '{"mode":"work","transcript":"現在人們期待 AI Agent 能在企業裡實際執行任務、串工具，你怎麼看這個轉變？","length":"medium","lang":"zh"}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const a=j.suggestions?.[0]??"";if(!j.ok||!Array.isArray(j.suggestions)||j.suggestions.length!==1||/^\s*\d+[.)]\s/m.test(a))process.exit(1);console.log(JSON.stringify({ok:j.ok,answers:j.suggestions.length,characters:[...a].length,answer:a},null,2))})'
unset SHARED_SECRET
cd ..
```

Expected: `ok: true`, `answers: 1`, no numbered prefix, and one substantive answer. Manually reject the result if it invents a company validation, percentage, or personal achievement absent from the request/KB.

- [ ] **Step 5: Force a fresh Even App load**

Because the Even WKWebView can retain stale Vite HMR handlers, close the current Exo page and rescan/reopen the existing QR URL:

```bash
npx evenhub qr --url http://192.168.1.102:5176 --external --scale 8
```

Expected: Even App opens the current Vite build. Keep the phone and PC on the same LAN; the already configured `5176` Windows-to-WSL port proxy must still target the current WSL IP.

- [ ] **Step 6: Run Evan's G2 acceptance question**

On the phone, select:

- Mode: `工作`
- Language: `中文`
- Length: `中`
- Model: `Sonnet（預設，聰明）`

Start gated recording, ask exactly:

```text
現在人們期待 AI Agent 能夠在企業裡面實際幫我們執行任務、去串工具、做到很多事情，你怎麼看這個轉變？
```

Stop recording and verify every condition:

- Exactly one answer; no `1. 2. 3.`.
- Roughly 180–240 Chinese characters; completeness and factual accuracy take priority over hitting the lower bound.
- Opens with a position instead of paraphrasing the question.
- Explains the transition from question-answering/`READ ONLY` to action/`TAKE ACTION` or an equally coherent professional framework.
- Uses 2–4 relevant terms such as `LLM`, `MCP`, `API`, or `human-in-the-loop`, without keyword stuffing.
- Does not claim Evan or a company validated a workflow and does not invent a percentage.
- Adds one relevant deployment condition when natural, such as permissions, observability, or human oversight.
- Phone retains the full text.
- G2 text streams without BLE disconnect; final view contains the answer tail rather than a two-line numbered suggestion.

- [ ] **Step 7: Record the verification handoff**

In the final handoff message, report:

```text
Automated: npm test / build / app-json lint / worker offline / pack / simulator
Deployed: cue-worker deployment result and authenticated suggestions=1 probe
G2: question used, observed character count, no numbering, no fabricated metrics, BLE result
Known display behavior: phone keeps full text; glasses retain the conservative 512-byte tail window
```

Do not claim G2 acceptance until Evan confirms the actual glasses output. If the answer quality misses one criterion, capture only the failed criterion, adjust the smallest relevant prompt rule with a failing deterministic test first, rerun Task 1 and Task 4 verification, and create a focused follow-up commit.
