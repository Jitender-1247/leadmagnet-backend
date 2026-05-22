/**
 * Humandelay.js
 * Gaussian (Box-Muller) random delays that mimic real human timing.
 * No external dependencies — works with both Puppeteer and Playwright.
 */

function gaussianSample() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function gaussianDelay(mean, std, min = 0, max = Infinity) {
  const sample = mean + gaussianSample() * std;
  return Math.max(min, Math.min(max, Math.round(sample)));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const typingDelay   = () => gaussianDelay(120,  40,  40,  400);
const clickDelay    = () => gaussianDelay(800,  250, 300, 2500);
const readingDelay  = () => gaussianDelay(2500, 800, 1000, 6000);
const thinkingDelay = () => gaussianDelay(4000, 1200, 1500, 9000);
const longBreak     = () => gaussianDelay(12000, 3000, 6000, 22000);

/**
 * Type text into a Playwright page character-by-character with human timing.
 * Pass the Playwright `page` object — no element handle needed.
 * @param {import('playwright').Page} page
 * @param {string} text
 */
async function humanType(page, text) {
  for (const char of text) {
    await page.keyboard.type(char, { delay: typingDelay() });
  }
}

/**
 * Occasionally inject a long break (~1 in every `frequency` calls).
 */
async function maybeBreak(frequency = 8) {
  if (Math.random() < 1 / frequency) {
    console.log(`[delay] Long break: ~${Math.round(longBreak() / 1000)}s`);
    await sleep(longBreak());
  } else {
    await sleep(thinkingDelay());
  }
}

module.exports = {
  gaussianDelay,
  sleep,
  typingDelay,
  clickDelay,
  readingDelay,
  thinkingDelay,
  longBreak,
  humanType,
  maybeBreak,
};