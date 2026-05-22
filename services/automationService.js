/**
 * automationService.js — Playwright version
 * Full sequence engine: Connect, Message, InMail, View Profile, Follow, Endorse
 * Anti-detection: daily limits, working hours, Gaussian timing, weekend reduction
 */

const { chromium } = require('playwright');
const { getLaunchConfig } = require('./browserConfig');
const { db }     = require('../config/firebase');
const { decrypt } = require('./linkedinService');
const {
  sleep, clickDelay, readingDelay, thinkingDelay,
  maybeBreak, gaussianDelay
} = require('./Humandelay');

// ── Constants ─────────────────────────────────────────────────────────────────
const DAILY_CONNECTION_LIMIT = 20;
const WORKING_HOUR_START     = 9;
const WORKING_HOUR_END       = 18;
const WARMUP_DAYS            = 14;
const WARMUP_START_LIMIT     = 5;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const STEALTH_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver',  { get: () => undefined });
  Object.defineProperty(navigator, 'plugins',    { get: () => [1,2,3,4,5] });
  Object.defineProperty(navigator, 'languages',  { get: () => ['en-US','en'] });
  window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
  delete navigator.__proto__.webdriver;
`;

// ── Timing helpers ────────────────────────────────────────────────────────────
function isSafeToRun() {
  const now  = new Date();
  const hour = now.getHours();
  const day  = now.getDay();
  if (day === 0 || day === 6) return Math.random() < 0.3;
  if (hour < WORKING_HOUR_START || hour >= WORKING_HOUR_END) return false;
  return true;
}

function getNextSafeWindow() {
  const now  = new Date();
  const next = new Date(now);
  const day  = now.getDay();
  if (day === 6) { next.setDate(now.getDate() + 2); next.setHours(WORKING_HOUR_START, 0, 0, 0); }
  else if (day === 0) { next.setDate(now.getDate() + 1); next.setHours(WORKING_HOUR_START, 0, 0, 0); }
  else if (now.getHours() >= WORKING_HOUR_END) { next.setDate(now.getDate() + 1); next.setHours(WORKING_HOUR_START, 0, 0, 0); }
  else { next.setHours(WORKING_HOUR_START, 0, 0, 0); }
  return next.toISOString();
}

async function getDailyLimit(userId) {
  const userDoc = await db.collection('users').doc(userId).get();
  const user    = userDoc.data();
  const createdAt = user?.createdAt ? new Date(user.createdAt) : new Date();
  const daysSinceCreation = Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24));
  if (daysSinceCreation >= WARMUP_DAYS) return DAILY_CONNECTION_LIMIT;
  const progress = daysSinceCreation / WARMUP_DAYS;
  return Math.floor(WARMUP_START_LIMIT + progress * (DAILY_CONNECTION_LIMIT - WARMUP_START_LIMIT));
}

async function getConnectionsSentToday(userId) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const snap  = await db.collection('leads')
    .where('userId', '==', userId)
    .where('status', '==', 'requested')
    .where('requestedAt', '>=', today.toISOString())
    .get();
  return snap.size;
}

function applyDailyVariance(limit) {
  return Math.floor(limit * (0.8 + Math.random() * 0.2));
}

function getNextActionAt(sequence, fromIndex) {
  const nextWait = sequence[fromIndex];
  if (!nextWait || nextWait.type !== 'wait') return new Date().toISOString();
  const ms = ((nextWait.days || 0) * 86400000) + ((nextWait.hours || 0) * 3600000);
  return new Date(Date.now() + ms).toISOString();
}

// ── Browser / page factory ────────────────────────────────────────────────────
async function launchBrowser() {
  return await chromium.launch(getLaunchConfig());
}

async function makePage(browser, liAt) {
  const context = await browser.newContext({
    userAgent: UA,
    viewport: {
      width:  1280 + Math.floor(Math.random() * 200),
      height:  800 + Math.floor(Math.random() * 100),
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

  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);
  return page;
}

// ── Message personalisation ───────────────────────────────────────────────────
function personalizeMessage(template, lead) {
  return template
    .replace(/\{name\}/gi,      lead.name      || 'there')
    .replace(/\{company\}/gi,   lead.company   || 'your company')
    .replace(/\{headline\}/gi,  lead.headline  || 'your role')
    .replace(/\{location\}/gi,  lead.location  || 'your area')
    .replace(/\{firstName\}/gi, (lead.name || 'there').split(' ')[0]);
}

// ── Safe navigation helper ────────────────────────────────────────────────────
async function gotoProfile(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('h1, main', { timeout: 10000 }).catch(() => {});
    await sleep(readingDelay());
    const currentUrl = page.url();
    if (currentUrl.includes('/authwall') || currentUrl.includes('/login') || currentUrl.includes('checkpoint')) {
      return { blocked: true };
    }
    return { blocked: false };
  } catch (err) {
    console.warn('   ⚠️ Navigation error:', err.message.slice(0, 60));
    return { blocked: false, error: err.message };
  }
}

// ── Action: View Profile ──────────────────────────────────────────────────────
async function actionViewProfile(page, profileUrl) {
  console.log('👁  Viewing profile:', profileUrl);
  const nav = await gotoProfile(page, profileUrl);
  if (nav.blocked) return { success: false, message: 'Auth wall' };

  try {
    const { width, height } = page.viewportSize() || { width: 1280, height: 800 };
    await page.mouse.move(width * 0.3 + Math.random() * width * 0.4, height * 0.2 + Math.random() * height * 0.3, { steps: 10 });
    await sleep(gaussianDelay(400, 150, 200, 800));

    for (const amount of [280, 320, 280, 350, 300].map(a => a + Math.random() * 120)) {
      await page.evaluate(a => window.scrollBy({ top: a, behavior: 'smooth' }), amount).catch(() => {});
      await sleep(gaussianDelay(1200, 400, 600, 3000));
      if (Math.random() < 0.4) {
        await page.mouse.move(width * 0.2 + Math.random() * width * 0.6, height * 0.3 + Math.random() * height * 0.4, { steps: 8 });
      }
    }

    await sleep(gaussianDelay(2500, 800, 1500, 5000));
    if (Math.random() < 0.6) {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })).catch(() => {});
      await sleep(gaussianDelay(1500, 400, 800, 3000));
    }

    console.log('   ✅ Profile viewed');
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ── Action: Follow ────────────────────────────────────────────────────────────
async function actionFollow(page, profileUrl) {
  console.log('➕ Following:', profileUrl);
  const nav = await gotoProfile(page, profileUrl);
  if (nav.blocked) return { success: false, message: 'Auth wall' };

  try {
    // Try More menu first
    const moreBtn = page.locator('button[aria-label*="More actions"]').first();
    if (await moreBtn.isVisible().catch(() => false)) {
      await moreBtn.click();
      await sleep(clickDelay());
      const followOpt = page.locator('span:text("Follow"), div[aria-label*="Follow"]').first();
      if (await followOpt.isVisible().catch(() => false)) {
        await followOpt.click();
        console.log('✅ Followed via More menu');
        return { success: true };
      }
    }

    const followBtn = page.locator('button[aria-label*="Follow"]').first();
    if (await followBtn.isVisible().catch(() => false)) {
      await followBtn.click();
      await sleep(clickDelay());
      console.log('✅ Followed directly');
      return { success: true };
    }

    return { success: false, message: 'Follow button not found' };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ── Action: Connect ───────────────────────────────────────────────────────────
async function actionConnect(page, profileUrl, note, lead) {
  console.log('🤝 Connecting with:', lead.name);
  const nav = await gotoProfile(page, profileUrl);
  if (nav.blocked) return { success: false, message: 'Auth wall' };

  try {
    // Find Connect button
    let connectBtn = page.locator('button[aria-label*="Connect"]').first();
    let connectVisible = await connectBtn.isVisible().catch(() => false);

    if (!connectVisible) {
      // Try More menu
      const moreBtn = page.locator('button[aria-label*="More actions"]').first();
      if (await moreBtn.isVisible().catch(() => false)) {
        await moreBtn.click();
        await sleep(clickDelay());
        connectBtn = page.locator('span:text("Connect"), div[aria-label*="Connect"]').first();
        connectVisible = await connectBtn.isVisible().catch(() => false);
      }
    }

    if (!connectVisible) {
      const visibleBtns = await page.$$eval('button', els => els.map(e => e.getAttribute('aria-label')).filter(Boolean).slice(0, 10));
      console.warn('   ⚠️ Connect not found. Buttons:', visibleBtns.join(' | '));
      return { success: false, message: 'Connect button not found' };
    }

    await connectBtn.click();
    await sleep(clickDelay());
    await sleep(1500);

    // Handle "How do you know" modal
    const howKnowBtn = page.locator('button[aria-label*="Other"], button[data-view-name*="connect-other"]').first();
    if (await howKnowBtn.isVisible().catch(() => false)) {
      await howKnowBtn.click();
      await sleep(clickDelay());
      console.log('   Bypassed "How do you know" modal');
    }

    // Add note if provided
    if (note) {
      const addNoteBtn = page.locator('button[aria-label*="Add a note"]').first();
      if (await addNoteBtn.isVisible().catch(() => false)) {
        await addNoteBtn.click();
        await sleep(clickDelay());
        const noteBox = page.locator('textarea[name="message"]').first();
        if (await noteBox.isVisible().catch(() => false)) {
          const personalizedNote = personalizeMessage(note, lead);
          await noteBox.click();
          await page.keyboard.type(personalizedNote, { delay: 80 + Math.random() * 60 });
          await sleep(clickDelay());
        }
      }
    }

    // Find Send button
    const sendSelectors = [
      'button[aria-label*="Send now"]',
      'button[aria-label*="Send invitation"]',
      'button[aria-label*="Send without a note"]',
      'button[aria-label*="Connect"]',
    ];

    let sendBtn = null;
    for (const sel of sendSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        sendBtn = btn;
        console.log(`   Found send btn: ${sel}`);
        break;
      }
    }

    if (!sendBtn) {
      const modalBtns = await page.$$eval('button', els => els.map(e => e.getAttribute('aria-label') || e.innerText).filter(Boolean));
      console.warn('   ⚠️ Send button not found. Modal buttons:', modalBtns.join(' | '));
      return { success: false, message: 'Send button not found' };
    }

    await sendBtn.click();
    await sleep(2000);

    // Verify: Connect button should change to Pending
    const pendingBtn = page.locator('button[aria-label*="Pending"], button[aria-label*="Message"]').first();
    if (await pendingBtn.isVisible().catch(() => false)) {
      console.log('✅ Connection request confirmed — button changed to Pending/Message');
    } else {
      console.log('✅ Connection request sent (button state unclear)');
    }

    return { success: true };
  } catch (err) {
    console.error('   ❌ actionConnect error:', err.message);
    return { success: false, message: err.message };
  }
}

// ── Action: Message ───────────────────────────────────────────────────────────
async function actionMessage(page, profileUrl, messageTemplate, lead) {
  console.log('💬 Messaging:', lead.name);
  const message = personalizeMessage(messageTemplate, lead);
  const nav = await gotoProfile(page, profileUrl);
  if (nav.blocked) return { success: false, message: 'Auth wall' };

  try {
    const msgBtn = page.locator('button[aria-label*="Message"]').first();
    if (!await msgBtn.isVisible().catch(() => false)) return { success: false, message: 'Message button not found' };

    await msgBtn.click();
    await sleep(clickDelay());

    const msgBox = page.locator('.msg-form__contenteditable, [data-placeholder="Write a message…"]').first();
    if (!await msgBox.isVisible().catch(() => false)) return { success: false, message: 'Message box not found' };

    await msgBox.click();
    await sleep(clickDelay());
    await page.keyboard.type(message, { delay: 80 + Math.random() * 60 });
    await sleep(clickDelay());

    const sendBtn = page.locator('button.msg-form__send-button, [data-control-name="send"]').first();
    if (await sendBtn.isVisible().catch(() => false)) {
      await sendBtn.click();
      console.log('✅ Message sent');
      return { success: true };
    }

    return { success: false, message: 'Send button not found' };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ── Action: InMail ────────────────────────────────────────────────────────────
async function actionInMail(page, profileUrl, subject, messageTemplate, lead) {
  console.log('📧 Sending InMail to:', lead.name);
  const message = personalizeMessage(messageTemplate, lead);
  const nav = await gotoProfile(page, profileUrl);
  if (nav.blocked) return { success: false, message: 'Auth wall' };

  try {
    const inMailBtn = page.locator('button[aria-label*="InMail"], a[data-control-name="inmail"]').first();
    if (!await inMailBtn.isVisible().catch(() => false)) return { success: false, message: 'InMail button not found — requires LinkedIn Premium' };

    await inMailBtn.click();
    await sleep(readingDelay());

    const subjectInput = page.locator('input[name="subject"]').first();
    if (await subjectInput.isVisible().catch(() => false)) {
      await subjectInput.click();
      await page.keyboard.type(subject || personalizeMessage('Re: {headline}', lead), { delay: 80 });
      await sleep(clickDelay());
    }

    const bodyBox = page.locator('textarea[name="body"], .compose-form__message-field').first();
    if (!await bodyBox.isVisible().catch(() => false)) return { success: false, message: 'InMail body not found' };

    await bodyBox.click();
    await page.keyboard.type(message, { delay: 80 + Math.random() * 60 });
    await sleep(clickDelay());

    const sendBtn = page.locator('button[data-control-name="inmail_send"], button[aria-label*="Send"]').first();
    if (await sendBtn.isVisible().catch(() => false)) {
      await sendBtn.click();
      console.log('✅ InMail sent');
      return { success: true };
    }

    return { success: false, message: 'Send button not found' };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ── Action: Endorse ───────────────────────────────────────────────────────────
async function actionEndorse(page, profileUrl) {
  console.log('⭐ Endorsing skills for:', profileUrl);
  const nav = await gotoProfile(page, profileUrl);
  if (nav.blocked) return { success: false, message: 'Auth wall' };

  try {
    await page.evaluate(() => {
      const el = document.querySelector('#skills, [data-section="skills"]');
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }).catch(() => {});
    await sleep(gaussianDelay(2000, 500, 1000, 4000));

    const endorseBtns = await page.locator('button[aria-label*="Endorse"]').all();
    const toEndorse   = endorseBtns.slice(0, 3);

    for (const btn of toEndorse) {
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        await sleep(gaussianDelay(1500, 400, 800, 3000));
      }
    }

    console.log(`✅ Endorsed ${toEndorse.length} skills`);
    return { success: true, endorsed: toEndorse.length };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ── Reply detection ───────────────────────────────────────────────────────────
async function checkForReplies(userId, liAt) {
  const browser = await launchBrowser();
  try {
    const page = await makePage(browser, liAt);

    console.log('[checkForReplies] nav: https://www.linkedin.com/messaging/');
    await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(readingDelay());

    const threads = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('.msg-conversation-listitem').forEach(el => {
        const nameEl   = el.querySelector('.msg-conversation-listitem__participant-names');
        const timeEl   = el.querySelector('time');
        const unreadEl = el.querySelector('.msg-conversation-listitem__unread-count');
        const linkEl   = el.querySelector('a');
        if (nameEl && linkEl && unreadEl) {
          items.push({
            name:      nameEl.innerText.trim(),
            threadUrl: 'https://www.linkedin.com' + linkEl.getAttribute('href'),
            hasUnread: parseInt(unreadEl.innerText || '0') > 0,
            time:      timeEl ? timeEl.getAttribute('datetime') : null,
          });
        }
      });
      return items.filter(i => i.hasUnread);
    }).catch(() => []);

    for (const thread of threads) {
      const leadsSnap = await db.collection('leads')
        .where('userId', '==', userId)
        .where('name', '==', thread.name)
        .where('status', '==', 'accepted')
        .get();

      for (const doc of leadsSnap.docs) {
        await doc.ref.update({ status: 'replied', repliedAt: new Date().toISOString() });
        console.log(`📩 Reply detected from ${thread.name}`);
      }
    }

    await browser.close();
    return threads.length;
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// ── Step executor ─────────────────────────────────────────────────────────────
async function executeStep(page, step, lead, profileUrl) {
  switch (step.type) {
    case 'connect':      return actionConnect(page, profileUrl, step.note || '', lead);
    case 'message':      return actionMessage(page, profileUrl, step.message || '', lead);
    case 'inmail':       return actionInMail(page, profileUrl, step.subject || '', step.message || '', lead);
    case 'view_profile': return actionViewProfile(page, profileUrl);
    case 'follow':       return actionFollow(page, profileUrl);
    case 'endorse':      return actionEndorse(page, profileUrl);
    case 'wait':         return { success: true, skipped: true };
    default:             return { success: false, message: `Unknown step type: ${step.type}` };
  }
}

// ── Main campaign runner ──────────────────────────────────────────────────────
async function runCampaign(campaignId) {
  const campaignRef = db.collection('campaigns').doc(campaignId);
  const campaignDoc = await campaignRef.get();

  if (!campaignDoc.exists) throw new Error('Campaign not found');
  const campaign = campaignDoc.data();

  if (campaign.status !== 'active') {
    console.log(`[campaign] ${campaignId} is ${campaign.status}, skipping`);
    return;
  }

  if (campaign.isRunning) {
    console.log(`[campaign] ${campaignId} already running, skipping`);
    return { status: 'already_running' };
  }

  await campaignRef.update({ isRunning: true, lastStartedAt: new Date().toISOString() });
  const userId = campaign.userId;

  try {
    if (!isSafeToRun()) {
      const nextWindow = getNextSafeWindow();
      console.log(`[automation] Outside safe hours. Next window: ${nextWindow}`);
      await campaignRef.update({ isRunning: false, nextScheduledAt: nextWindow });
      return { status: 'scheduled', nextWindow };
    }

    const dailyLimit  = await getDailyLimit(userId);
    const variedLimit = applyDailyVariance(dailyLimit);
    const sentToday   = await getConnectionsSentToday(userId);
    const remaining   = variedLimit - sentToday;

    if (remaining <= 0) {
      console.log(`[automation] Daily limit reached (${sentToday}/${variedLimit})`);
      await campaignRef.update({ isRunning: false });
      return { status: 'daily_limit_reached', sentToday, limit: variedLimit };
    }

    console.log(`[automation] Daily budget: ${remaining} actions remaining`);

    const userDoc = await db.collection('users').doc(userId).get();
    const user    = userDoc.data();

    if (!user.linkedinSession) {
      console.log('[automation] No LinkedIn session');
      await campaignRef.update({ isRunning: false });
      return;
    }

    const liAt    = decrypt(user.linkedinSession);
    const browser = await launchBrowser();
    const page    = await makePage(browser, liAt);

    const sequence = campaign.sequence || [];
    if (sequence.length === 0) {
      console.log('[automation] No sequence defined');
      await browser.close();
      await campaignRef.update({ isRunning: false });
      return;
    }

    const leadsSnap = await db.collection('leads')
      .where('campaignId', '==', campaignId)
      .where('status', '==', 'pending')
      .limit(remaining)
      .get();

    console.log(`[campaign] Processing ${leadsSnap.size} leads`);

    let actionsCount = 0;

    for (const leadDoc of leadsSnap.docs) {
      if (actionsCount >= remaining) break;

      const lead      = { id: leadDoc.id, ...leadDoc.data() };
      const firstStep = sequence.find(s => s.type !== 'wait');
      if (!firstStep) continue;

      try {
        const result = await executeStep(page, firstStep, lead, lead.profileUrl);

        if (result.success && !result.skipped) {
          const newStatus = firstStep.type === 'connect' ? 'requested' : 'contacted';
          await leadDoc.ref.update({
            status: newStatus, currentStep: 1,
            requestedAt: new Date().toISOString(),
            nextActionAt: getNextActionAt(sequence, 1),
          });
          actionsCount++;
          console.log(`[campaign] ✅ ${firstStep.type} succeeded for ${lead.name} — total: ${actionsCount}`);
        } else {
          console.warn(`[campaign] ⚠️ ${firstStep.type} failed for ${lead.name}: ${result.message || 'unknown'}`);
        }

        await maybeBreak(6);
        await sleep(gaussianDelay(180000, 60000, 120000, 480000));
      } catch (err) {
        console.error(`[lead] Error processing ${lead.name}:`, err.message);
      }
    }

    await browser.close();
    await campaignRef.update({ isRunning: false, lastRunAt: new Date().toISOString(), lastRunCount: actionsCount });
    console.log(`[campaign] ✅ Done. ${actionsCount} new connections sent.`);

  } catch (err) {
    console.error('[campaign] Fatal error:', err.message);
    await campaignRef.update({ isRunning: false });
    throw err;
  }
}

// ── Follow-up processor ───────────────────────────────────────────────────────
async function processFollowUps() {
  console.log('[follow-up] 🔄 Checking for due follow-ups...');

  try {
    const campaignsSnap = await db.collection('campaigns').where('status', '==', 'active').get();
    if (campaignsSnap.empty) return;

    for (const campaignDoc of campaignsSnap.docs) {
      const campaign   = campaignDoc.data();
      const campaignId = campaignDoc.id;
      const sequence   = campaign.sequence || [];
      if (sequence.length === 0) continue;

      const userDoc = await db.collection('users').doc(campaign.userId).get();
      const user    = userDoc.data();
      if (!user?.linkedinSession) continue;

      const leadsSnap = await db.collection('leads')
        .where('campaignId', '==', campaignId)
        .where('status', '==', 'accepted')
        .get();

      if (leadsSnap.empty) continue;

      const now      = new Date();
      const dueLeads = leadsSnap.docs.filter(doc => {
        const lead = doc.data();
        if (!lead.nextActionAt) return true;
        return new Date(lead.nextActionAt) <= now;
      });

      if (dueLeads.length === 0) continue;

      console.log(`[follow-up] Campaign ${campaignId}: ${dueLeads.length} leads due`);

      const liAt    = decrypt(user.linkedinSession);
      const browser = await launchBrowser();
      const page    = await makePage(browser, liAt);
      let followUpCount = 0;

      for (const leadDoc of dueLeads) {
        const lead        = { id: leadDoc.id, ...leadDoc.data() };
        const currentStep = lead.currentStep || 0;

        let stepIdx = currentStep;
        let step    = sequence[stepIdx];
        while (step && step.type === 'wait') { stepIdx++; step = sequence[stepIdx]; }

        if (!step) {
          await leadDoc.ref.update({ status: 'sequence_complete', completedAt: new Date().toISOString() });
          console.log(`[follow-up] ✅ ${lead.name} completed full sequence`);
          continue;
        }

        if (step.type === 'condition') {
          await leadDoc.ref.update({ currentStep: stepIdx + 1, nextActionAt: getNextActionAt(sequence, stepIdx + 1) });
          continue;
        }

        try {
          console.log(`[follow-up] Sending ${step.type} to ${lead.name} (step ${stepIdx + 1})`);
          const result = await executeStep(page, step, lead, lead.profileUrl);

          if (result.success && !result.skipped) {
            await leadDoc.ref.update({
              currentStep: stepIdx + 1,
              nextActionAt: getNextActionAt(sequence, stepIdx + 1),
              lastActionAt: new Date().toISOString(),
              lastStepType: step.type,
            });
            followUpCount++;
            console.log(`[follow-up] ✅ ${step.type} sent to ${lead.name}`);
          } else {
            await leadDoc.ref.update({ lastError: result.message || 'Step failed', lastErrorAt: new Date().toISOString() });
            console.warn(`[follow-up] ⚠️ Failed for ${lead.name}: ${result.message}`);
          }

          await sleep(gaussianDelay(90000, 30000, 60000, 180000));
        } catch (err) {
          console.error(`[follow-up] ❌ Error for ${lead.name}:`, err.message);
          await leadDoc.ref.update({ lastError: err.message, lastErrorAt: new Date().toISOString() });
        }
      }

      await browser.close();
      console.log(`[follow-up] Campaign ${campaignId}: ${followUpCount} follow-ups sent`);
      await sleep(gaussianDelay(30000, 10000, 15000, 60000));
    }
  } catch (err) {
    console.error('[follow-up] Fatal error:', err.message);
  }
}

async function checkAndSendMessages(campaignId) {
  const campaignDoc = await db.collection('campaigns').doc(campaignId).get();
  if (!campaignDoc.exists) return;
  const campaign = campaignDoc.data();
  const userDoc  = await db.collection('users').doc(campaign.userId).get();
  const user     = userDoc.data();
  if (!user.linkedinSession) return;
  const liAt = decrypt(user.linkedinSession);
  try { await checkForReplies(campaign.userId, liAt); } catch (err) { console.error('[reply-check] Error:', err.message); }
  await runCampaign(campaignId);
}

module.exports = {
  runCampaign,
  checkAndSendMessages,
  checkForReplies,
  processFollowUps,
  personalizeMessage,
  isSafeToRun,
  getNextSafeWindow,
  getDailyLimit,
};