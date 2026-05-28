require('dotenv').config();
const { chromium } = require('playwright');
const crypto = require('crypto');
const { db } = require('../config/firebase');
const { getLaunchConfig } = require('./browserConfig');

const IV_LENGTH = 16;
const activeSessions = {};

// ── Crypto ────────────────────────────────────────────────────────────────────
function getKey() {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) throw new Error('ENCRYPTION_KEY is not set');
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
    return new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min));
}

// ── Stealth script injected into every new page ───────────────────────────────
const STEALTH_SCRIPT = () => {
    Object.defineProperty(navigator, 'webdriver',         { get: () => false });
    Object.defineProperty(navigator, 'plugins',           { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages',         { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'hardwareConcurrency',{ get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory',      { get: () => 8 });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    delete navigator.__proto__.webdriver;
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Helper: create a Playwright context with stealth settings ─────────────────
async function newStealthContext(browser, extraOpts = {}) {
    const context = await browser.newContext({
        userAgent: UA,
        viewport: {
            width:  1280 + Math.floor(Math.random() * 120),
            height: 800  + Math.floor(Math.random() * 80),
        },
        locale: 'en-US',
        timezoneId: 'America/New_York',
        extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
        ...extraOpts,
    });
    // Playwright equivalent of puppeteer.evaluateOnNewDocument
    await context.addInitScript(STEALTH_SCRIPT);
    return context;
}

// ── Safe goto — handles redirects, uses page.context() for cookies ────────────
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
                // Playwright: use page.context() to access cookies
                await page.context().clearCookies();
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
        await randomDelay(3000, 3000);
        return false;
    }
}

async function safeEval(page, fn, fallback = null, arg = undefined) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            // Playwright page.evaluate() takes a single optional arg
            return arg !== undefined
                ? await page.evaluate(fn, arg)
                : await page.evaluate(fn);
        } catch (err) {
            const msg = err.message || '';
            if (
                msg.includes('detached') || msg.includes('Target closed') ||
                msg.includes('Execution context') || msg.includes('Session closed')
            ) {
                if (attempt === 0) { await randomDelay(1500, 1500); continue; }
                console.warn('   ⚠️ safeEval: context error — returning fallback');
                return fallback;
            }
            throw err;
        }
    }
    return fallback;
}

async function safeUrl(page) {
    try { return page.url(); } catch { return ''; }
}

async function isLoggedIn(page) {
    await randomDelay(2000, 3000);
    const url = safeUrl(page);
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
        const data = await page.evaluate(() => {
            const imgSels = [
                'img.global-nav__me-photo',
                '.global-nav__me img',
                'img[class*="global-nav__me-photo"]',
            ];
            let profileImage = null;
            for (const sel of imgSels) {
                const el = document.querySelector(sel);
                if (el?.src && el.src.includes('licdn') && !el.src.includes('data:')) {
                    profileImage = el.src; break;
                }
            }
            const nameSels = [
                '.global-nav__me-content .t-14',
                '.global-nav__me-content span[class*="t-"]',
            ];
            let displayName = null;
            for (const sel of nameSels) {
                const el = document.querySelector(sel);
                if (el?.innerText?.trim()) { displayName = el.innerText.trim(); break; }
            }
            return { profileImage, displayName };
        }).catch(() => ({ profileImage: null, displayName: null }));
        console.log('📸 LinkedIn user data:', data.displayName, data.profileImage ? '(image found)' : '(no image)');
        return data;
    } catch (err) {
        console.warn('⚠️ Could not fetch LinkedIn user data:', err.message);
        return { profileImage: null, displayName: null };
    }
}

// ── STEP 1 — Initiate LinkedIn login ─────────────────────────────────────────
async function initiateLinkedInLogin(uid, email, password) {
    const baseConfig = getLaunchConfig();
    const browser = await chromium.launch({
        headless: baseConfig.headless,
        args:     [...(baseConfig.args || []), '--disable-infobars'],
    });

    try {
        // ── Create context with stealth settings ──────────────────────────────
        const context = await newStealthContext(browser);
        const page    = await context.newPage();

        console.log('🌐 Navigating to LinkedIn...');
        await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await randomDelay(2000, 4000);

        const pageTitle = await page.title().catch(() => '');
        const pageUrl   = page.url();
        console.log(`📄 Login page: "${pageTitle}" — ${pageUrl}`);

        // ── Wait for login form ───────────────────────────────────────────────
        const anyInput = '#username, input[name="session_key"], input[type="email"], input[autocomplete="username"]';
        try {
            await page.waitForSelector(anyInput, { timeout: 15000 });
            console.log('   ✅ Login form loaded');
        } catch {
            const bodySnippet = await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => '');
            console.error('   ❌ Login form not found. Page says:', bodySnippet);
            await browser.close();
            return { success: false, message: 'LinkedIn login page did not load correctly. May be showing a CAPTCHA or bot detection.' };
        }

        await randomDelay(800, 1500);

        // ── Find + fill email ─────────────────────────────────────────────────
        const emailSel = await page.evaluate(() => {
            const sels = ['#username', 'input[name="session_key"]', 'input[autocomplete="username"]', 'input[type="email"]'];
            for (const s of sels) { if (document.querySelector(s)) return s; }
            return null;
        });

        if (!emailSel) {
            await browser.close();
            return { success: false, message: 'Could not find email field on LinkedIn login page' };
        }
        console.log(`   ✅ Email field: ${emailSel}`);

        await page.evaluate(sel => {
            const el = document.querySelector(sel);
            el.focus(); el.click(); el.value = '';
        }, emailSel).catch(() => {});
        await randomDelay(300, 600);
        await page.focus(emailSel).catch(() => {});
        await page.keyboard.type(email, { delay: 80 + Math.random() * 60 });
        await randomDelay(500, 1000);

        // ── Find + fill password ──────────────────────────────────────────────
        const passSel = await page.evaluate(() => {
            const sels = ['#password', 'input[name="session_password"]', 'input[autocomplete="current-password"]', 'input[type="password"]'];
            for (const s of sels) { if (document.querySelector(s)) return s; }
            return null;
        });

        if (!passSel) {
            await browser.close();
            return { success: false, message: 'Could not find password field on LinkedIn login page' };
        }
        console.log(`   ✅ Password field: ${passSel}`);

        await page.evaluate(sel => {
            const el = document.querySelector(sel);
            el.focus(); el.click(); el.value = '';
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
            currentUrl = page.url();
            const title = await page.title().catch(() => '');
            console.log(`📍 Poll ${attempt + 1}: ${currentUrl.slice(0, 80)} — "${title}"`);

            if (!currentUrl.includes('/login')) break;

            if (attempt === 4) {
                console.warn('   ⚠️ Still on login — trying button click');
                const clicked = await page.evaluate(() => {
                    const btn = document.querySelector('[type=submit], button.btn__primary--large, .login__form_action_container button');
                    if (btn) { btn.click(); return true; }
                    return false;
                }).catch(() => false);
                console.log(clicked ? '   ✅ Button clicked' : '   ❌ No button found');
            }

            if (attempt === 8) {
                const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '');
                console.warn('   📄 Page content after 8 polls:', bodyText.replace(/\n/g, ' '));
            }
        }

        console.log('📍 Final URL:', currentUrl);

        // ── Handle success ────────────────────────────────────────────────────
        if (currentUrl.includes('/feed') || currentUrl.includes('/mynetwork') ||
            currentUrl.includes('/jobs') || currentUrl.includes('/home')) {
            // Playwright: use context.cookies() not page.cookies()
            const cookies = await context.cookies('https://www.linkedin.com');
            const liAt    = cookies.find(c => c.name === 'li_at');
            if (liAt) {
                const encryptedCookie = encrypt(liAt.value);
                const { profileImage, displayName } = await fetchLinkedInUserData(page);
                await db.collection('users').doc(uid).update({
                    linkedinSession:    encryptedCookie,
                    linkedinEmail:      email,
                    linkedinConnectedAt: new Date().toISOString(),
                    ...(profileImage && { linkedinProfileImage: profileImage }),
                    ...(displayName  && { linkedinDisplayName:  displayName  }),
                });
                await browser.close();
                return { success: true, message: 'LinkedIn connected successfully ✅' };
            }
            await browser.close();
            return { success: false, message: 'Logged in but could not extract session cookie' };
        }

        // ── Handle OTP/checkpoint ─────────────────────────────────────────────
        if (currentUrl.includes('checkpoint') || currentUrl.includes('verify') ||
            currentUrl.includes('pin') || currentUrl.includes('challenge') ||
            currentUrl.includes('captcha')) {
            console.log('🔐 OTP/verification page detected:', currentUrl);
            activeSessions[uid] = { browser, page, context };
            setTimeout(() => {
                if (activeSessions[uid]) {
                    activeSessions[uid].browser.close().catch(() => {});
                    delete activeSessions[uid];
                }
            }, 10 * 60 * 1000);
            return { success: false, requiresOtp: true, message: 'Verification required — submit the OTP to complete login' };
        }

        const pageContent = await page.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => '');
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

    const { browser, page, context } = session;
    try {
        console.log('🔑 Submitting OTP...');

        const otpSelectors = [
            'input[name="pin"]',
            'input[id="input__email_verification_pin"]',
            'input[autocomplete="one-time-code"]',
            'input[aria-label*="verification"]',
            'input[aria-label*="pin"]',
            'input[type="text"]',
            'input[type="number"]',
        ];

        let otpSel = null;
        for (const selector of otpSelectors) {
            try {
                await page.waitForSelector(selector, { timeout: 3000 });
                const el = page.locator(selector).first();
                if (await el.isVisible().catch(() => false)) { otpSel = selector; break; }
            } catch { continue; }
        }

        if (!otpSel) {
            await browser.close(); delete activeSessions[uid];
            return { success: false, message: 'Could not find OTP input field' };
        }

        // Fill OTP via evaluate — Playwright: single arg
        await page.evaluate(({ sel, val }) => {
            const input = document.querySelector(sel);
            input.focus();
            input.value = val;
            input.dispatchEvent(new Event('input',  { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }, { sel: otpSel, val: otp });

        await randomDelay(800, 1500);

        // Click submit
        const submitSels = ['[type=submit]', 'button[aria-label*="verify"]', 'button:not([aria-label*="back"])'];
        for (const sel of submitSels) {
            try {
                const btn = await page.$(sel);
                if (btn) { await btn.evaluate(b => b.click()); break; }
            } catch { continue; }
        }

        // Poll for success
        let currentUrl = '';
        for (let i = 0; i < 15; i++) {
            await randomDelay(2000, 3000);
            currentUrl = page.url();
            if (currentUrl.includes('/feed') || currentUrl.includes('/mynetwork')) break;
        }

        if (!currentUrl.includes('/feed') && !currentUrl.includes('/mynetwork')) {
            await browser.close(); delete activeSessions[uid];
            return { success: false, message: `OTP verification failed. Ended on: ${currentUrl}` };
        }

        // Playwright: use context.cookies()
        const cookies = await context.cookies('https://www.linkedin.com');
        const liAt    = cookies.find(c => c.name === 'li_at');

        if (!liAt) {
            await browser.close(); delete activeSessions[uid];
            return { success: false, message: 'OTP accepted but could not extract session cookie' };
        }

        const encryptedCookie = encrypt(liAt.value);
        const { profileImage, displayName } = await fetchLinkedInUserData(page);
        await db.collection('users').doc(uid).update({
            linkedinSession:    encryptedCookie,
            linkedinConnectedAt: new Date().toISOString(),
            ...(profileImage && { linkedinProfileImage: profileImage }),
            ...(displayName  && { linkedinDisplayName:  displayName  }),
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
    return await page.evaluate(() => {
        function pick(selectors, attr) {
            for (const sel of selectors) {
                try {
                    const els = document.querySelectorAll(sel);
                    for (const el of els) {
                        const val = attr === 'src' ? el.src
                            : attr === 'alt' ? el.alt
                            : (el.innerText || el.textContent || '').trim();
                        if (val && val.length > 1 && val.length < 300 && !val.includes('linkedin.com/in/'))
                            return val.replace(/\n+/g, ' ').trim();
                    }
                } catch {}
            }
            return null;
        }

        const name     = pick(['h1.text-heading-xlarge', 'h1.inline.t-24.v-align-middle.break-words', '.pv-top-card h1', 'h1[class*="text-heading"]', 'main h1']);
        const headline = pick(['.text-body-medium.break-words', '.mt2 .text-body-medium', 'h2.text-body-medium', '[class*="headline"]']);
        const location = pick(['.pb2 span.text-body-small.inline.t-black--light', 'span.text-body-small[aria-label*="location"]', '[class*="location"]']);
        const company  = pick(['.pv-text-details__right-panel span[aria-hidden="true"]', '.pv-entity__secondary-title']);
        const about    = pick(['#about ~ div .inline-show-more-text span[aria-hidden="true"]', '.pv-about__summary-text']);
        const profileImage = pick(['img.pv-top-card-profile-picture__image--show', 'img.profile-photo-edit__preview', 'img.EntityPhoto-circle-5', 'img[class*="EntityPhoto"]', 'img.evi-image'], 'src');

        return { name: name || null, headline: headline || null, location: location || null, company: company || null, about: about || null, profileImage: profileImage || null };
    }).catch(() => ({ name: null, headline: null, location: null, company: null, about: null, profileImage: null }));
}

// ── makeScrapePage — Playwright context-based ─────────────────────────────────
async function makeScrapePage(browser, liAt) {
    const context = await newStealthContext(browser, {
        // Block heavy resources via context route
    });

    // Playwright route interception — replaces page.setRequestInterception
    await context.route('**/*', (route, request) => {
        const type = request.resourceType();
        const url  = request.url();
        if (['media', 'font'].includes(type)) { route.abort(); return; }
        if (type === 'image') { url.includes('licdn.com') ? route.continue() : route.abort(); return; }
        route.continue();
    });

    // Set LinkedIn session cookie on context
    await context.addCookies([{
        name: 'li_at', value: liAt,
        domain: '.linkedin.com', path: '/',
        httpOnly: true, secure: true, sameSite: 'None',
    }]);

    const page = await context.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);
    return page;
}

// ── STEP 3 — scrapeLeads (fully Playwright) ───────────────────────────────────
async function scrapeLeads(uid, encryptedCookie, searchUrl, campaignId, maxLeads = 25) {
    const liAt    = decrypt(encryptedCookie);
    const config  = getLaunchConfig();

    // ✅ Use chromium.launch() — NOT puppeteer.launch()
    const browser = await chromium.launch({
        headless: config.headless,
        args:     config.args || [],
    });

    try {
        // ── Verify session ────────────────────────────────────────────────────
        let page = await makeScrapePage(browser, liAt);

        console.log('🌐 Loading LinkedIn domain...');
        const homeOk = await safeGoto(page, 'https://www.linkedin.com', { timeout: 30000 });
        if (!homeOk) console.warn('   ⚠️ LinkedIn home load slow — continuing');

        console.log('🔐 Verifying LinkedIn session...');
        await safeGoto(page, 'https://www.linkedin.com/feed', { timeout: 60000 });

        const loggedIn = await isLoggedIn(page);
        if (!loggedIn) {
            await page.reload({ waitUntil: 'domcontentloaded' });
            const retryLoggedIn = await isLoggedIn(page);
            if (!retryLoggedIn) throw new Error('LinkedIn session expired. Please reconnect.');
        }
        console.log('✅ Session valid — proceeding to search');

        // ── Clean search URL ──────────────────────────────────────────────────
        const cleanSearchUrl = searchUrl
            .replace(/[&?]start=\d+/g, '').replace(/[&?]page=\d+/g, '')
            .replace(/[&?]position=\d+/g, '').replace(/&&+/g, '&')
            .replace(/\?&/, '?').replace(/&$/, '');
        console.log(`🔗 Search URL: ${cleanSearchUrl.slice(0, 120)}`);

        // ── Collect profile URLs ──────────────────────────────────────────────
        const allProfileUrls = new Set();
        let pageNum = 0;
        const MAX_SEARCH_PAGES = Math.ceil(maxLeads / 10) + 1;

        while (allProfileUrls.size < maxLeads && pageNum < MAX_SEARCH_PAGES) {
            const paginatedUrl = `${cleanSearchUrl}&start=${pageNum * 10}`;
            console.log(`📄 Search page ${pageNum + 1}: ${paginatedUrl}`);

            const navOk = await safeGoto(page, paginatedUrl, { timeout: 60000 });
            if (!navOk) { pageNum++; continue; }

            const landedUrl = page.url();
            if (landedUrl.includes('/authwall') || landedUrl.includes('/login') || landedUrl.includes('checkpoint')) {
                console.error('   ❌ Auth wall — stopping'); break;
            }

            await randomDelay(3000, 4000);
            await safeEval(page, () => window.scrollBy(0, 700)).catch(() => {});
            await randomDelay(3000, 4000);
            await safeEval(page, () => window.scrollBy(0, 700)).catch(() => {});
            await randomDelay(3000, 4000);

            // ✅ Playwright: page.$$eval works the same as in Puppeteer
            const pageUrls = await page.$$eval('a[href*="/in/"]', anchors => {
                const links = new Set();
                for (const el of anchors) {
                    const href = (el.href || '').split('?')[0].replace(/\/$/, '');
                    if (href && href.includes('linkedin.com/in/') &&
                        !href.includes('/in/undefined') && !href.endsWith('/in/'))
                        links.add(href);
                }
                return [...links];
            }).catch(() => []);

            console.log(`   Found ${pageUrls.length} profiles on page ${pageNum + 1}`);
            if (pageUrls.length === 0) { console.log('   No more results — stopping'); break; }
            pageUrls.forEach(u => allProfileUrls.add(u));
            pageNum++;
            await randomDelay(4000, 6000);
        }

        const profileUrls = [...allProfileUrls].slice(0, maxLeads);
        console.log(`📋 Total profiles to scrape: ${profileUrls.length}`);

        if (profileUrls.length === 0) {
            await browser.close();
            throw new Error('No profiles found. Check if the URL is a valid LinkedIn people search.');
        }

        // ── Scrape each profile on a fresh page ───────────────────────────────
        const leads = [];

        for (let i = 0; i < profileUrls.length; i++) {
            const profileUrl = profileUrls[i];
            console.log(`👤 Scraping ${i + 1}/${profileUrls.length}: ${profileUrl}`);

            // Fresh page per profile — eliminates detached frame errors
            const pp = await makeScrapePage(browser, liAt);
            try {
                await randomDelay(4000, 8000);
                const ok = await safeGoto(pp, profileUrl, { timeout: 45000 });
                if (!ok) {
                    leads.push({ profileUrl, name: null, headline: null, location: null, company: null, about: null, profileImage: null });
                    await pp.close().catch(() => {});
                    continue;
                }

                const url = pp.url();
                if (url.includes('/authwall') || url.includes('/login') || url.includes('checkpoint')) {
                    console.warn(`⚠️ Auth wall at profile ${i + 1} — stopping`);
                    await pp.close().catch(() => {});
                    break;
                }

                await randomDelay(7000, 11000);
                for (const amt of [400, 500, 400, 500]) {
                    await safeEval(pp, a => window.scrollBy(0, a), null, amt);
                    await randomDelay(1200, 2000);
                }
                await safeEval(pp, () => window.scrollTo(0, 0)).catch(() => {});
                await randomDelay(1000, 2000);

                const profileData = await extractProfileData(pp);
                console.log(`   ✅ ${profileData.name || 'null'} @ ${profileData.company || 'null'}`);
                leads.push({ profileUrl, ...profileData });

            } catch (err) {
                console.warn(`⚠️ Profile ${i + 1} error: ${err.message.slice(0, 80)}`);
                leads.push({ profileUrl, name: null, headline: null, location: null, company: null, about: null, profileImage: null });
            } finally {
                await pp.close().catch(() => {}); // always close
            }
        }

        // ── Save to Firestore ─────────────────────────────────────────────────
        if (leads.length > 0) {
            const batch = db.batch();
            leads.forEach(lead => {
                const ref = db.collection('leads').doc();
                batch.set(ref, {
                    campaignId, userId: uid,
                    profileUrl:   lead.profileUrl   || null,
                    name:         lead.name         || null,
                    headline:     lead.headline     || null,
                    location:     lead.location     || null,
                    company:      lead.company      || null,
                    about:        lead.about        || null,
                    profileImage: lead.profileImage || null,
                    status:    'pending',
                    createdAt: new Date().toISOString(),
                });
            });
            await batch.commit();
            console.log(`💾 Saved ${leads.length} leads`);
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