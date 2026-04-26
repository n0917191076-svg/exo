#!/usr/bin/env node
// Playwright-driven .ehpk upload to https://hub.evenrealities.com/application.
//
// Why this exists: the Even Hub developer portal has no public upload API
// (the evenhub CLI only exposes init/login/qr/pack/self-check; the portal's
// SPA POSTs to an undocumented endpoint). This script automates the
// click-through flow so `npm run deploy:upload` can do it from CI or
// scripts after build → pack.
//
// Generic by design: reads `package_id` from `./app.json` and the .ehpk
// path from the first .ehpk in repo root (or --file). Same script works
// for Cue, Pulse, Glance, lyrics-glow without per-app forks.
//
// First-time setup (run once per dev machine):
//   npm install --save-dev playwright
//   npx playwright install chromium                  # ~150 MB one-time
//
// First-time login:
//   node scripts/deploy-portal.mjs                   # opens visible browser
//   → log into hub.evenrealities.com manually in that window
//   → press Enter back in the terminal when you're at the portal
//   → cookies saved to .even-portal-session.json (gitignored)
//   → all subsequent runs reuse the session
//
// Usage:
//   node scripts/deploy-portal.mjs                   # uploads ./<package-id-suffix>.ehpk
//   node scripts/deploy-portal.mjs path/to/x.ehpk    # explicit file
//   node scripts/deploy-portal.mjs --headless        # CI-friendly (after first login)
//
// Selector audit: the SPA's DOM changes occasionally. Each `// SELECTOR:`
// comment below marks a click site to inspect via DevTools if the run
// breaks. Update inline and commit.

import { chromium } from 'playwright'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const PORTAL_BASE = 'https://hub.evenrealities.com'
const STORAGE_STATE = '.even-portal-session.json' // gitignored
const APP_JSON = 'app.json'

if (!existsSync(APP_JSON)) {
  console.error(`✗ ${APP_JSON} not found — run from your app's repo root.`)
  process.exit(1)
}
const appJson = JSON.parse(readFileSync(APP_JSON, 'utf-8'))
const packageId = appJson.package_id
if (!packageId) {
  console.error(`✗ ${APP_JSON} has no package_id field.`)
  process.exit(1)
}

const args = process.argv.slice(2)
const headless = args.includes('--headless')
const ehpkArg = args.find(a => a.endsWith('.ehpk'))
const ehpkPath = ehpkArg
  ? resolve(ehpkArg)
  : resolve(readdirSync('.').find(f => f.endsWith('.ehpk')) ?? 'unknown.ehpk')

if (!existsSync(ehpkPath)) {
  console.error(`✗ .ehpk not found: ${ehpkPath}`)
  console.error('  Run `npm run deploy` first, or pass an explicit path.')
  process.exit(1)
}

async function main() {
  console.log(`→ App      ${packageId}`)
  console.log(`  File     ${ehpkPath}`)
  console.log(`  Headless ${headless}`)
  const browser = await chromium.launch({ headless })
  const context = existsSync(STORAGE_STATE)
    ? await browser.newContext({ storageState: STORAGE_STATE })
    : await browser.newContext()
  const page = await context.newPage()

  // 1. Land on portal — if not logged in, we'll get bounced.
  await page.goto(`${PORTAL_BASE}/application/${packageId}`, { waitUntil: 'networkidle' }).catch(() => {})

  // 2. Detect login state. We assume the URL keeps `/application/<id>` once
  // logged in; anything else means we got bounced to login.
  const onAppPage = () => page.url().includes(`/application/${packageId}`)
  if (!onAppPage()) {
    if (headless) {
      console.error('✗ --headless cannot be used for first login. Re-run without --headless.')
      process.exit(2)
    }
    console.log('  No saved session — log into the portal manually in the open window.')
    console.log('  Once you reach the application page, return here and press Enter.')
    await waitForEnter()
    await context.storageState({ path: STORAGE_STATE })
    console.log(`  Session saved to ${STORAGE_STATE}`)
    if (!onAppPage()) {
      await page.goto(`${PORTAL_BASE}/application/${packageId}`, { waitUntil: 'networkidle' })
    }
  }

  // 3. Open the upload UI. The portal usually has an "Upload new version" or
  // "+ Upload" button on the application page.
  // SELECTOR: upload-trigger button. Try multiple text variants — update
  // after first inspection if the portal renames anything.
  const uploadBtn = page
    .locator('button:has-text("Upload"), button:has-text("New version"), button:has-text("Upload new version"), [data-test="upload-button"]')
    .first()
  await uploadBtn.waitFor({ state: 'visible', timeout: 10_000 })
  await uploadBtn.click()

  // 4. The file picker. Playwright handles the native dialog when you set
  // the file input directly — works whether the UI has a hidden
  // <input type=file> or a custom drop zone.
  // SELECTOR: file input. Most SPA implementations use a hidden
  // <input type=file accept=".ehpk">.
  const fileInput = page.locator('input[type="file"]').first()
  await fileInput.waitFor({ state: 'attached', timeout: 5_000 })
  await fileInput.setInputFiles(ehpkPath)

  // 5. Submit. May be auto-uploaded on file pick, or require a confirm click.
  // SELECTOR: confirm/submit button after file pick. If the portal
  // auto-uploads on selection this branch silently no-ops.
  const confirmBtn = page
    .locator('button:has-text("Submit"), button:has-text("Confirm"), button:has-text("Upload")')
    .last()
  if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await confirmBtn.click()
  }

  // 6. Wait for some success signal. The portal usually shows a toast or
  // updates the version list. We accept anything matching success-y words.
  // SELECTOR: success toast / version-list update.
  await page
    .waitForSelector('text=/uploaded|success|version/i', { timeout: 30_000 })
    .catch(() => {
      console.warn('  No success signal seen within 30s — upload may still have worked. Check the portal.')
    })

  console.log('✓ Upload submitted. Verify in the portal.')
  await context.storageState({ path: STORAGE_STATE })
  await browser.close()
}

function waitForEnter() {
  return new Promise(resolveFn => {
    process.stdin.once('data', () => resolveFn())
    process.stdout.write('  Press Enter when ready... ')
  })
}

main().catch(err => {
  console.error('✗ Deploy failed:', err.message)
  process.exit(1)
})
