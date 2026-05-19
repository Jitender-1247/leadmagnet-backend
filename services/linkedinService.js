require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const crypto = require('crypto');
const { db } = require('../config/firebase');
const { getLaunchConfig } = require('./browserConfig');

puppeteer.use(StealthPlugin());

const IV_LENGTH = 16;
const activeSessions = {};

// ── Lazy-read ENCRYPTION_KEY so dotenv is always loaded first ───────────────
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

// ── Grab profile image + name from LinkedIn nav after login ──────────────────
async function fetchLinkedInUserData(page) {
    try {
        // Wait for nav to fully load
        await randomDelay(2000, 3000);

        const data = await safeEval(page, () => {
            // Profile image — LinkedIn nav avatar selectors
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

            // Display name from nav
            const nameSelectors = [
                '.global-nav__me-content .t-14',
                '.global-nav__me-content span[class*="t-"]',
                '[data-control-name="identity_welcome_message"] span',
            ];

            let displayName = null;
            for (const sel of nameSelectors) {
                const el = document.querySelector(sel);
                if (el && el.innerText?.trim()) {
                    displayName = el.innerText.trim();
                    break;
                }
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

// ── Universal frame-error detector ─────────────────────────────────────────
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

// ── safeGoto — never throws a frame error, returns true/false ───────────────
async function safeGoto(page, url, opts = {}) {
    const options = { waitUntil: 'domcontentloaded', timeout: 60000, ...opts };
    try {
        await page.goto(url, options);
        await randomDelay(2000, 3000);
        return true;
    } catch (err) {
        const msg = err.message || '';

        // ERR_TOO_MANY_REDIRECTS = cookie conflict — clear ALL cookies and retry once
        if (msg.includes('ERR_TOO_MANY_REDIRECTS')) {
            console.warn(`   ⚠️ Redirect loop detected — clearing cookies and retrying`);
            try {
                const cookies = await page.cookies();
                for (const c of cookies) {
                    await page.deleteCookie({ name: c.name, domain: c.domain }).catch(() => {});
                }
                // Re-set only li_at — get it from the page's closure scope isn't possible
                // so we just navigate to linkedin.com first to reset the session state
                await page.goto('https://www.linkedin.com', {
                    waitUntil: 'domcontentloaded', timeout: 30000
                }).catch(() => {});
                await randomDelay(3000, 5000);
                // Retry the original URL once
                await page.goto(url, options);
                await randomDelay(2000, 3000);
                return true;
            } catch (retryErr) {
                console.warn(`   ⚠️ Retry after cookie clear also failed: ${retryErr.message.slice(0,60)}`);
                return false;
            }
        }

        console.warn(`   ⚠️ safeGoto error [${msg.slice(0, 100)}]`);
        await new Promise(r => setTimeout(r, 3000));
        return false;
    }
}

// ── safeEval — never throws a frame error, returns fallback ─────────────────
async function safeEval(page, fn, fallback = null, ...args) {
    try {
        return await page.evaluate(fn, ...args);
    } catch (err) {
        if (isFrameError(err)) {
            console.warn('   ⚠️ safeEval: frame error — returning fallback');
            return fallback;
        }
        throw err;
    }
}

// ── safeUrl — read URL without ever crashing ─────────────────────────────────
async function safeUrl(page) {
    return await safeEval(page, () => window.location.href, '') || '';
}

// ── isLoggedIn — uses safeUrl, never crashes on detached frame ───────────────
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

// ── STEP 1 — Login with email + password, trigger OTP ──────────────────────
async function initiateLinkedInLogin(uid, email, password) {
    const browser = await puppeteer.launch(getLaunchConfig());

    try {
        const page = await browser.newPage();

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

        console.log('🌐 Navigating to LinkedIn...');
        await page.goto('https://www.linkedin.com/login', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        await randomDelay(2000, 3000);

        // ── Try multiple email selectors (LinkedIn changes these often) ───────
        const emailSelectors = [
            '#username',
            'input[name="session_key"]',
            'input[autocomplete="username"]',
            'input[type="email"]',
            'input[name="email"]',
        ];

        let emailInput = null;
        for (const sel of emailSelectors) {
            try {
                await page.waitForSelector(sel, { timeout: 3000 });
                emailInput = sel;
                console.log(`   ✅ Email field found: ${sel}`);
                break;
            } catch { continue; }
        }

        if (!emailInput) {
            throw new Error('Could not find email input field on LinkedIn login page');
        }

        await page.type(emailInput, email, { delay: 120 });
        await randomDelay(500, 1000);

        // ── Try multiple password selectors ──────────────────────────────────
        const passwordSelectors = [
            '#password',
            'input[name="session_password"]',
            'input[autocomplete="current-password"]',
            'input[type="password"]',
        ];

        let passwordInput = null;
        for (const sel of passwordSelectors) {
            try {
                const el = await page.$(sel);
                if (el) { passwordInput = sel; break; }
            } catch { continue; }
        }

        if (!passwordInput) {
            throw new Error('Could not find password input field on LinkedIn login page');
        }

        await page.type(passwordInput, password, { delay: 100 });
        await randomDelay(500, 1000);

        // ── Try multiple submit selectors ─────────────────────────────────────
        const submitSelectors = [
            '[type=submit]',
            'button[data-litms-control-urn*="login"]',
            'button.btn__primary--large',
            'button[aria-label*="Sign in"]',
            '.login__form_action_container button',
        ];

        for (const sel of submitSelectors) {
            try {
                const btn = await page.$(sel);
                if (btn) { await btn.click(); break; }
            } catch { continue; }
        }

        // Wait for page to leave /login — but don't crash if it doesn't.
        // LinkedIn may show a CAPTCHA or security check that keeps it on /login.
        // We poll the URL manually instead of using waitForFunction.
        let currentUrl = '';
        for (let attempt = 0; attempt < 15; attempt++) {
            await randomDelay(2000, 3000);
            currentUrl = await safeEval(page, () => window.location.href, '') || '';
            console.log(`📍 Login poll ${attempt + 1}: ${currentUrl.slice(0, 80)}`);
            if (!currentUrl.includes('/login')) break;

            // If still on login after 5 polls, try clicking submit again
            if (attempt === 4) {
                console.warn('   ⚠️ Still on login — retrying submit click');
                for (const sel of ['[type=submit]', 'button.btn__primary--large']) {
                    try {
                        const btn = await page.$(sel);
                        if (btn) { await btn.click(); break; }
                    } catch {}
                }
            }
        }
        console.log('📍 After login URL:', currentUrl);

        // ✅ Already logged in — no OTP needed
        if (
            currentUrl.includes('/feed') ||
            currentUrl.includes('/mynetwork') ||
            currentUrl.includes('/jobs') ||
            currentUrl.includes('/home')
        ) {
            const cookies = await page.cookies('https://www.linkedin.com');
            const liAt = cookies.find(c => c.name === 'li_at');

            if (liAt) {
                const encryptedCookie = encrypt(liAt.value);

                // Fetch profile image + name from nav
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

        // 🔐 OTP required — keep browser alive
        if (
            currentUrl.includes('checkpoint') ||
            currentUrl.includes('verify') ||
            currentUrl.includes('pin') ||
            currentUrl.includes('challenge')
        ) {
            console.log('🔐 OTP page detected — waiting for user input...');
            activeSessions[uid] = { browser, page };

            setTimeout(() => {
                if (activeSessions[uid]) {
                    console.log('🧹 Cleaning up session for', uid);
                    activeSessions[uid].browser.close();
                    delete activeSessions[uid];
                }
            }, 10 * 60 * 1000);

            return { success: false, requiresOtp: true, message: 'OTP sent to your email/phone — submit it to complete login' };
        }

        await browser.close();
        return { success: false, message: `Unexpected page after login: ${currentUrl}` };

    } catch (err) {
        console.error('❌ LinkedIn login error:', err.message);
        await browser.close();
        return { success: false, message: err.message };
    }
}

// ── STEP 2 — Submit OTP using the same browser session ─────────────────────
async function submitLinkedInOtp(uid, otp) {
    const session = activeSessions[uid];

    if (!session) {
        return { success: false, message: 'Session expired or not found. Please restart the login process.' };
    }

    const { browser, page } = session;

    try {
        console.log('🔑 Submitting OTP...');

        const otpSelectors = [
            'input[name="pin"]',
            'input[id="input__email_verification_pin"]',
            'input[autocomplete="one-time-code"]',
            'input[aria-label*="verification"]',
            'input[aria-label*="pin"]',
            '#app__container input[type="text"]',
            '#app__container input[type="number"]',
            'input[type="text"]',
            'input[type="number"]'
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
                    }, el);
                    if (isVisible) {
                        otpInput = selector;
                        break;
                    }
                }
            } catch { continue; }
        }

        if (!otpInput) {
            await browser.close();
            delete activeSessions[uid];
            return { success: false, message: 'Could not find OTP input field on the page' };
        }

        await page.evaluate((selector, otp) => {
            const input = document.querySelector(selector);
            input.focus();
            input.value = otp;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }, otpInput, otp);

        await randomDelay(500, 1000);

        const submitSelectors = [
            '[type=submit]',
            'button[aria-label*="verify"]',
            'button[aria-label*="submit"]',
            'button:not([aria-label*="back"])'
        ];

        for (const selector of submitSelectors) {
            try {
                const btn = await page.$(selector);
                if (btn) {
                    await btn.evaluate(b => b.click());
                    break;
                }
            } catch { continue; }
        }

        await page.waitForFunction(
            () => window.location.href.includes('/feed') || window.location.href.includes('/mynetwork'),
            { timeout: 30000 }
        );

        await randomDelay(1000, 2000);

        const cookies = await page.cookies('https://www.linkedin.com');
        const liAt = cookies.find(c => c.name === 'li_at');

        if (!liAt) {
            await browser.close();
            delete activeSessions[uid];
            return { success: false, message: 'OTP accepted but could not extract session cookie' };
        }

        const encryptedCookie = encrypt(liAt.value);

        // Fetch profile image + name from nav
        const { profileImage, displayName } = await fetchLinkedInUserData(page);

        await db.collection('users').doc(uid).update({
            linkedinSession:     encryptedCookie,
            linkedinConnectedAt: new Date().toISOString(),
            ...(profileImage && { linkedinProfileImage: profileImage }),
            ...(displayName  && { linkedinDisplayName:  displayName  }),
        });

        await browser.close();
        delete activeSessions[uid];
        return { success: true, message: 'LinkedIn connected successfully ✅' };

    } catch (err) {
        console.error('❌ OTP error:', err.message);
        await browser.close();
        delete activeSessions[uid];
        return { success: false, message: err.message };
    }
}

// ── Helper: extract profile data ─────────────────────────────────────────────
// Tries every known LinkedIn HTML structure across all versions (2020–2025).
// LinkedIn changes its DOM frequently — we cascade through all known patterns
// and fall back to raw text parsing if CSS selectors all fail.
async function extractProfileData(page) {
    // Extra wait — let lazy-loaded sections (experience, about) fully render
    await randomDelay(3000, 4000);

    return await safeEval(page, () => {

        // ── Utility: try a list of selectors, return first non-empty match ────
        function pick(selectors, attr) {
            for (const sel of selectors) {
                try {
                    const els = document.querySelectorAll(sel);
                    for (const el of els) {
                        const val = attr === 'src' ? el.src
                                  : attr === 'alt' ? el.alt
                                  : (el.innerText || el.textContent || '').trim();
                        if (val && val.length > 1 && val.length < 300
                            && !val.includes('linkedin.com/in/')) {
                            return val.replace(/\n+/g, ' ').trim();
                        }
                    }
                } catch {}
            }
            return null;
        }

        // ── NAME ─────────────────────────────────────────────────────────────
        const name = pick([
            'h1.text-heading-xlarge',                          // 2024-2025
            'h1.inline.t-24.v-align-middle.break-words',       // 2023
            '.pv-top-card--list h1',                           // 2023
            '.ph5 h1',                                         // 2023
            '.pv-top-card h1',                                 // 2022
            '.artdeco-card h1',                                // 2022
            'h1[class*="text-heading"]',                       // generic
            'h1[class*="name"]',                               // generic
            'main h1',                                         // last resort
        ]);

        // ── HEADLINE ─────────────────────────────────────────────────────────
        const headline = pick([
            '.text-body-medium.break-words',                   // 2024-2025
            '.pv-top-card--list .text-body-medium',            // 2023
            '.ph5 .text-body-medium',                          // 2023
            '.pv-top-card .text-body-medium',                  // 2022
            '.mt2 .text-body-medium',                          // 2022
            'h2.text-body-medium',                             // generic
            '[class*="headline"]',                             // generic
            '.pv-top-card h2',                                 // 2021
        ]);

        // ── LOCATION ─────────────────────────────────────────────────────────
        const location = pick([
            '.pb2 span.text-body-small.inline.t-black--light',     // 2024-2025
            '.pv-top-card--list-bullet .text-body-small',           // 2023
            '.ph5 span.text-body-small:not(.visually-hidden)',      // 2023
            '.pv-top-card .pv-top-card--list-bullet span',          // 2022
            'span.text-body-small[aria-label*="location"]',         // aria
            '[class*="location"]',                                   // generic
        ]);

        // ── COMPANY ───────────────────────────────────────────────────────────
        const company = pick([
            // Top-card summary (most reliable — shows current company)
            '.pv-text-details__right-panel .hoverable-link-text span[aria-hidden="true"]',
            '.pv-text-details__right-panel span[aria-hidden="true"]',
            // 2023
            '.pv-top-card--experience-list span[aria-hidden="true"]',
            // Experience section — first entry
            '#experience ~ div .pvs-entity:first-child .hoverable-link-text span[aria-hidden="true"]',
            '#experience ~ div .pvs-entity:first-child span[aria-hidden="true"]',
            '#experience + div .pvs-entity span[aria-hidden="true"]',
            '#experience ~ div li:first-child span[aria-hidden="true"]',
            // 2022
            '.experience-section li:first-child .pv-entity__secondary-title',
            '.pv-top-card--experience-list-item span',
            // Generic
            '.pv-entity__secondary-title',
            '[data-field="experience_company_logo"] + div span',
        ]);

        // ── ABOUT ─────────────────────────────────────────────────────────────
        const about = pick([
            '#about ~ div .inline-show-more-text span[aria-hidden="true"]',   // 2024
            '#about ~ div .visually-hidden ~ span',                            // 2024
            '#about ~ div span[aria-hidden="true"]',                           // 2023
            '#about + div span[aria-hidden="true"]',                           // 2022
            '#about ~ div .pv-shared-text-with-see-more span',                 // 2022
            '.pv-about-section .pv-about__summary-text',                       // 2021
            '.summary .pv-about__summary-text',                                // 2021
            '[data-section="summary"] p',                                       // generic
            '#about ~ div span',                                                // fallback
        ]);

        // ── PROFILE IMAGE ─────────────────────────────────────────────────────
        const profileImage = pick([
            'img.pv-top-card-profile-picture__image--show',    // 2024-2025
            'img.profile-photo-edit__preview',                 // 2023
            '.pv-top-card__photo img',                         // 2022
            '.pv-top-card-profile-picture img',                // 2022
            'img.EntityPhoto-circle-5',                        // 2022
            'img[class*="EntityPhoto"]',                       // generic
            'img.evi-image',                                   // 2021
            '.presence-entity__image',                         // 2021
            'section.artdeco-card img[width="200"]',           // size-based
            'section.artdeco-card img[height="200"]',          // size-based
            'img[width="200"][height="200"]',                  // exact size
        ], 'src');

        // ── FALLBACK: raw text parsing if all selectors failed ────────────────
        // LinkedIn's text always follows a predictable structure we can parse.
        let nameFb = null, headlineFb = null, locationFb = null;

        if (!name || !headline) {
            const lines = (document.body.innerText || '')
                .split('\n')
                .map(l => l.trim())
                .filter(l => l.length > 1 && l.length < 120);

            const noise = [
                'Try Premium', 'Join now', 'Sign in', 'Advertisement',
                'Message', 'Connect', 'Follow', 'More', 'Pending', 'LinkedIn',
                'She/her', 'He/him', 'They/them', 'View profile',
                '1st', '2nd', '3rd', 'degree', 'Open to', 'Hiring',
            ];
            const isClean = (l) => l.length > 2 && !noise.some(n => l.includes(n));

            // Name is always right after "For Business" in LinkedIn's text output
            const fbIdx = lines.lastIndexOf('For Business');
            if (fbIdx !== -1) {
                let i = fbIdx + 1;
                while (i < lines.length && !isClean(lines[i])) i++;
                nameFb     = lines[i]     || null;
                headlineFb = lines[i + 1] || null;

                // Location: comma-separated string after action buttons
                const actionIdx = lines.findIndex(
                    (l, idx) => idx > i && ['Message', 'Connect', 'Pending'].includes(l)
                );
                if (actionIdx !== -1) {
                    for (let j = actionIdx + 1; j < Math.min(actionIdx + 8, lines.length); j++) {
                        const l = lines[j];
                        if (isClean(l) && l !== nameFb && l !== headlineFb &&
                            (l.includes(',') || l.includes('Area') || l.length < 35)) {
                            locationFb = l;
                            break;
                        }
                    }
                }
            }
        }

        return {
            name:         name         || nameFb      || null,
            headline:     headline     || headlineFb  || null,
            location:     location     || locationFb  || null,
            company:      company      || null,
            about:        about        || null,
            profileImage: profileImage || null,
        };

    }, { name: null, headline: null, location: null, company: null, about: null, profileImage: null });
}

// ── STEP 3 — Scrape leads with full profile data ────────────────────────────
async function scrapeLeads(uid, encryptedCookie, searchUrl, campaignId, maxLeads = 25) {
    const liAt = decrypt(encryptedCookie);

    const browser = await puppeteer.launch(getLaunchConfig());

    try {
        const page = await browser.newPage();

        // ── Default timeouts ─────────────────────────────────────────────────
        page.setDefaultNavigationTimeout(60000);
        page.setDefaultTimeout(60000);

        // ── Block heavy resources but allow ALL LinkedIn images ───────────────
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resourceType = req.resourceType();
            const url = req.url();

            // Block media and fonts always
            if (['media', 'font'].includes(resourceType)) {
                req.abort();
                return;
            }

            // ✅ Allow ALL LinkedIn CDN images (profile photos live here)
            if (resourceType === 'image') {
                if (url.includes('media.licdn.com') || url.includes('licdn.com')) {
                    req.continue(); // allow all LinkedIn images
                } else {
                    req.abort(); // block external ads/tracking images
                }
                return;
            }

            req.continue();
        });

        // ── Anti-detection ───────────────────────────────────────────────────
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

        // ── Step 1: visit LinkedIn, clear stale cookies, set fresh li_at ────
        // Stale cookies cause ERR_TOO_MANY_REDIRECTS — clear them all first.
        console.log('🌐 Loading LinkedIn domain...');
        await safeGoto(page, 'https://www.linkedin.com', { timeout: 30000 });

        // Clear cookies for all LinkedIn domains to prevent redirect loops
        const staleCookies = await page.cookies(
            'https://www.linkedin.com',
            'https://linkedin.com'
        ).catch(() => []);
        for (const c of staleCookies) {
            await page.deleteCookie({
                name: c.name,
                domain: c.domain || '.linkedin.com'
            }).catch(() => {});
        }
        console.log(`   🧹 Cleared ${staleCookies.length} stale cookies`);

        await page.setCookie({
            name: 'li_at',
            value: liAt,
            domain: '.linkedin.com',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'None'
        });

        // ── Step 2: verify session ───────────────────────────────────────────
        console.log('🔐 Verifying LinkedIn session...');
        await safeGoto(page, 'https://www.linkedin.com/feed', { timeout: 60000 });

        const loggedIn = await isLoggedIn(page);
        if (!loggedIn) {
            console.warn('⚠️ Session check failed — retrying...');
            await page.reload({ waitUntil: 'domcontentloaded' });
            const retryLoggedIn = await isLoggedIn(page);
            if (!retryLoggedIn) {
                throw new Error('LinkedIn session expired. Please reconnect.');
            }
        }
        console.log('✅ Session valid — proceeding to search');

        // ── Step 3: collect profile URLs from search page(s) ─────────────────
        console.log('🔍 Navigating to search URL...');

        // Strip any existing pagination params — scraper adds its own &start=N
        const cleanSearchUrl = searchUrl
            .replace(/[&?]start=\d+/g, '')
            .replace(/[&?]page=\d+/g, '')
            .replace(/[&?]position=\d+/g, '')
            .replace(/&&+/g, '&')
            .replace(/\?&/, '?')
            .replace(/&$/, '');
        console.log(`🔗 Search URL: ${cleanSearchUrl.slice(0, 120)}`);

        const allProfileUrls = new Set();
        let pageNum = 0;

        const MAX_SEARCH_PAGES = 3;
        while (allProfileUrls.size < maxLeads && pageNum < MAX_SEARCH_PAGES) {
            const paginatedUrl = `${cleanSearchUrl}&start=${pageNum * 10}`;
            console.log(`📄 Scraping search page ${pageNum + 1}: ${paginatedUrl}`);

            const navOk = await safeGoto(page, paginatedUrl, { timeout: 60000 });

            // Log where we actually landed — critical for diagnosing blocks
            const landedUrl = await safeEval(page, () => window.location.href, '');
            console.log(`   📍 Landed: ${(landedUrl || 'unknown').slice(0, 100)}`);

            if (!navOk) {
                console.warn(`   ⚠️ Navigation failed on page ${pageNum + 1} — skipping`);
                await randomDelay(6000, 10000);
                pageNum++;
                continue;
            }

            // Detect auth wall even when navOk is true (LinkedIn redirects silently)
            if (landedUrl && (landedUrl.includes('/authwall') || landedUrl.includes('/login') || landedUrl.includes('checkpoint'))) {
                console.error('   ❌ Redirected to auth wall — session expired or IP blocked');
                break;
            }

            await safeEval(page, () => window.scrollBy(0, 600), null);
            await randomDelay(2500, 3500);
            await safeEval(page, () => window.scrollBy(0, 600), null);
            await randomDelay(2500, 3500);

            const pageUrls = await safeEval(page, () => {
                const links = new Set();
                document.querySelectorAll('a[href*="/in/"]').forEach(el => {
                    const href = el.href.split('?')[0].replace(/\/$/, '');
                    if (href && href.includes('linkedin.com/in/') &&
                        !href.includes('/in/undefined') && !href.endsWith('/in/'))
                        links.add(href);
                });
                return [...links];
            }, []);

            console.log(`   Found ${pageUrls.length} profiles on page ${pageNum + 1}`);

            if (pageUrls.length === 0) {
                console.log('   No more results — stopping pagination');
                break;
            }

            pageUrls.forEach(url => allProfileUrls.add(url));
            pageNum++;
            await randomDelay(3000, 5000);
        }

        const profileUrls = [...allProfileUrls].slice(0, maxLeads);
        console.log(`📋 Total profiles found: ${profileUrls.length}`);

        if (profileUrls.length === 0) {
            await browser.close();
            throw new Error('No profiles found. Check if the URL is a valid LinkedIn people search.');
        }

        // ── Step 4: scrape each profile ──────────────────────────────────────
        // IMPORTANT: reuse same page — DO NOT open new tabs per profile.
        // Opening a new tab per profile uses ~100MB RAM each and crashes
        // Railway's 512MB container by profile 2 (Target.createTarget timed out).
        const leads = [];

        for (let i = 0; i < profileUrls.length; i++) {
            const profileUrl = profileUrls[i];
            console.log(`👤 Scraping profile ${i + 1}/${profileUrls.length}: ${profileUrl}`);

            try {
                await randomDelay(5000, 9000);

                const profOk = await safeGoto(page, profileUrl, { timeout: 60000 });
                if (!profOk) {
                    console.warn(`   ⚠️ Could not load profile ${i + 1} — skipping`);
                    leads.push({ profileUrl, name: null, headline: null, location: null, company: null, about: null, profileImage: null });
                    continue;
                }

                const currentUrl = await safeUrl(page);
                if (currentUrl.includes('/authwall') || currentUrl.includes('/login') ||
                    currentUrl.includes('checkpoint') || currentUrl.includes('/uas/')) {
                    console.warn(`⚠️ Auth wall at profile ${i + 1} — stopping`);
                    break;
                }

                // Wait for full render
                await randomDelay(6000, 10000);

                // Scroll to trigger lazy-loaded sections
                for (const amount of [400, 500, 400, 500]) {
                    await safeEval(page, a => window.scrollBy(0, a), null, amount);
                    await randomDelay(1500, 2500);
                }
                await safeEval(page, () => window.scrollTo(0, 0), null);
                await randomDelay(1000, 2000);

                const profileData = await extractProfileData(page);
                console.log(`   ✅ name=${profileData.name || 'null'} company=${profileData.company || 'null'}`);

                if (!profileData.name) {
                    const title  = await safeEval(page, () => document.title, '');
                    const landed = await safeUrl(page);
                    console.warn(`   ⚠️ No name. Title="${title}" URL=${landed.slice(0, 80)}`);
                }

                leads.push({ profileUrl, ...profileData });

            } catch (err) {
                console.warn(`⚠️ Profile ${i + 1} error: ${err.message.slice(0, 80)}`);
                leads.push({ profileUrl, name: null, headline: null, location: null, company: null, about: null, profileImage: null });
            }
        }

        // ── Step 5: save to Firestore ────────────────────────────────────────
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
        console.error('❌ scrapeLeads error:', err.message);
        await browser.close();
        throw err;
    }
}

module.exports = { initiateLinkedInLogin, submitLinkedInOtp, scrapeLeads, decrypt };