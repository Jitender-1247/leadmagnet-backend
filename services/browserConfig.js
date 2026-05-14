/**
 * browserConfig.js
 * Finds Chrome automatically across all environments:
 * - Railway (primary)
 * - Render.com
 * - Local Mac / Windows / Linux
 */

const fs   = require('fs');
const path = require('path');

function findChrome() {

  // ── 1. Railway — Nixpacks installs system Chromium ───────────────────────
  // Railway uses Nix, so Chromium is at the system level
  const railwayPaths = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/run/current-system/sw/bin/chromium',
    '/nix/var/nix/profiles/default/bin/chromium',
  ];

  for (const p of railwayPaths) {
    if (fs.existsSync(p)) {
      console.log(`[browser] ✅ Railway Chrome found at: ${p}`);
      return p;
    }
  }

  // ── 2. Puppeteer downloaded Chrome (Railway fallback) ────────────────────
  try {
    const home = process.env.HOME || '/root';
    const base = path.join(home, '.cache', 'puppeteer', 'chrome');
    if (fs.existsSync(base)) {
      const versions = fs.readdirSync(base)
        .filter(d => d.startsWith('linux-'))
        .sort().reverse();
      for (const v of versions) {
        const p = path.join(base, v, 'chrome-linux64', 'chrome');
        if (fs.existsSync(p)) {
          console.log(`[browser] ✅ Puppeteer Chrome found at: ${p}`);
          return p;
        }
      }
    }
  } catch {}

  // ── 3. Render.com — scan cache directory ─────────────────────────────────
  try {
    const base = '/opt/render/.cache/puppeteer/chrome';
    if (fs.existsSync(base)) {
      const versions = fs.readdirSync(base)
        .filter(d => d.startsWith('linux-'))
        .sort().reverse();
      for (const v of versions) {
        const p = path.join(base, v, 'chrome-linux64', 'chrome');
        if (fs.existsSync(p)) {
          console.log(`[browser] ✅ Render Chrome found at: ${p}`);
          return p;
        }
      }
    }
  } catch {}

  // ── 4. Mac local dev ──────────────────────────────────────────────────────
  const macPaths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const p of macPaths) {
    if (fs.existsSync(p)) {
      console.log(`[browser] ✅ Mac Chrome found at: ${p}`);
      return p;
    }
  }

  // ── 5. Windows local dev ──────────────────────────────────────────────────
  const winPaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of winPaths) {
    try {
      if (fs.existsSync(p)) {
        console.log(`[browser] ✅ Windows Chrome found at: ${p}`);
        return p;
      }
    } catch {}
  }

  console.log('[browser] ⚠️  No Chrome found — letting Puppeteer auto-detect');
  return undefined;
}

function getLaunchConfig(extraArgs = []) {
  const executablePath = findChrome();

  return {
    headless: 'new',
    ...(executablePath && { executablePath }),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-web-security',
      '--window-size=1280,800',
      ...extraArgs,
    ],
    defaultViewport: null,
  };
}

module.exports = { getLaunchConfig, findChrome };