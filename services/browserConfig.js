/**
 * browserConfig.js — Playwright version
 * LOCAL DEV: browser window opens so you can watch what's happening.
 *            Set HEADLESS=true in .env to force headless locally.
 * RAILWAY:   always headless (detected via env vars).
 */

const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_SERVICE_NAME;
const IS_RENDER  = !!process.env.RENDER;
const IS_SERVER  = IS_RAILWAY || IS_RENDER || process.env.NODE_ENV === 'production';

function getLaunchConfig() {
  const headless = IS_SERVER || process.env.HEADLESS === 'true';

  if (!IS_SERVER) {
    console.log('[browser] 🖥  Running in LOCAL mode —', headless ? 'headless' : 'browser window will open');
    if (!headless) console.log('[browser]    Set HEADLESS=true in .env to run headless locally');
  }

  return {
    headless,
    args: [
      '--no-sandbox',
      '--single-process',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process,BlockInsecurePrivateNetworkRequests',
      '--disable-site-isolation-trials',
      '--disable-web-security',
      '--window-size=1280,800',
      '--disable-http2',
      '--ignore-certificate-errors',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-first-run',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--js-flags=--max-old-space-size=512',
      ...(IS_SERVER ? ['--single-process', '--no-zygote'] : []),
    ],
  };
}

module.exports = { getLaunchConfig, IS_SERVER };