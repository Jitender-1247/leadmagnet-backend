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

        const data = await page.evaluate(() => {
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
        });

        console.log('📸 LinkedIn user data fetched:', data.displayName, data.profileImage ? '(image found)' : '(no image)');
        return data;
    } catch (err) {
        console.warn('⚠️ Could not fetch LinkedIn user data:', err.message);
        return { profileImage: null, displayName: null };
    }
}

// ── Helper: reliable login check using URL instead of DOM element ────────────
async function isLoggedIn(page) {
    // Wait a moment for any redirect to happen
    await randomDelay(3000, 4000);
    const url = page.url();
    console.log('   🔍 Current URL after wait:', url);
    return (
        !url.includes('/login') &&
        !url.includes('/authwall') &&
        !url.includes('/uas/') &&
        !url.includes('checkpoint')
    );
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

        await randomDelay(1000, 2000);
        await page.type('#username', email, { delay: 120 });
        await randomDelay(500, 1000);
        await page.type('#password', password, { delay: 100 });
        await randomDelay(500, 1000);
        await page.click('[type=submit]');

        await page.waitForFunction(
            () => !window.location.href.includes('/login'),
            { timeout: 30000 }
        );

        await randomDelay(2000, 3000);
        const currentUrl = page.url();
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

// ── Helper: extract profile data with multiple selector fallbacks ───────────
async function extractProfileData(page) {
    return await page.evaluate(() => {

        const bodyLines = document.body.innerText
            .split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0);

        // ── Find "For Business" line — name always comes right after ────────
        const forBusinessIdx = bodyLines.lastIndexOf('For Business');

        let name = null, headline = null, location = null;

        if (forBusinessIdx !== -1) {
            // Skip any empty/garbage lines after "For Business"
            const skipWords = ['Try Premium', 'Join now', 'Sign in', 'Advertisement'];
            
            let nameIdx = forBusinessIdx + 1;
            // Skip ad/promo lines
            while (
                nameIdx < bodyLines.length &&
                skipWords.some(w => bodyLines[nameIdx].includes(w))
            ) {
                nameIdx++;
            }

            name     = bodyLines[nameIdx]     || null;
            headline = bodyLines[nameIdx + 1] || null;

            // Location comes after "Message" button which follows the name repeat
            // Structure: Name, Headline, Message, Name(repeat), Headline(repeat), Location
            const messageIdx = bodyLines.findIndex(
                (l, i) => i > nameIdx && (l === 'Message' || l === 'Connect' || l === 'Pending')
            );

            if (messageIdx !== -1) {
                // After "Message": skip repeated name + headline, grab location
                // location is usually 2-3 lines after Message
                const candidateLines = bodyLines.slice(messageIdx + 1, messageIdx + 6);
                
                // Location looks like "City, State" or "City, Country"
                // Skip lines that match name or headline (repeated)
                location = candidateLines.find(l =>
                    l !== name &&
                    l !== headline &&
                    l.length > 2 &&
                    !l.includes('Try Premium') &&
                    !l.includes('Connect') &&
                    !l.includes('Message') &&
                    !l.includes('Follow') &&
                    !l.includes('She/') &&   // skip pronouns
                    !l.includes('He/') &&
                    !l.includes('They/') &&
                    (l.includes(',') || l.includes('Area') || l.length < 40)
                ) || null;
            }
        }

        // ── Company from experience section ──────────────────────────────────
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

                // ✅ More robust profile image selectors
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
    });
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

        // ── Step 1: visit LinkedIn then set cookie ───────────────────────────
        console.log('🌐 Loading LinkedIn domain...');
        await page.goto('https://www.linkedin.com', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

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
        await page.goto('https://www.linkedin.com/feed', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

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

        const allProfileUrls = new Set();
        let pageNum = 0;

        while (allProfileUrls.size < maxLeads) {
            const paginatedUrl = `${searchUrl}&start=${pageNum * 10}`;
            console.log(`📄 Scraping search page ${pageNum + 1}: ${paginatedUrl}`);

            await page.goto(paginatedUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });
            await randomDelay(3000, 4000);

            const stillLoggedIn = await isLoggedIn(page);
            if (!stillLoggedIn) {
                await browser.close();
                throw new Error('LinkedIn session was rejected on search page. Please reconnect.');
            }

            await page.evaluate(() => window.scrollBy(0, 600));
            await randomDelay(1000, 1500);
            await page.evaluate(() => window.scrollBy(0, 600));
            await randomDelay(1000, 1500);

            const pageUrls = await page.evaluate(() => {
                const links = new Set();
                document.querySelectorAll('a[href*="/in/"]').forEach(el => {
                    const href = el.href.split('?')[0].replace(/\/$/, '');
                    if (
                        href &&
                        href.includes('linkedin.com/in/') &&
                        !href.includes('/in/undefined') &&
                        !href.endsWith('/in/')
                    ) {
                        links.add(href);
                    }
                });
                return [...links];
            });

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
        const leads = [];

        for (let i = 0; i < profileUrls.length; i++) {
            const profileUrl = profileUrls[i];
            console.log(`👤 Scraping profile ${i + 1}/${profileUrls.length}: ${profileUrl}`);

            try {
                await randomDelay(5000, 9000);

                await page.goto(profileUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: 45000
                }).catch(() => {
                    console.warn(`⏱️ goto timeout — continuing with partial load`);
                });

                // Auth wall check
                const currentUrl = page.url();
                if (
                    currentUrl.includes('/authwall') ||
                    currentUrl.includes('/login') ||
                    currentUrl.includes('checkpoint') ||
                    currentUrl.includes('/uas/')
                ) {
                    console.warn(`⚠️ Auth wall hit at profile ${i + 1} — stopping`);
                    break;
                }

                // ✅ Wait 10-15 seconds for full page render including images
                const renderWait = Math.floor(Math.random() * 5000) + 10000;
                console.log(`   ⏳ Waiting ${Math.round(renderWait / 1000)}s for full render...`);
                await randomDelay(renderWait, renderWait + 2000);

                // ✅ Scroll through page to trigger lazy loading of all sections
                await page.evaluate(() => window.scrollBy(0, 500));
                await randomDelay(2000, 3000);
                await page.evaluate(() => window.scrollBy(0, 500));
                await randomDelay(2000, 3000);
                await page.evaluate(() => window.scrollBy(0, 500));
                await randomDelay(2000, 3000);
                await page.evaluate(() => window.scrollBy(0, 500));
                await randomDelay(2000, 3000);
                // Scroll back to top — profile image is at the top
                await page.evaluate(() => window.scrollTo(0, 0));
                await randomDelay(2000, 3000);

                const bodySnippet = await page.evaluate(() =>
                    document.body ? document.body.innerText.slice(0, 200) : 'no body'
                );
                console.log(`📄 Preview: ${bodySnippet}`);

                const profileData = await extractProfileData(page);
                console.log(`   ✅ Extracted:`, JSON.stringify(profileData));
                leads.push({ profileUrl, ...profileData });

            } catch (err) {
                console.warn(`⚠️ Failed to scrape ${profileUrl}:`, err.message);
                leads.push({
                    profileUrl,
                    name: null,
                    headline: null,
                    location: null,
                    company: null,
                    about: null,
                    profileImage: null
                });
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