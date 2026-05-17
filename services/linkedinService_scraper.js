require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
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

// ── Realistic human delays ────────────────────────────────────────────────────
// These are NOT short delays — LinkedIn's bot detection looks for sub-human speed.
function randomDelay(min = 2000, max = 4000) {
    return new Promise(resolve =>
        setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min)
    );
}

// ── THE permanent frame-error solution ───────────────────────────────────────
// One central detector used everywhere. Add new strings here if LinkedIn
// introduces new error variants — fix in one place, fixed everywhere.
function isFrameError(err) {
    if (!err) return false;
    const msg = err.message || String(err);
    return (
        msg.includes('detached Frame')              ||
        msg.includes('Navigating frame was detached')||
        msg.includes('Execution context was destroyed') ||
        msg.includes('Target closed')               ||
        msg.includes('Session closed')              ||
        msg.includes('net::ERR_ABORTED')            ||
        msg.includes('Cannot find context')         ||
        msg.includes('Attempted to use detached')   ||
        msg.includes('Frame was detached')
    );
}

// ── safeGoto — the ONLY way we navigate anywhere ─────────────────────────────
// Returns true on success, false on ANY frame/network/detach error.
// Uses a race between the goto promise and a framedetached event so we
// catch the error no matter whether Puppeteer surfaces it synchronously
// or via an unhandled rejection.
async function safeGoto(page, url, opts = {}) {
    const options = { waitUntil: 'domcontentloaded', timeout: 90000, ...opts };

    // Build a promise that resolves false the instant the frame detaches,
    // regardless of what goto is doing at that moment.
    let detachResolve;
    const detachPromise = new Promise(resolve => { detachResolve = resolve; });
    const onDetach = () => detachResolve(false);
    page.on('framedetached', onDetach);

    try {
        const result = await Promise.race([
            page.goto(url, options).then(() => true).catch(err => {
                if (isFrameError(err) || err.message.includes('timeout')) return false;
                throw err;
            }),
            detachPromise,
        ]);

        page.off('framedetached', onDetach);

        if (!result) {
            console.warn(`   ⚠️ safeGoto: frame detached or navigation failed — ${url.slice(0, 70)}`);
            await new Promise(r => setTimeout(r, 3000));
            return false;
        }

        // Settle delay — let LinkedIn's redirect scripts fire before we touch the page
        await randomDelay(2000, 3500);
        return true;
    } catch (err) {
        page.off('framedetached', onDetach);
        if (isFrameError(err) || err.message.includes('timeout')) {
            console.warn(`   ⚠️ safeGoto: caught error — ${err.message.slice(0, 80)}`);
            await new Promise(r => setTimeout(r, 3000));
            return false;
        }
        throw err;
    }
}

// ── safeEval — the ONLY way we run evaluate ──────────────────────────────────
// Returns fallback value on any frame error instead of throwing.
async function safeEval(page, fn, fallback = null, ...args) {
    try {
        return await page.evaluate(fn, ...args);
    } catch (err) {
        if (isFrameError(err)) {
            console.warn(`   ⚠️ safeEval: frame error — returning fallback`);
            return fallback;
        }
        throw err;
    }
}

// ── safeUrl — read current URL without ever crashing ─────────────────────────
async function safeUrl(page) {
    // We use safeEval via window.location.href instead of page.url()
    // because page.url() calls into the CDP session directly and throws
    // if the frame is detached, while evaluate() goes through our guard.
    return await safeEval(page, () => window.location.href, '') || '';
}

// ── isAuthWall — check if LinkedIn kicked us out ─────────────────────────────
async function isAuthWall(page) {
    const url = await safeUrl(page);
    return (
        url.includes('/authwall') ||
        url.includes('/login')    ||
        url.includes('checkpoint')||
        url.includes('/uas/')     ||
        url === ''  // safeUrl returns '' when frame is dead
    );
}

// ── fetchLinkedInUserData ─────────────────────────────────────────────────────
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
    const browser = await puppeteer.launch(getLaunchConfig());
    try {
        const page = await browser.newPage();
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

        console.log('🌐 Navigating to LinkedIn...');
        await safeGoto(page, 'https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });

        // Check the field actually exists before typing
        const usernameEl = await page.$('#username');
        if (!usernameEl) {
            await browser.close();
            return { success: false, message: 'LinkedIn login page did not load correctly' };
        }
        console.log('   ✅ Email field found: #username');

        await randomDelay(1500, 2500);
        await page.type('#username', email, { delay: 150 });
        await randomDelay(800, 1500);
        await page.type('#password', password, { delay: 120 });
        await randomDelay(800, 1500);
        await page.click('[type=submit]');

        await page.waitForFunction(
            () => !window.location.href.includes('/login'),
            { timeout: 30000 }
        ).catch(() => {});

        await randomDelay(3000, 5000);
        const currentUrl = await safeUrl(page);
        console.log('📍 After login URL:', currentUrl);

        if (currentUrl.includes('/feed') || currentUrl.includes('/mynetwork') ||
            currentUrl.includes('/jobs') || currentUrl.includes('/home')) {
            const cookies = await page.cookies('https://www.linkedin.com');
            const liAt = cookies.find(c => c.name === 'li_at');
            if (liAt) {
                const encryptedCookie = encrypt(liAt.value);
                const { profileImage, displayName } = await fetchLinkedInUserData(page);
                await db.collection('users').doc(uid).update({
                    linkedinSession:     encryptedCookie,
                    linkedinEmail:       email,
                    linkedinConnectedAt: new Date().toISOString(),
                    ...(profileImage && { linkedinProfileImage: profileImage }),
                    ...(displayName  && { linkedinDisplayName:  displayName  }),
                });
                await browser.close();
                return { success: true, message: 'LinkedIn connected successfully ✅' };
            } else {
                await browser.close();
                return { success: false, message: 'Logged in but could not extract session cookie' };
            }
        }

        if (currentUrl.includes('checkpoint') || currentUrl.includes('verify') ||
            currentUrl.includes('pin') || currentUrl.includes('challenge')) {
            console.log('🔐 OTP page detected — waiting for user input...');
            activeSessions[uid] = { browser, page };
            setTimeout(() => {
                if (activeSessions[uid]) {
                    activeSessions[uid].browser.close().catch(() => {});
                    delete activeSessions[uid];
                }
            }, 10 * 60 * 1000);
            return { success: false, requiresOtp: true, message: 'OTP sent — submit it to complete login' };
        }

        await browser.close();
        return { success: false, message: `Unexpected page after login: ${currentUrl}` };
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
            input.dispatchEvent(new Event('input',  { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }, otpInput, otp).catch(() => {});

        await randomDelay(800, 1500);

        for (const selector of ['[type=submit]', 'button[aria-label*="verify"]', 'button:not([aria-label*="back"])']) {
            try {
                const btn = await page.$(selector);
                if (btn) { await btn.evaluate(b => b.click()); break; }
            } catch { continue; }
        }

        await page.waitForFunction(
            () => window.location.href.includes('/feed') || window.location.href.includes('/mynetwork'),
            { timeout: 30000 }
        ).catch(() => {});

        await randomDelay(2000, 3000);
        const cookies = await page.cookies('https://www.linkedin.com');
        const liAt = cookies.find(c => c.name === 'li_at');

        if (!liAt) {
            await browser.close(); delete activeSessions[uid];
            return { success: false, message: 'OTP accepted but could not extract session cookie' };
        }

        const encryptedCookie = encrypt(liAt.value);
        const { profileImage, displayName } = await fetchLinkedInUserData(page);
        await db.collection('users').doc(uid).update({
            linkedinSession:     encryptedCookie,
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
    return await safeEval(page, () => {
        const bodyLines = document.body.innerText
            .split('\n').map(l => l.trim()).filter(l => l.length > 0);

        const forBusinessIdx = bodyLines.lastIndexOf('For Business');
        let name = null, headline = null, location = null;

        if (forBusinessIdx !== -1) {
            const skipWords = ['Try Premium', 'Join now', 'Sign in', 'Advertisement'];
            let nameIdx = forBusinessIdx + 1;
            while (nameIdx < bodyLines.length && skipWords.some(w => bodyLines[nameIdx].includes(w))) nameIdx++;
            name     = bodyLines[nameIdx]     || null;
            headline = bodyLines[nameIdx + 1] || null;
            const messageIdx = bodyLines.findIndex(
                (l, i) => i > nameIdx && (l === 'Message' || l === 'Connect' || l === 'Pending')
            );
            if (messageIdx !== -1) {
                const candidateLines = bodyLines.slice(messageIdx + 1, messageIdx + 6);
                location = candidateLines.find(l =>
                    l !== name && l !== headline && l.length > 2 &&
                    !l.includes('Try Premium') && !l.includes('Connect') &&
                    !l.includes('Message') && !l.includes('Follow') &&
                    !l.includes('She/') && !l.includes('He/') && !l.includes('They/') &&
                    (l.includes(',') || l.includes('Area') || l.length < 40)
                ) || null;
            }
        }

        const getText = (selectors) => {
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el && el.innerText.trim()) return el.innerText.trim();
            }
            return null;
        };

        const company = getText([
            '.pv-text-details__right-panel .hoverable-link-text span[aria-hidden="true"]',
            '#experience ~ div .pvs-entity span[aria-hidden="true"]',
        ]);
        const about = getText([
            '#about ~ div span[aria-hidden="true"]',
            '#about ~ div span',
        ]);
        const imgEl = document.querySelector([
            'img.pv-top-card-profile-picture__image--show',
            'img.profile-photo-edit__preview',
            'img.evi-image',
            '.pv-top-card__photo img',
            'img[class*="profile-picture"]',
            'img[class*="EntityPhoto"]',
            '.presence-entity__image',
            'section img[height="200"]',
            'section img[width="200"]',
        ].join(', '));
        const profileImage = imgEl?.src || null;

        return { name, headline, location, company, about, profileImage };
    }, { name: null, headline: null, location: null, company: null, about: null, profileImage: null });
}

// ── makeScrapePage ────────────────────────────────────────────────────────────
async function makeScrapePage(browser, liAt) {
    await randomDelay(1000, 2000);

    let page;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try { page = await browser.newPage(); break; }
        catch (err) {
            console.warn(`   ⚠️ newPage attempt ${attempt} failed: ${err.message}`);
            if (attempt === 3) throw err;
            await randomDelay(4000, 6000);
        }
    }

    page.setDefaultNavigationTimeout(90000);
    page.setDefaultTimeout(90000);

    page.on('error', err => {
        if (isFrameError(err)) console.warn('   ⚠️ Page error (suppressed):', err.message.slice(0, 60));
    });

    await page.setRequestInterception(true);
    page.on('request', req => {
        const type = req.resourceType();
        const url  = req.url();
        if (['media', 'font'].includes(type)) { req.abort(); return; }
        if (type === 'image') { url.includes('licdn.com') ? req.continue() : req.abort(); return; }
        try { req.continue(); } catch {}
    });

    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver',  { get: () => false });
        Object.defineProperty(navigator, 'plugins',    { get: () => [1, 2, 3] });
        Object.defineProperty(navigator, 'languages',  { get: () => ['en-US', 'en'] });
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // ── KEY FIX: use safeGoto even for the domain warm-up ────────────────────
    // The old code used raw page.goto here — this is where most frame detaches
    // were happening before scraping even started.
    await safeGoto(page, 'https://www.linkedin.com', { waitUntil: 'domcontentloaded' });

    await page.setCookie({
        name: 'li_at', value: liAt,
        domain: '.linkedin.com', path: '/',
        httpOnly: true, secure: true, sameSite: 'None'
    });

    return page;
}

// ── STEP 3 — scrapeLeads ──────────────────────────────────────────────────────
async function scrapeLeads(uid, encryptedCookie, searchUrl, campaignId, maxLeads = 25) {
    const liAt    = decrypt(encryptedCookie);
    const browser = await puppeteer.launch(getLaunchConfig());
    let page;

    try {
        page = await makeScrapePage(browser, liAt);

        // ── 1. Verify session ─────────────────────────────────────────────────
        console.log('🔐 Verifying LinkedIn session...');
        const feedOk = await safeGoto(page, 'https://www.linkedin.com/feed', { timeout: 90000 });

        if (!feedOk) {
            // safeGoto already waited 3s after failure — try once more
            console.warn('   ⚠️ Feed navigation failed — retrying after 8s...');
            await randomDelay(8000, 10000);
            const retryOk = await safeGoto(page, 'https://www.linkedin.com/feed', { timeout: 60000 });
            if (!retryOk) {
                await browser.close();
                throw new Error('LinkedIn blocked navigation. Please reconnect LinkedIn in Settings.');
            }
        }

        // safeGoto already includes a 2-3s settle delay — safeUrl is now safe to call
        const feedUrl = await safeUrl(page);
        const loggedIn = feedUrl && !feedUrl.includes('/login') && !feedUrl.includes('/authwall') &&
                         !feedUrl.includes('checkpoint') && !feedUrl.includes('/uas/');

        if (!loggedIn) {
            await browser.close();
            throw new Error('LinkedIn session expired. Please reconnect LinkedIn in Settings.');
        }
        console.log('✅ Session valid — proceeding to search');

        // ── 2. Collect profile URLs — HARD CAP: 3 pages ──────────────────────
        console.log('🔍 Navigating to search URL...');
        const allProfileUrls = new Set();
        const MAX_SEARCH_PAGES = 3; // 30 results max — beyond this LinkedIn rate-limits aggressively
        let emptyStreak = 0;

        for (let pageNum = 0; pageNum < MAX_SEARCH_PAGES; pageNum++) {
            if (allProfileUrls.size >= maxLeads) break;

            const targetUrl = `${searchUrl}&start=${pageNum * 10}`;
            console.log(`📄 Scraping search page ${pageNum + 1}/${MAX_SEARCH_PAGES}: ${targetUrl}`);

            // safeGoto handles the frame detach AND waits 2-3s for LinkedIn to settle
            const navOk = await safeGoto(page, targetUrl, { timeout: 60000 });
            if (!navOk) {
                console.warn(`   ⚠️ Navigation failed on page ${pageNum + 1} — skipping`);
                await randomDelay(8000, 12000);
                continue;
            }

            // Auth wall check — safeUrl goes through safeEval, never throws
            if (await isAuthWall(page)) {
                console.warn('⚠️ Auth wall or session lost — stopping search');
                break;
            }

            // Scroll to trigger lazy-load content
            await safeEval(page, () => window.scrollBy(0, 800), null);
            await randomDelay(2000, 3000);
            await safeEval(page, () => window.scrollBy(0, 800), null);
            await randomDelay(2000, 3000);

            // Extract profile URLs
            const urls = await safeEval(page, () => {
                const links = new Set();
                document.querySelectorAll('a[href*="/in/"]').forEach(el => {
                    const href = el.href.split('?')[0].replace(/\/$/, '');
                    if (href && href.includes('linkedin.com/in/') &&
                        !href.includes('/in/undefined') && !href.endsWith('/in/'))
                        links.add(href);
                });
                return [...links];
            }, []);

            console.log(`   Found ${urls.length} profiles on page ${pageNum + 1}`);

            if (urls.length === 0) {
                if (++emptyStreak >= 2) { console.log('   No more results — stopping'); break; }
            } else {
                emptyStreak = 0;
                urls.forEach(u => allProfileUrls.add(u));
            }

            // Human-like gap between pages (6-10 seconds)
            if (pageNum < MAX_SEARCH_PAGES - 1 && allProfileUrls.size < maxLeads) {
                await randomDelay(6000, 10000);
            }
        }

        const profileUrls = [...allProfileUrls].slice(0, maxLeads);
        console.log(`📋 ${profileUrls.length} unique profiles to scrape`);

        if (profileUrls.length === 0) {
            await browser.close();
            throw new Error('No profiles found. Check your LinkedIn search URL.');
        }

        // ── 3. Scrape individual profiles ─────────────────────────────────────
        const leads = [];

        for (let i = 0; i < profileUrls.length; i++) {
            const profileUrl = profileUrls[i];
            console.log(`👤 ${i + 1}/${profileUrls.length}: ${profileUrl}`);

            // Human-like gap between profiles (8-15 seconds)
            await randomDelay(8000, 15000);

            const profOk = await safeGoto(page, profileUrl, { timeout: 60000 });
            if (!profOk) {
                console.warn(`   ⚠️ Could not load profile ${i + 1} — skipping`);
                leads.push({ profileUrl, name: null, headline: null, location: null, company: null, about: null, profileImage: null });
                continue;
            }

            if (await isAuthWall(page)) {
                console.warn(`⚠️ Auth wall at profile ${i + 1} — stopping`);
                break;
            }

            // Read time — LinkedIn's heuristics look for time-on-page
            await randomDelay(8000, 12000);

            // Natural scroll pattern
            for (const amt of [350, 450, 400, 500]) {
                await safeEval(page, a => window.scrollBy(0, a), null, amt);
                await randomDelay(2000, 3500);
            }
            await safeEval(page, () => window.scrollTo(0, 0), null);
            await randomDelay(1500, 2500);

            const profileData = await extractProfileData(page);
            console.log(`   ✅ ${profileData.name || '(no name)'} @ ${profileData.company || '(no company)'}`);
            leads.push({ profileUrl, ...profileData });
        }

        // ── 4. Save to Firestore ──────────────────────────────────────────────
        if (leads.length > 0) {
            const batch = db.batch();
            leads.forEach(lead => {
                const ref = db.collection('leads').doc();
                batch.set(ref, {
                    campaignId,
                    userId:       uid,
                    profileUrl:   lead.profileUrl   || null,
                    name:         lead.name         || null,
                    headline:     lead.headline     || null,
                    location:     lead.location     || null,
                    company:      lead.company      || null,
                    about:        lead.about        || null,
                    profileImage: lead.profileImage || null,
                    status:       'pending',
                    createdAt:    new Date().toISOString()
                });
            });
            await batch.commit();
            console.log(`💾 Saved ${leads.length} leads to Firestore`);
        }

        await browser.close();
        return leads;

    } catch (err) {
        if (isFrameError(err)) {
            console.error('❌ scrapeLeads frame error:', err.message.slice(0, 80));
            try { await browser.close(); } catch {}
            throw new Error('LinkedIn interrupted the scrape. Please try again in a few minutes.');
        }
        console.error('❌ scrapeLeads error:', err.message);
        try { await browser.close(); } catch {}
        throw err;
    }
}

module.exports = { initiateLinkedInLogin, submitLinkedInOtp, scrapeLeads, decrypt };