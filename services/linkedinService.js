require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { chromium } = require('playwright');
const crypto = require('crypto');
const { db } = require('../config/firebase');
const { getLaunchConfig } = require('./browserConfig');

puppeteer.use(StealthPlugin());

const IV_LENGTH = 16;
const activeSessions = {};

function getKey() {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) throw new Error('ENCRYPTION_KEY is not set in environment variables');
    if (Buffer.from(key).length !== 32) throw new Error('ENCRYPTION_KEY must be exactly 32 characters');
    return key;
}

function encrypt(text) {
    const key = getKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
    const key = getKey();
    const [ivHex, encryptedHex] = text.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const encryptedText = Buffer.from(encryptedHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}

function randomDelay(min = 500, max = 1500) {
    return new Promise(resolve =>
        setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min)
    );
}

function isFrameError(err) {
    if (!err) return false;
    const msg = err.message || String(err);
    return (
        msg.includes('detached Frame') ||
        msg.includes('Navigating frame was detached') ||
        msg.includes('Execution context was destroyed') ||
        msg.includes('Target closed') ||
        msg.includes('Session closed') ||
        msg.includes('Cannot find context') ||
        msg.includes('Attempted to use detached') ||
        msg.includes('Frame was detached')
    );
}

async function safeGoto(page, url, opts = {}) {
    const options = { waitUntil: 'domcontentloaded', timeout: 60000, ...opts };
    try {
        await page.goto(url, options);
        await randomDelay(2000, 3000);
        return true;
    } catch (err) {
        const msg = err.message || '';
        if (msg.includes('ERR_TOO_MANY_REDIRECTS')) {
            console.warn('   ⚠️ Redirect loop — clearing cookies and retrying');
            try {
                const cookies = await page.context().cookies().catch(() => []);
                for (const c of cookies) {
                    // Playwright: clear via context
                await page.context().clearCookies().catch(() => {});break;
                }
                await page.goto('https://www.linkedin.com', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                await randomDelay(3000, 5000);
                await page.goto(url, options);
                await randomDelay(2000, 3000);
                return true;
            } catch (retryErr) {
                console.warn(`   ⚠️ Retry failed: ${retryErr.message.slice(0, 60)}`);
                return false;
            }
        }
        console.warn(`   ⚠️ safeGoto error [${msg.slice(0, 100)}]`);
        await new Promise(r => setTimeout(r, 3000));
        return false;
    }
}

async function safeEval(page, fn, fallback = null, ...args) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return await page.evaluate(fn, ...args);
        } catch (err) {
            if (isFrameError(err)) {
                if (attempt === 0) {
                    await new Promise(r => setTimeout(r, 1500));
                    continue;
                }
                console.warn('   ⚠️ safeEval: frame error — returning fallback');
                return fallback;
            }
            throw err;
        }
    }
    return fallback;
}

async function safeUrl(page) {
    return await safeEval(page, () => window.location.href, '') || '';
}

async function isLoggedIn(page) {
    await randomDelay(2000, 3000);
    const url = await safeUrl(page);
    console.log('   ✅ Session URL:', url.slice(0, 80));
    return url.length > 0 &&
        !url.includes('/login') &&
        !url.includes('/authwall') &&
        !url.includes('/uas/') &&
        !url.includes('checkpoint');
}

async function fetchLinkedInUserData(page) {
    try {
        await randomDelay(2000, 3000);
        const data = await safeEval(page, () => {
            const imgSelectors = [
                'img.global-nav__me-photo',
                '.global-nav__me img',
                'img[class*="global-nav__me-photo"]',
                '.nav-item__profile-member-photo',
                'button[data-control-name="identity_welcome_message"] img',
                '.artdeco-entity-lockup__image img',
            ];
            let profileImage = null;
            for (const sel of imgSelectors) {
                const el = document.querySelector(sel);
                if (el && el.src && !el.src.includes('data:') && el.src.includes('licdn')) {
                    profileImage = el.src;
                    break;
                }
            }
            const nameSelectors = [
                '.global-nav__me-content .t-14',
                '.global-nav__me-content span[class*="t-"]',
                '[data-control-name="identity_welcome_message"] span',
            ];
            let displayName = null;
            for (const sel of nameSelectors) {
                const el = document.querySelector(sel);
                if (el && el.innerText?.trim()) { displayName = el.innerText.trim(); break; }
            }
            return { profileImage, displayName };
        }, { profileImage: null, displayName: null });
        console.log('📸 LinkedIn user data fetched:', data.displayName, data.profileImage ? '(image found)' : '(no image)');
        return data;
    } catch (err) {
        console.warn('⚠️ Could not fetch LinkedIn user data:', err.message);
        return { profileImage: null, displayName: null };
    }
}

// ── STEP 1 — Initiate LinkedIn login ─────────────────────────────────────────
async function initiateLinkedInLogin(uid, email, password) {
    // getLaunchConfig() returns headless:false locally so you see the browser.
    // Do NOT override headless here — let the config control it.
    const baseConfig = getLaunchConfig();
    const browser = await chromium.launch({
        headless: baseConfig.headless,
        args: [...(baseConfig.args || []), '--disable-infobars'],
    });

    try {
        // Playwright uses contexts — stealth script goes on context, not page
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            viewport: { width: 1280 + Math.floor(Math.random() * 120), height: 800 + Math.floor(Math.random() * 80) },
            locale: 'en-US',
            timezoneId: 'America/New_York',
            extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
        });

        // addInitScript replaces evaluateOnNewDocument in Playwright
        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
            Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
            window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
            delete navigator.__proto__.webdriver;
        });

        const page = await context.newPage();

        console.log('🌐 Navigating to LinkedIn...');
        await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await randomDelay(2000, 4000);

        // ── Take a screenshot-equivalent: log the page title and URL ─────────
        let pageTitle = '';
        try { pageTitle = await page.title(); } catch {}
        let pageUrl = '';
        try { pageUrl = page.url(); } catch {}
        console.log(`📄 Login page: "${pageTitle}" — ${pageUrl}`);

        // ── Wait for email field ──────────────────────────────────────────────
        const anyInput = '#username, input[name="session_key"], input[type="email"], input[autocomplete="username"]';
        try {
            await page.waitForSelector(anyInput, { timeout: 15000 });
            console.log('   ✅ Login form loaded');
        } catch {
            // Log page source snippet to understand what's on the page
            const bodySnippet = await safeEval(page, () => document.body.innerText.slice(0, 300), '');
            console.error('   ❌ Login form not found. Page says:', bodySnippet);
            await browser.close();
            return { success: false, message: 'LinkedIn login page did not load correctly. May be showing a CAPTCHA or bot detection page.' };
        }

        await randomDelay(800, 1500);

        // ── Find email field ──────────────────────────────────────────────────
        const emailSel = await safeEval(page, () => {
            const sels = ['#username', 'input[name="session_key"]', 'input[autocomplete="username"]', 'input[type="email"]'];
            for (const s of sels) { if (document.querySelector(s)) return s; }
            return null;
        }, null);

        if (!emailSel) {
            await browser.close();
            return { success: false, message: 'Could not find email field on LinkedIn login page' };
        }
        console.log(`   ✅ Email field: ${emailSel}`);

        // Use JS focus + type instead of page.click() — more reliable when
        // LinkedIn renders the input off-screen or with zero dimensions.
        await page.evaluate(sel => {
            const el = document.querySelector(sel);
            el.focus();
            el.click();
            el.value = '';
        }, emailSel).catch(() => {});
        await randomDelay(300, 600);
        // Type directly into the focused element via keyboard
        await page.focus(emailSel).catch(() => {});
        await page.keyboard.type(email, { delay: 80 + Math.random() * 60 });
        await randomDelay(500, 1000);

        // ── Find password field ───────────────────────────────────────────────
        const passSel = await safeEval(page, () => {
            const sels = ['#password', 'input[name="session_password"]', 'input[autocomplete="current-password"]', 'input[type="password"]'];
            for (const s of sels) { if (document.querySelector(s)) return s; }
            return null;
        }, null);

        if (!passSel) {
            await browser.close();
            return { success: false, message: 'Could not find password field on LinkedIn login page' };
        }
        console.log(`   ✅ Password field: ${passSel}`);

        await page.evaluate(sel => {
            const el = document.querySelector(sel);
            el.focus();
            el.click();
            el.value = '';
        }, passSel).catch(() => {});
        await randomDelay(300, 600);
        await page.focus(passSel).catch(() => {});
        await page.keyboard.type(password, { delay: 80 + Math.random() * 60 });
        await randomDelay(500, 1000);

        // ── Submit ────────────────────────────────────────────────────────────
        console.log('   ⏎ Submitting login...');
        await page.keyboard.press('Enter');

        // ── Poll for result ───────────────────────────────────────────────────
        let currentUrl = '';
        for (let attempt = 0; attempt < 20; attempt++) {
            await randomDelay(2000, 3000);
            currentUrl = await safeEval(page, () => window.location.href, '') || '';
            let title = '';
            try { title = await page.title(); } catch {}
            console.log(`📍 Poll ${attempt + 1}: ${currentUrl.slice(0, 80)} — "${title}"`);

            if (!currentUrl.includes('/login')) break;

            // If stuck on login after 5 polls, try clicking submit button directly
            if (attempt === 4) {
                console.warn('   ⚠️ Still on login after 5 polls — trying button click');
                const clicked = await safeEval(page, () => {
                    const btn = document.querySelector('[type=submit], button.btn__primary--large, .login__form_action_container button');
                    if (btn) { btn.click(); return true; }
                    return false;
                }, false);
                console.log(clicked ? '   ✅ Button clicked' : '   ❌ No button found');
            }

            // Log what's on the page if we're stuck
            if (attempt === 8) {
                const bodyText = await safeEval(page, () => document.body.innerText.slice(0, 500), '');
                console.warn('   📄 Page content after 8 polls:', bodyText.replace(/\n/g, ' '));
            }
        }

        console.log('📍 Final URL:', currentUrl);

        // ── Handle result ─────────────────────────────────────────────────────
        if (currentUrl.includes('/feed') || currentUrl.includes('/mynetwork') ||
            currentUrl.includes('/jobs') || currentUrl.includes('/home')) {
            const cookies = await context.cookies('https://www.linkedin.com');
            const liAt = cookies.find(c => c.name === 'li_at');
            if (liAt) {
                const encryptedCookie = encrypt(liAt.value);
                const { profileImage, displayName } = await fetchLinkedInUserData(page);
                await db.collection('users').doc(uid).update({
                    linkedinSession: encryptedCookie,
                    linkedinEmail: email,
                    linkedinConnectedAt: new Date().toISOString(),
                    ...(profileImage && { linkedinProfileImage: profileImage }),
                    ...(displayName && { linkedinDisplayName: displayName }),
                });
                await browser.close();
                return { success: true, message: 'LinkedIn connected successfully ✅' };
            }
            await browser.close();
            return { success: false, message: 'Logged in but could not extract session cookie' };
        }

        if (currentUrl.includes('checkpoint') || currentUrl.includes('verify') ||
            currentUrl.includes('pin') || currentUrl.includes('challenge') ||
            currentUrl.includes('captcha')) {
            console.log('🔐 OTP/verification page detected:', currentUrl);
            activeSessions[uid] = { browser, page };
            setTimeout(() => {
                if (activeSessions[uid]) {
                    activeSessions[uid].browser.close().catch(() => {});
                    delete activeSessions[uid];
                }
            }, 10 * 60 * 1000);
            return { success: false, requiresOtp: true, message: 'Verification required — submit the OTP to complete login' };
        }

        // Unknown state — log page content for debugging
        const pageContent = await safeEval(page, () => document.body.innerText.slice(0, 400), '');
        console.error('❌ Unexpected state. Page:', pageContent.replace(/\n/g, ' '));
        await browser.close();
        return { success: false, message: `Login failed. Ended on: ${currentUrl}. LinkedIn may be showing a CAPTCHA or blocking this IP.` };

    } catch (err) {
        console.error('❌ LinkedIn login error:', err.message);
        try { await browser.close(); } catch {}
        return { success: false, message: err.message };
    }
}

// ── STEP 2 — Submit OTP ───────────────────────────────────────────────────────
async function submitLinkedInOtp(uid, otp) {
    const session = activeSessions[uid];
    if (!session) return { success: false, message: 'Session expired. Please restart the login process.' };

    const { browser, page } = session;
    try {
        console.log('🔑 Submitting OTP...');

        const otpSelectors = [
            'input[name="pin"]', 'input[id="input__email_verification_pin"]',
            'input[autocomplete="one-time-code"]', 'input[aria-label*="verification"]',
            'input[aria-label*="pin"]', 'input[type="text"]', 'input[type="number"]'
        ];

        let otpInput = null;
        for (const selector of otpSelectors) {
            try {
                await page.waitForSelector(selector, { timeout: 3000 });
                const el = await page.$(selector);
                if (el) {
                    const isVisible = await page.evaluate(el => {
                        const rect = el.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0;
                    }, el).catch(() => false);
                    if (isVisible) { otpInput = selector; break; }
                }
            } catch { continue; }
        }

        if (!otpInput) {
            await browser.close(); delete activeSessions[uid];
            return { success: false, message: 'Could not find OTP input field' };
        }

        await page.evaluate((selector, otp) => {
            const input = document.querySelector(selector);
            input.focus(); input.value = otp;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }, otpInput, otp);

        await randomDelay(800, 1500);

        for (const selector of ['[type=submit]', 'button[aria-label*="verify"]', 'button:not([aria-label*="back"])']) {
            try {
                const btn = await page.$(selector);
                if (btn) { await btn.evaluate(b => b.click()); break; }
            } catch { continue; }
        }

        // Poll for success
        let currentUrl = '';
        for (let i = 0; i < 15; i++) {
            await randomDelay(2000, 3000);
            currentUrl = await safeEval(page, () => window.location.href, '') || '';
            if (currentUrl.includes('/feed') || currentUrl.includes('/mynetwork')) break;
        }

        if (!currentUrl.includes('/feed') && !currentUrl.includes('/mynetwork')) {
            await browser.close(); delete activeSessions[uid];
            return { success: false, message: `OTP verification failed. Ended on: ${currentUrl}` };
        }

        const cookies = await context.cookies('https://www.linkedin.com');
        const liAt = cookies.find(c => c.name === 'li_at');
        if (!liAt) {
            await browser.close(); delete activeSessions[uid];
            return { success: false, message: 'OTP accepted but could not extract session cookie' };
        }

        const encryptedCookie = encrypt(liAt.value);
        const { profileImage, displayName } = await fetchLinkedInUserData(page);
        await db.collection('users').doc(uid).update({
            linkedinSession: encryptedCookie,
            linkedinConnectedAt: new Date().toISOString(),
            ...(profileImage && { linkedinProfileImage: profileImage }),
            ...(displayName && { linkedinDisplayName: displayName }),
        });

        await browser.close(); delete activeSessions[uid];
        return { success: true, message: 'LinkedIn connected successfully ✅' };

    } catch (err) {
        console.error('❌ OTP error:', err.message);
        try { await browser.close(); } catch {}
        delete activeSessions[uid];
        return { success: false, message: err.message };
    }
}

// ── extractProfileData ────────────────────────────────────────────────────────
async function extractProfileData(page) {
    await randomDelay(3000, 4000);

    return await safeEval(page, () => {
        function pick(selectors, attr) {
            for (const sel of selectors) {
                try {
                    const els = document.querySelectorAll(sel);
                    for (const el of els) {
                        const val = attr === 'src' ? el.src
                            : attr === 'alt' ? el.alt
                            : (el.innerText || el.textContent || '').trim();
                        if (val && val.length > 1 && val.length < 300 && !val.includes('linkedin.com/in/')) {
                            return val.replace(/\n+/g, ' ').trim();
                        }
                    }
                } catch {}
            }
            return null;
        }

        const name = pick(['h1.text-heading-xlarge', 'h1.inline.t-24.v-align-middle.break-words', '.pv-top-card--list h1', '.ph5 h1', '.pv-top-card h1', 'h1[class*="text-heading"]', 'main h1']);
        const headline = pick(['.text-body-medium.break-words', '.pv-top-card--list .text-body-medium', '.ph5 .text-body-medium', '.mt2 .text-body-medium', 'h2.text-body-medium', '[class*="headline"]']);
        const location = pick(['.pb2 span.text-body-small.inline.t-black--light', '.pv-top-card--list-bullet .text-body-small', '.ph5 span.text-body-small:not(.visually-hidden)', 'span.text-body-small[aria-label*="location"]', '[class*="location"]']);
        const company = pick(['.pv-text-details__right-panel .hoverable-link-text span[aria-hidden="true"]', '.pv-text-details__right-panel span[aria-hidden="true"]', '#experience ~ div .pvs-entity:first-child span[aria-hidden="true"]', '.pv-top-card--experience-list span[aria-hidden="true"]', '.pv-entity__secondary-title']);
        const about = pick(['#about ~ div .inline-show-more-text span[aria-hidden="true"]', '#about ~ div span[aria-hidden="true"]', '#about + div span[aria-hidden="true"]', '.pv-about__summary-text', '[data-section="summary"] p']);
        const profileImage = pick(['img.pv-top-card-profile-picture__image--show', 'img.profile-photo-edit__preview', '.pv-top-card__photo img', 'img.EntityPhoto-circle-5', 'img[class*="EntityPhoto"]', 'img.evi-image', 'section.artdeco-card img[width="200"]'], 'src');

        // Fallback: raw text parsing
        let nameFb = null, headlineFb = null, locationFb = null;
        if (!name || !headline) {
            const lines = (document.body.innerText || '').split('\n').map(l => l.trim()).filter(l => l.length > 1 && l.length < 120);
            const noise = ['Try Premium', 'Join now', 'Sign in', 'Advertisement', 'Message', 'Connect', 'Follow', 'More', 'Pending', 'LinkedIn', 'She/her', 'He/him', 'They/them', '1st', '2nd', '3rd'];
            const isClean = l => l.length > 2 && !noise.some(n => l.includes(n));
            const fbIdx = lines.lastIndexOf('For Business');
            if (fbIdx !== -1) {
                let i = fbIdx + 1;
                while (i < lines.length && !isClean(lines[i])) i++;
                nameFb = lines[i] || null;
                headlineFb = lines[i + 1] || null;
                const actionIdx = lines.findIndex((l, idx) => idx > i && ['Message', 'Connect', 'Pending'].includes(l));
                if (actionIdx !== -1) {
                    for (let j = actionIdx + 1; j < Math.min(actionIdx + 8, lines.length); j++) {
                        const l = lines[j];
                        if (isClean(l) && l !== nameFb && l !== headlineFb && (l.includes(',') || l.includes('Area') || l.length < 35)) {
                            locationFb = l; break;
                        }
                    }
                }
            }
        }

        return {
            name: name || nameFb || null,
            headline: headline || headlineFb || null,
            location: location || locationFb || null,
            company: company || null,
            about: about || null,
            profileImage: profileImage || null,
        };
    }, { name: null, headline: null, location: null, company: null, about: null, profileImage: null });
}

// ── makeScrapePage ────────────────────────────────────────────────────────────
async function makeScrapePage(browser, liAt) {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    // Note: makeScrapePage now returns a page from a properly configured context
    return page;
}

// ── STEP 3 — scrapeLeads ──────────────────────────────────────────────────────
async function scrapeLeads(uid, encryptedCookie, searchUrl, campaignId, maxLeads = 25) {
    const liAt = decrypt(encryptedCookie);
    const browser = await chromium.launch(getLaunchConfig());

    try {
        // Create Playwright context with all settings
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 },
            locale: 'en-US',
            timezoneId: 'America/New_York',
            extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
        });

        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
            delete navigator.__proto__.webdriver;
        });

        // Block heavy resources via Playwright route
        await context.route('**/*', route => {
            const type = route.request().resourceType();
            const url  = route.request().url();
            if (['media', 'font'].includes(type)) { route.abort(); return; }
            if (type === 'image') {
                (url.includes('media.licdn.com') || url.includes('licdn.com'))
                    ? route.continue() : route.abort();
                return;
            }
            route.continue();
        });

        let page = await context.newPage();
        page.setDefaultTimeout(60000);
        page.setDefaultNavigationTimeout(60000);

        // ── Step 1: Load LinkedIn, clear stale cookies, set li_at ────────────
        console.log('🌐 Loading LinkedIn domain...');
        await safeGoto(page, 'https://www.linkedin.com', { timeout: 30000 });

        await context.clearCookies();
        await context.addCookies([{
            name: 'li_at', value: liAt,
            domain: '.linkedin.com', path: '/',
            httpOnly: true, secure: true, sameSite: 'None',
        }]);
        console.log('   🧹 Cleared stale cookies, set fresh li_at');

        // ── Step 2: Verify session ────────────────────────────────────────────
        console.log('🔐 Verifying LinkedIn session...');
        await safeGoto(page, 'https://www.linkedin.com/feed', { timeout: 60000 });

        const loggedIn = await isLoggedIn(page);
        if (!loggedIn) {
            await page.reload();
            const retryLoggedIn = await isLoggedIn(page);
            if (!retryLoggedIn) throw new Error('LinkedIn session expired. Please reconnect.');
        }
        console.log('✅ Session valid — proceeding to search');

        // ── Step 3: Collect profile URLs ──────────────────────────────────────
        console.log('🔍 Navigating to search URL...');

        const cleanSearchUrl = searchUrl
            .replace(/[&?]start=\d+/g, '').replace(/[&?]page=\d+/g, '')
            .replace(/[&?]position=\d+/g, '').replace(/&&+/g, '&')
            .replace(/\?&/, '?').replace(/&$/, '');
        console.log(`🔗 Search URL: ${cleanSearchUrl.slice(0, 120)}`);

        const allProfileUrls = new Set();
        let pageNum = 0;
        const MAX_SEARCH_PAGES = 3;

        while (allProfileUrls.size < maxLeads && pageNum < MAX_SEARCH_PAGES) {
            const paginatedUrl = `${cleanSearchUrl}&start=${pageNum * 10}`;
            console.log(`📄 Scraping search page ${pageNum + 1}: ${paginatedUrl}`);

            const navOk = await safeGoto(page, paginatedUrl, { timeout: 60000 });
            if (!navOk) {
                console.warn(`   ⚠️ Navigation failed on page ${pageNum + 1} — skipping`);
                await randomDelay(6000, 10000);
                pageNum++; continue;
            }

            // Wait for React to mount — try known selectors, fall through if none match
            let pageReady = false;
            const readySelectors = [
                'div[data-view-name="search-entity-result-universal-template"]',
                '.search-results-container',
                '.reusable-search__result-container',
                'a[href*="linkedin.com/in/"]',
                'a[href*="/in/"][class*="app-aware"]',
                'ul.reusable-search__entity-result-list',
                'div.entity-result',
                'li.reusable-search__result-container',
                'main', 'div[role="main"]',
            ];

            for (let attempt = 0; attempt < 8; attempt++) {
                let currentUrl = '';
                try { currentUrl = page.url(); } catch {}

                if (currentUrl.includes('chrome-error') || currentUrl === 'about:blank') {
                    console.warn('   ⚠️ Chrome error page — recreating page');
                    try { await page.close().catch(() => {}); } catch {}
                    // Recreate page within same context on dead frame
                try { await page.close().catch(() => {}); } catch {}
                page = await context.newPage();
                page.setDefaultTimeout(60000);
                await context.addCookies([{ name: 'li_at', value: liAt, domain: '.linkedin.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' }]);
                    break;
                }
                if (currentUrl.includes('/authwall') || currentUrl.includes('/login') || currentUrl.includes('checkpoint')) {
                    console.error('   ❌ Auth wall — stopping');
                    break;
                }

                for (const sel of readySelectors) {
                    try {
                        await page.waitForSelector(sel, { timeout: 3000 });
                        pageReady = true;
                        console.log(`   ✅ Page ready (${sel})`);
                        break;
                    } catch {}
                }

                if (pageReady) break;
                console.log(`   ⏳ Waiting for mount (attempt ${attempt + 1})`);
                await randomDelay(2000, 3000);
            }

            if (!pageReady) {
                console.warn('   ⚠️ No selector matched — trying extraction anyway');
            }

            let landedUrl = '';
            try { landedUrl = page.url(); } catch {}
            console.log(`   📍 Landed: ${landedUrl.slice(0, 100)}`);

            if (landedUrl.includes('/authwall') || landedUrl.includes('/login') || landedUrl.includes('checkpoint')) {
                console.error('   ❌ Auth wall — stopping'); break;
            }
            if (landedUrl.includes('chrome-error') || landedUrl === 'about:blank') {
                console.warn('   ⚠️ Dead frame — recreating page');
                try { await page.close().catch(() => {}); } catch {}
                // Recreate page within same context on dead frame
                try { await page.close().catch(() => {}); } catch {}
                page = await context.newPage();
                page.setDefaultTimeout(60000);
                await context.addCookies([{ name: 'li_at', value: liAt, domain: '.linkedin.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' }]);
                pageNum++; continue;
            }

            await safeEval(page, () => window.scrollBy(0, 700), null);
            await randomDelay(3000, 4000);
            await safeEval(page, () => window.scrollBy(0, 700), null);
            await randomDelay(3000, 4000);

            let pageUrls = [];
            try {
                pageUrls = await page.$$eval('a[href*="/in/"]', anchors => {
                    const links = new Set();
                    for (const el of anchors) {
                        const href = (el.href || '').split('?')[0].replace(/\/$/, '');
                        if (href && href.includes('linkedin.com/in/') && !href.includes('/in/undefined') && !href.endsWith('/in/'))
                            links.add(href);
                    }
                    return [...links];
                });
            } catch {
                pageUrls = await safeEval(page, () => {
                    const links = new Set();
                    document.querySelectorAll('a[href*="/in/"]').forEach(el => {
                        const href = el.href.split('?')[0].replace(/\/$/, '');
                        if (href && href.includes('linkedin.com/in/') && !href.includes('/in/undefined') && !href.endsWith('/in/'))
                            links.add(href);
                    });
                    return [...links];
                }, []);
            }

            console.log(`   Found ${pageUrls.length} profiles on page ${pageNum + 1}`);
            if (pageUrls.length === 0) { console.log('   No more results — stopping'); break; }
            pageUrls.forEach(url => allProfileUrls.add(url));
            pageNum++;
            await randomDelay(4000, 6000);
        }

        const profileUrls = [...allProfileUrls].slice(0, maxLeads);
        console.log(`📋 Total profiles found: ${profileUrls.length}`);

        if (profileUrls.length === 0) {
            await browser.close();
            throw new Error('No profiles found. Check if the URL is a valid LinkedIn people search.');
        }

        // ── Step 4: Scrape each profile ───────────────────────────────────────
        const leads = [];

        for (let i = 0; i < profileUrls.length; i++) {
            const profileUrl = profileUrls[i];
            console.log(`👤 Scraping profile ${i + 1}/${profileUrls.length}: ${profileUrl}`);

            try {
                await randomDelay(5000, 9000);
                const profOk = await safeGoto(page, profileUrl, { timeout: 60000 });
                if (!profOk) {
                    leads.push({ profileUrl, name: null, headline: null, location: null, company: null, about: null, profileImage: null });
                    continue;
                }

                const currentUrl = await safeUrl(page);
                if (currentUrl.includes('/authwall') || currentUrl.includes('/login') || currentUrl.includes('checkpoint')) {
                    console.warn(`⚠️ Auth wall at profile ${i + 1} — stopping`); break;
                }

                await randomDelay(6000, 10000);
                for (const amount of [400, 500, 400, 500]) {
                    await safeEval(page, a => window.scrollBy(0, a), null, amount);
                    await randomDelay(1500, 2500);
                }
                await safeEval(page, () => window.scrollTo(0, 0), null);
                await randomDelay(1000, 2000);

                const profileData = await extractProfileData(page);
                console.log(`   ✅ name=${profileData.name || 'null'} company=${profileData.company || 'null'}`);

                if (!profileData.name) {
                    const title = await safeEval(page, () => document.title, '');
                    const landed = await safeUrl(page);
                    console.warn(`   ⚠️ No name. Title="${title}" URL=${landed.slice(0, 80)}`);
                }

                leads.push({ profileUrl, ...profileData });
            } catch (err) {
                console.warn(`⚠️ Profile ${i + 1} error: ${err.message.slice(0, 80)}`);
                leads.push({ profileUrl, name: null, headline: null, location: null, company: null, about: null, profileImage: null });
            }
        }

        // ── Step 5: Save to Firestore ─────────────────────────────────────────
        if (leads.length > 0) {
            const batch = db.batch();
            leads.forEach(lead => {
                const ref = db.collection('leads').doc();
                batch.set(ref, {
                    campaignId, userId: uid,
                    profileUrl: lead.profileUrl || null, name: lead.name || null,
                    headline: lead.headline || null, location: lead.location || null,
                    company: lead.company || null, about: lead.about || null,
                    profileImage: lead.profileImage || null,
                    status: 'pending', createdAt: new Date().toISOString()
                });
            });
            await batch.commit();
            console.log(`💾 Saved ${leads.length} leads to Firestore`);
        }

        await browser.close();
        return leads;

    } catch (err) {
        console.error('❌ scrapeLeads error:', err.message);
        try { await browser.close(); } catch {}
        throw err;
    }
}

module.exports = { initiateLinkedInLogin, submitLinkedInOtp, scrapeLeads, decrypt };