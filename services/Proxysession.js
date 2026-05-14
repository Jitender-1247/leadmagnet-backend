/**
 * proxySession.js
 *
 * Builds sticky residential proxy launch args for Puppeteer.
 * Each userId gets a deterministic sessionId → same residential exit IP
 * for the entire campaign (Option B sticky session).
 *
 * Supports: Bright Data, Oxylabs, Smartproxy
 *
 * .env vars required:
 *   PROXY_HOST     e.g. brd.superproxy.io
 *   PROXY_PORT     e.g. 22225
 *   PROXY_USER     e.g. brd-customer-XXXX-zone-residential
 *   PROXY_PASS     your proxy password
 *   PROXY_COUNTRY  e.g. us  (optional, defaults to us)
 *   PROXY_ENABLED  set to "true" to activate (leave unset in dev)
 */

require('dotenv').config();

const PROXY_HOST    = process.env.PROXY_HOST    || 'brd.superproxy.io';
const PROXY_PORT    = process.env.PROXY_PORT    || '22225';
const PROXY_USER    = process.env.PROXY_USER    || '';
const PROXY_PASS    = process.env.PROXY_PASS    || '';
const PROXY_COUNTRY = process.env.PROXY_COUNTRY || 'us';
const PROXY_ENABLED = process.env.PROXY_ENABLED === 'true';

/**
 * Build a sticky session username.
 * The sessionId pins you to the same residential exit IP.
 * To rotate IP for a user: bump version (e.g. v1 → v2).
 */
function buildUsername(userId, version = 'v1') {
    // Bright Data format:
    return `${PROXY_USER}-session-u${userId}${version}-country-${PROXY_COUNTRY}`;

    // Oxylabs — uncomment if using Oxylabs:
    // return `customer-${PROXY_USER}-sessid-u${userId}${version}-country-${PROXY_COUNTRY}`;

    // Smartproxy — uncomment if using Smartproxy:
    // return `user-${PROXY_USER}-sessionid-u${userId}${version}-country-${PROXY_COUNTRY}`;
}

/**
 * Returns proxy CLI args + credentials for a given user.
 * @param {string} userId
 * @param {string} [version='v1']  bump to rotate IP
 * @returns {{ args: string[], username: string, password: string }}
 */
function buildStickyProxyArgs(userId, version = 'v1') {
    if (!PROXY_ENABLED || !PROXY_USER || !PROXY_PASS) {
        if (!PROXY_ENABLED) console.log('[proxy] PROXY_ENABLED is not true — running without proxy');
        return { args: [], username: '', password: '' };
    }

    const username = buildUsername(userId, version);
    const proxyUrl = `${PROXY_HOST}:${PROXY_PORT}`;

    console.log(`[proxy] User ${userId} → session ${username} via ${proxyUrl}`);

    return {
        args: [`--proxy-server=http://${proxyUrl}`],
        username,
        password: PROXY_PASS,
    };
}

/**
 * Authenticate the proxy on a Puppeteer page.
 * Call right after browser.newPage().
 * @param {import('puppeteer').Page} page
 * @param {{ username: string, password: string }} auth
 */
async function authenticatePage(page, { username, password }) {
    if (!username || !password) return;
    await page.authenticate({ username, password });
}

module.exports = { buildStickyProxyArgs, authenticatePage };