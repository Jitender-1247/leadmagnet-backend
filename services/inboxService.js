const puppeteer     = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { db }        = require('../config/firebase');
const { decrypt }   = require('./linkedinService');
const { getLaunchConfig } = require('./browserConfig');
const {
    sleep, clickDelay, readingDelay, humanType
} = require('./Humandelay');
const { buildStickyProxyArgs, authenticatePage } = require('./Proxysession');

puppeteer.use(StealthPlugin());

async function launchBrowser(userId) {
    const { args, username, password } = buildStickyProxyArgs(userId);
    const browser = await puppeteer.launch(getLaunchConfig(args));
    browser._proxyAuth = { username, password };
    return browser;
}

async function makePage(browser, liAt) {
    const page = await browser.newPage();

    if (browser._proxyAuth?.username) {
        await authenticatePage(page, browser._proxyAuth);
    }

    await page.setViewport({
        width:  1280 + Math.floor(Math.random() * 200),
        height:  800 + Math.floor(Math.random() * 100),
    });

    let ua = await browser.userAgent();
    ua = ua.replace(/HeadlessChrome/g, 'Chrome');
    await page.setUserAgent(ua);

    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    await page.setCookie({
        name: 'li_at', value: liAt,
        domain: '.linkedin.com', path: '/',
        httpOnly: true, secure: true, sameSite: 'None',
    });

    return page;
}

// ── Sync inbox messages ───────────────────────────────────────────────────────
async function syncInboxMessages(uid, encryptedCookie) {
    const liAt    = decrypt(encryptedCookie);
    const browser = await launchBrowser(uid);

    try {
        const page = await makePage(browser, liAt);

        console.log('📥 Opening LinkedIn messaging…');
        await page.goto('https://www.linkedin.com/messaging/', {
            waitUntil: 'domcontentloaded', timeout: 60000,
        });

        // ── Gaussian reading pause (mean 3.5s, std 0.6s) ────────────────────
        await sleep(readingDelay());

        const conversations = await page.evaluate(() => {
            const items = [];
            document.querySelectorAll('.msg-conversation-listitem').forEach(el => {
                const nameEl    = el.querySelector('.msg-conversation-listitem__participant-names');
                const previewEl = el.querySelector('.msg-conversation-listitem__message-snippet');
                const linkEl    = el.querySelector('a');
                const timeEl    = el.querySelector('time');
                if (nameEl && linkEl) {
                    items.push({
                        name:        nameEl.innerText.trim(),
                        preview:     previewEl ? previewEl.innerText.trim() : '',
                        threadUrl:   'https://www.linkedin.com' + linkEl.getAttribute('href'),
                        receivedAt:  timeEl ? timeEl.getAttribute('datetime') : new Date().toISOString(),
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
    const liAt    = decrypt(encryptedCookie);
    const browser = await launchBrowser(uid);

    try {
        const page = await makePage(browser, liAt);

        console.log('💬 Opening thread:', threadUrl);
        await page.goto(threadUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // ── Gaussian reading pause before interacting ────────────────────────
        await sleep(readingDelay());

        const msgBox = await page.$('.msg-form__contenteditable');
        if (!msgBox) {
            await browser.close();
            return { success: false, message: 'Could not find message input' };
        }

        await msgBox.click();
        await sleep(clickDelay());

        // ── Human typing with gaussian per-character delays ──────────────────
        await humanType(msgBox, message);
        await sleep(clickDelay());

        const sendBtn = await page.$('button.msg-form__send-button');
        if (sendBtn) {
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