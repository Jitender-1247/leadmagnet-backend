/**
 * humanDelay.js
 * Gaussian (Box-Muller) random delays that mimic real human timing.
 * No external dependencies.
 */

/**
 * Box-Muller transform → standard normal sample
 */
function gaussianSample() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Returns a delay (ms) sampled from N(mean, std), clamped to [min, max].
 * @param {number} mean  - centre of the distribution in ms
 * @param {number} std   - spread; ~68% of samples fall within mean ± std
 * @param {number} min   - hard floor (ms)
 * @param {number} max   - hard ceiling (ms)
 */
function gaussianDelay(mean, std, min = 0, max = Infinity) {
  const sample = mean + gaussianSample() * std;
  return Math.max(min, Math.min(max, Math.round(sample)));
}

/** Await a gaussian delay */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Preset profiles ────────────────────────────────────────────────────────

/** Between keystrokes while typing (fast typist with natural jitter) */
const typingDelay    = () => gaussianDelay(120,  40,  40,  400);

/** After clicking a button / link before next action */
const clickDelay     = () => gaussianDelay(800,  250, 300, 2500);

/** Page-load "reading" pause before interacting */
const readingDelay   = () => gaussianDelay(2500, 800, 1000, 6000);

/** Between separate tasks / scrolls (longer think time) */
const thinkingDelay  = () => gaussianDelay(4000, 1200, 1500, 9000);

/** Occasional long break (simulates user distracted / reading carefully) */
const longBreak      = () => gaussianDelay(12000, 3000, 6000, 22000);

/**
 * Type text into a Puppeteer element character-by-character with human timing.
 * @param {import('puppeteer').ElementHandle} el
 * @param {string} text
 */
async function humanType(el, text) {
  for (const char of text) {
    await el.type(char, { delay: 0 }); // we control delay ourselves
    await sleep(typingDelay());
  }
}

/**
 * Occasionally inject a long break (~1 in every `frequency` calls).
 * Call this between major actions.
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