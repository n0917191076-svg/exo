#!/usr/bin/env node
// Drill into a specific project on hub.evenrealities.com/hub and capture
// the upload-build flow DOM. Reuses .hub-portal-session.json from inspect-hub.mjs.
//
// Usage:
//   node scripts/inspect-hub-project.mjs Glance      # match by visible project name
//
// Captures three snapshots so we can write upload-dev.mjs against real DOM:
//   inspect-hub-project.list.html        — the list page (already known but re-saved for reference)
//   inspect-hub-project.detail.html      — clicked into the chosen project
//   inspect-hub-project.upload.html      — the upload modal/dialog after clicking "Upload build"
//
// Plus inspect-hub-project.summary.txt with the visible buttons / inputs / dialogs at each step.

import { chromium } from 'playwright-core'
import { existsSync, writeFileSync } from 'node:fs'

const HUB_URL = 'https://hub.evenrealities.com/hub'
const STORAGE_STATE = `${process.env.HOME}/.hub-portal-session.json`
const projectName = process.argv[2] ?? 'Glance'

if (!existsSync(STORAGE_STATE)) {
  console.error(`✗ Run scripts/inspect-hub.mjs first to create ${STORAGE_STATE}.`)
  process.exit(2)
}

async function snapshotControls(page) {
  return await page.evaluate(() => {
    function trim(s) { return (s ?? '').replace(/\s+/g, ' ').trim() }
    function isVisible(el) {
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
    }
    const out = []
    const sel = 'button, a, input[type="submit"], input[type="file"], [role="button"], [role="dialog"], [aria-haspopup], [class*="cursor-pointer" i]'
    for (const el of document.querySelectorAll(sel)) {
      if (!isVisible(el)) continue
      out.push({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type'),
        role: el.getAttribute('role'),
        text: trim(el.textContent ?? '').slice(0, 80),
        ariaLabel: el.getAttribute('aria-label'),
        ariaHaspopup: el.getAttribute('aria-haspopup'),
        dataTest: el.getAttribute('data-test') ?? el.getAttribute('data-testid'),
        id: el.getAttribute('id'),
        cls: (el.getAttribute('class') ?? '').slice(0, 100),
      })
    }
    return out
  })
}

function controlsBlock(label, controls) {
  return [
    `─── ${label} (${controls.length}) ───`,
    ...controls.map(c => {
      const bits = [c.tag]
      if (c.type) bits.push(`type=${c.type}`)
      if (c.role) bits.push(`role=${c.role}`)
      if (c.dataTest) bits.push(`data-test=${c.dataTest}`)
      if (c.ariaHaspopup) bits.push(`aria-haspopup=${c.ariaHaspopup}`)
      if (c.id) bits.push(`id=${c.id}`)
      if (c.cls) bits.push(`class="${c.cls}"`)
      const head = `  ${bits.join(' ')}`
      const txt = c.text ? `\n    text=${JSON.stringify(c.text)}` : ''
      return `${head}${txt}`
    }),
  ]
}

async function main() {
  console.log(`→ Drilling into project: ${projectName}`)
  const browser = await chromium.launch({ headless: false })
  const context = await browser.newContext({ storageState: STORAGE_STATE })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)

  await page.goto(HUB_URL, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1_500)

  writeFileSync('inspect-hub-project.list.html', await page.content())
  const listControls = await snapshotControls(page)

  // Click the project card matching the name. Card layout shows the project
  // name inside `<div class="font-normal font-desktop-body-medium">Glance</div>`.
  // Click the GRID ITEM div above it (group/er-grid-item).
  console.log(`  Locating project card for "${projectName}"…`)
  const card = page.locator(`.group\\/er-grid-item:has(div:text("${projectName}"))`).first()
  await card.waitFor({ state: 'visible', timeout: 10_000 })
  await card.click()
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(2_000)

  console.log(`  Now at: ${page.url()}`)
  writeFileSync('inspect-hub-project.detail.html', await page.content())
  const detailControls = await snapshotControls(page)

  // Look for an upload-build button on the detail page.
  console.log(`  Looking for upload-build trigger…`)
  const uploadCandidates = [
    'button:has-text("Upload build")',
    'button:has-text("Upload package")',
    'button:has-text("Upload")',
    'button:has-text("New version")',
    'button:has-text("New build")',
    '[data-test="upload-build"]',
  ]
  let uploadClicked = false
  for (const sel of uploadCandidates) {
    const btn = page.locator(sel).first()
    if (await btn.isVisible({ timeout: 1_500 }).catch(() => false)) {
      console.log(`    matched: ${sel}`)
      await btn.click()
      uploadClicked = true
      break
    }
  }
  if (!uploadClicked) {
    console.log(`    (no upload button surfaced on the detail page)`)
  } else {
    await page.waitForTimeout(2_500)
  }

  writeFileSync('inspect-hub-project.upload.html', await page.content())
  const uploadControls = await snapshotControls(page)
  console.log(`  Final URL: ${page.url()}`)

  const summary = [
    `Project: ${projectName}`,
    `Final URL: ${page.url()}`,
    '',
    ...controlsBlock('LIST page controls', listControls),
    '',
    ...controlsBlock('PROJECT-DETAIL page controls', detailControls),
    '',
    ...controlsBlock(uploadClicked ? 'AFTER clicking Upload trigger' : 'After (no upload click attempted)', uploadControls),
  ].join('\n')
  writeFileSync('inspect-hub-project.summary.txt', summary)
  console.log(`✓ Wrote inspect-hub-project.summary.txt (${summary.length} chars)`)
  console.log(`✓ Wrote inspect-hub-project.detail.html (${(await page.content()).length} bytes)`)

  await browser.close()
}

main().catch(err => {
  console.error('✗ Failed:', err.message)
  process.exit(1)
})
