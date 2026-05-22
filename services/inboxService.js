 const { chromium } = require('playwright');
const { db } = require('../config/firebase');
const { decrypt } = require('./linkedinService');
const { getLaunchConfig } = require('./browserConfig');
const {
    sleep, clickDelay, readingDelay, humanType
} = require('./Humandelay');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const STEALTH_SCRIPT = `
    Object.defineProperty(navigator, 'webdriver',  { get: () => undefined });
    Object.defineProperty(navigator, 'plugins',    { get: () => [1,2,3,4,5] });
    Object.defineProperty(navigator, 'languages',  { get: () => ['en-US','en'] });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    delete navigator.__proto__.webdriver;
`;

async function launchBrowser() {
    return await chromium.launch(getLaunchConfig());
}

async function makePage(browser, liAt) {
    const context = await browser.newContext({
        userAgent: UA,
        viewport: {
            width: 1280 + Math.floor(Math.random() * 200),
            height: 800 + Math.floor(Math.random() * 100),
        },
        locale: 'en-US',
        timezoneId: 'America/New_York',
        extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    await context.addInitScript(STEALTH_SCRIPT);

    await context.addCookies([{
        name: 'li_at', value: liAt,
        domain: '.linkedin.com', path: '/',
        httpOnly: true, secure: true, sameSite: 'None',
    }]);

    browser._context = context;
    return await context.newPage();
}

// ── Sync inbox messages ───────────────────────────────────────────────────────
async function syncInboxMessages(uid, encryptedCookie) {
    const liAt = decrypt(encryptedCookie);
    const browser = await launchBrowser();

    try {
        const page = await makePage(browser, liAt);

        console.log('📥 Opening LinkedIn messaging…');
        await page.goto('https://www.linkedin.com/messaging/', {
            waitUntil: 'domcontentloaded', timeout: 60000,
        });

        await sleep(readingDelay());

        const conversations = await page.evaluate(() => {
            const items = [];
            document.querySelectorAll('.msg-conversation-listitem').forEach(el => {
                const nameEl = el.querySelector('.msg-conversation-listitem__participant-names');
                const previewEl = el.querySelector('.msg-conversation-listitem__message-snippet');
                const linkEl = el.querySelector('a');
                const timeEl = el.querySelector('time');
                if (nameEl && linkEl) {
                    items.push({
                        name: nameEl.innerText.trim(),
                        preview: previewEl ? previewEl.innerText.trim() : '',
                        threadUrl: 'https://www.linkedin.com' + linkEl.getAttribute('href'),
                        receivedAt: timeEl ? timeEl.getAttribute('datetime') : new Date().toISOString(),
                    });
                }
            });
            return items.slice(0, 20);
        });

        console.log(`📬 Found ${conversations.length} conversations`);

        const batch = db.batch();
        conversations.forEach(convo => {
            const ref = db.collection('messages').doc();
            batch.set(ref, { userId: uid, ...convo, synced: true });
        });
        await batch.commit();

        await browser.close();
        return conversations.length;
    } catch (err) {
        await browser.close();
        throw err;
    }
}

// ── Reply to a message thread ─────────────────────────────────────────────────
async function replyToMessage(encryptedCookie, threadUrl, message, uid) {
    const liAt = decrypt(encryptedCookie);
    const browser = await launchBrowser();

    try {
        const page = await makePage(browser, liAt);

        console.log('💬 Opening thread:', threadUrl);
        await page.goto(threadUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        await sleep(readingDelay());

        // Playwright locator — more reliable than page.$
        const msgBox = page.locator('.msg-form__contenteditable').first();
        if (!await msgBox.isVisible().catch(() => false)) {
            await browser.close();
            return { success: false, message: 'Could not find message input' };
        }

        await msgBox.click();
        await sleep(clickDelay());

        // humanType expects a Puppeteer element handle — use page.type instead
        await page.type('.msg-form__contenteditable', message, { delay: 80 + Math.random() * 60 });
        await sleep(clickDelay());

        const sendBtn = page.locator('button.msg-form__send-button').first();
        if (await sendBtn.isVisible().catch(() => false)) {
            await sendBtn.click();
            console.log('✅ Reply sent!');
        }

        await browser.close();
        return { success: true, message: 'Reply sent successfully ✅' };
    } catch (err) {
        await browser.close();
        return { success: false, message: err.message };
    }
}

module.exports = { syncInboxMessages, replyToMessage };