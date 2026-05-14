/**
 * automationService.js
 * Full sequence engine — Dripify-style multi-step drip campaigns.
 * Supports: Connect, Message, InMail, View Profile, Follow, Endorse
 * Anti-detection: daily limits, working hours, Gaussian timing, weekend reduction,
 * session warmup, random long breaks.
 */

const puppeteer     = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { getLaunchConfig } = require('./browserConfig');
const { db }        = require('../config/firebase');
const { decrypt }   = require('./linkedinService');
const {
  sleep, clickDelay, readingDelay, thinkingDelay,
  humanType, maybeBreak, gaussianDelay
} = require('./Humandelay');
const { buildStickyProxyArgs, authenticatePage } = require('./Proxysession');

puppeteer.use(StealthPlugin());

// ── Constants ────────────────────────────────────────────────────────────────
const DAILY_CONNECTION_LIMIT = 20;
const WORKING_HOUR_START     = 9;   // 9 AM
const WORKING_HOUR_END       = 18;  // 6 PM
const LUNCH_START            = 12;
const LUNCH_END              = 13;
const WARMUP_DAYS            = 14;  // ramp up over 2 weeks
const WARMUP_START_LIMIT     = 5;

// ── Anti-detection helpers ───────────────────────────────────────────────────

/**
 * Is it safe to run right now?
 * Considers working hours, weekends, lunch slowdown.
 */
function isSafeToRun() {
  const now  = new Date();
  const hour = now.getHours();
  const day  = now.getDay(); // 0=Sun, 6=Sat

  // Weekends: allow very few actions
  if (day === 0 || day === 6) {
    // Only run ~30% of the time on weekends
    return Math.random() < 0.3;
  }

  // Outside working hours: don't run
  if (hour < WORKING_HOUR_START || hour >= WORKING_HOUR_END) return false;

  // Lunch slowdown: 50% chance of skipping
  if (hour >= LUNCH_START && hour < LUNCH_END) {
    return Math.random() < 0.5;
  }

  return true;
}

/**
 * Returns a human-readable string of when the next safe window is.
 */
function getNextSafeWindow() {
  const now  = new Date();
  const hour = now.getHours();
  const day  = now.getDay(); // 0=Sun, 6=Sat

  const pad = (n) => String(n).padStart(2, '0');

  // It's a weekend
  if (day === 0 || day === 6) {
    // Find next Monday
    const daysUntilMonday = day === 6 ? 2 : 1;
    const next = new Date(now);
    next.setDate(now.getDate() + daysUntilMonday);
    next.setHours(WORKING_HOUR_START, 0, 0, 0);
    return `Monday at 09:00 AM`;
  }

  // It's a weekday but before working hours
  if (hour < WORKING_HOUR_START) {
    return `today at 09:00 AM`;
  }

  // It's after working hours — next working day
  if (hour >= WORKING_HOUR_END) {
    const isFriday = day === 5;
    if (isFriday) {
      return `Monday at 09:00 AM`;
    }
    return `tomorrow at 09:00 AM`;
  }

  // It's lunch slowdown — very soon
  if (hour >= LUNCH_START && hour < LUNCH_END) {
    return `after 1:00 PM today`;
  }

  return `shortly`;
}


//  * New accounts start at 5/day and ramp to 20 over WARMUP_DAYS.
//  */
async function getDailyLimit(userId) {
  const userDoc = await db.collection('users').doc(userId).get();
  const user    = userDoc.data();
  const created = new Date(user.createdAt);
  const daysSince = Math.floor((Date.now() - created.getTime()) / (1000 * 60 * 60 * 24));

  if (daysSince >= WARMUP_DAYS) return DAILY_CONNECTION_LIMIT;

  // Linear warmup
  const limit = Math.round(WARMUP_START_LIMIT + ((DAILY_CONNECTION_LIMIT - WARMUP_START_LIMIT) * daysSince / WARMUP_DAYS));
  return Math.max(WARMUP_START_LIMIT, limit);
}

/**
 * How many connections has this user sent today?
 */
async function getConnectionsSentToday(userId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const snap = await db.collection('leads')
    .where('userId', '==', userId)
    .where('status', '==', 'requested')
    .where('requestedAt', '>=', today.toISOString())
    .get();

  return snap.size;
}

/**
 * Random daily variance — never exactly the same number each day.
 * Returns a number between 80%–100% of the limit.
 */
function applyDailyVariance(limit) {
  const factor = 0.8 + Math.random() * 0.2;
  return Math.floor(limit * factor);
}

// ── Browser factory ──────────────────────────────────────────────────────────
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

  // Randomize viewport slightly
  await page.setViewport({
    width:  1280 + Math.floor(Math.random() * 200),
    height:  800 + Math.floor(Math.random() * 100),
  });

  let ua = await browser.userAgent();
  ua = ua.replace(/HeadlessChrome/g, 'Chrome');
  await page.setUserAgent(ua);

  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  // Override automation detection
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
  });

  await page.setCookie({
    name: 'li_at', value: liAt,
    domain: '.linkedin.com', path: '/',
    httpOnly: true, secure: true, sameSite: 'None',
  });

  return page;
}

// ── Message personalization ──────────────────────────────────────────────────
function personalizeMessage(template, lead) {
  return template
    .replace(/\{name\}/gi,      lead.name      || 'there')
    .replace(/\{company\}/gi,   lead.company   || 'your company')
    .replace(/\{headline\}/gi,  lead.headline  || 'your role')
    .replace(/\{location\}/gi,  lead.location  || 'your area')
    .replace(/\{firstName\}/gi, (lead.name || 'there').split(' ')[0]);
}

// ── Action implementations ───────────────────────────────────────────────────

async function actionViewProfile(page, profileUrl) {
  console.log('👁  Viewing profile:', profileUrl);

  try {
    // Use networkidle2 so LinkedIn's analytics pixel fires — this is what
    // actually registers the profile view in LinkedIn's system
    await page.goto(profileUrl, {
      waitUntil: 'networkidle2',
      timeout:   60000
    }).catch(async () => {
      // If networkidle2 times out (common on slow connections), fall back
      // to waiting for the profile name element instead
      console.log('   ⚠️  networkidle2 timed out — waiting for profile element');
      await page.waitForSelector('h1', { timeout: 15000 }).catch(() => {});
    });

    // Verify we're actually on a profile page, not auth wall or 404
    const currentUrl = page.url();
    if (
      currentUrl.includes('/authwall') ||
      currentUrl.includes('/login')    ||
      currentUrl.includes('checkpoint')
    ) {
      return { success: false, message: 'Auth wall hit' };
    }

    // Wait for the profile card to render
    await page.waitForSelector([
      '.pv-top-card',
      'section.artdeco-card',
      'h1.text-heading-xlarge',
      'h1',
    ].join(', '), { timeout: 10000 }).catch(() => {});

    // Reading pause — simulate landing on the page and starting to read
    await sleep(readingDelay());

    // Simulate human mouse movement before scrolling
    const { width, height } = page.viewport() || { width: 1280, height: 800 };
    await page.mouse.move(
      width  * 0.3 + Math.random() * width  * 0.4,
      height * 0.2 + Math.random() * height * 0.3,
      { steps: 10 }
    );
    await sleep(gaussianDelay(400, 150, 200, 800));

    // Scroll naturally — each scroll is a separate Puppeteer call with a
    // real delay between them (fixes the broken page.evaluate scroll)
    const scrollSteps = [
      { amount: 280 + Math.random() * 120 },
      { amount: 320 + Math.random() * 150 },
      { amount: 280 + Math.random() * 200 },
      { amount: 350 + Math.random() * 100 },
      { amount: 300 + Math.random() * 180 },
    ];

    for (const step of scrollSteps) {
      await page.evaluate(amount => window.scrollBy({ top: amount, behavior: 'smooth' }), step.amount);

      // Random pause between scrolls (like a human reading each section)
      await sleep(gaussianDelay(1200, 400, 600, 3000));

      // Occasionally move the mouse while scrolling (more human-like)
      if (Math.random() < 0.4) {
        await page.mouse.move(
          width  * 0.2 + Math.random() * width  * 0.6,
          height * 0.3 + Math.random() * height * 0.4,
          { steps: 8 }
        );
      }
    }

    // Pause at bottom of page (simulates reading experience/about section)
    await sleep(gaussianDelay(2500, 800, 1500, 5000));

    // Scroll back up slowly (real users often scroll back up)
    if (Math.random() < 0.6) {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      await sleep(gaussianDelay(1500, 400, 800, 3000));
    }

    console.log('   ✅ Profile viewed successfully');
    return { success: true };

  } catch (err) {
    console.warn('   ⚠️  View profile error:', err.message);
    return { success: false, message: err.message };
  }
}

async function actionFollow(page, profileUrl) {
  console.log('➕ Following:', profileUrl);
  await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 60000 })
    .catch(() => page.waitForSelector('h1', { timeout: 15000 }).catch(() => {}));
  await sleep(readingDelay());

  try {
    // Try "More" button first (follow is often inside it)
    const moreBtn = await page.$('button[aria-label*="More actions"]');
    if (moreBtn) {
      await moreBtn.click();
      await sleep(clickDelay());
      const followOpt = await page.$x('//span[contains(text(), "Follow")]');
      if (followOpt.length > 0) {
        await followOpt[0].click();
        console.log('✅ Followed via More menu');
        return { success: true };
      }
    }

    // Direct follow button
    const followBtn = await page.$('button[aria-label*="Follow"]');
    if (followBtn) {
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

async function actionConnect(page, profileUrl, note, lead) {
  console.log('🤝 Connecting with:', lead.name);
  await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 60000 })
    .catch(() => page.waitForSelector('h1', { timeout: 15000 }).catch(() => {}));
  await sleep(readingDelay());

  try {
    // Find Connect button (may be inside "More" dropdown)
    let connectBtn = await page.$('button[aria-label*="Connect"]');

    if (!connectBtn) {
      const moreBtn = await page.$('button[aria-label*="More actions"]');
      if (moreBtn) {
        await moreBtn.click();
        await sleep(clickDelay());
        const btns = await page.$x('//span[contains(text(), "Connect")]');
        if (btns.length > 0) connectBtn = btns[0];
      }
    }

    if (!connectBtn) return { success: false, message: 'Connect button not found' };

    await connectBtn.click();
    await sleep(clickDelay());

    // Add a note?
    if (note) {
      const addNoteBtn = await page.$('button[aria-label*="Add a note"]');
      if (addNoteBtn) {
        await addNoteBtn.click();
        await sleep(clickDelay());
        const noteBox = await page.$('textarea[name="message"]');
        if (noteBox) {
          const personalizedNote = personalizeMessage(note, lead);
          await humanType(noteBox, personalizedNote);
          await sleep(clickDelay());
        }
      }
    }

    // Send
    const sendBtn = await page.$('button[aria-label*="Send now"]') ||
                    await page.$('button[aria-label*="Send invitation"]');
    if (sendBtn) {
      await sendBtn.click();
      console.log('✅ Connection request sent');
      return { success: true };
    }

    return { success: false, message: 'Send button not found' };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

async function actionMessage(page, profileUrl, messageTemplate, lead) {
  console.log('💬 Messaging:', lead.name);
  const message = personalizeMessage(messageTemplate, lead);

  await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 60000 })
    .catch(() => page.waitForSelector('h1', { timeout: 15000 }).catch(() => {}));
  await sleep(readingDelay());

  try {
    const msgBtn = await page.$('button[aria-label*="Message"]');
    if (!msgBtn) return { success: false, message: 'Message button not found' };

    await msgBtn.click();
    await sleep(clickDelay());

    const msgBox = await page.$('.msg-form__contenteditable') ||
                   await page.$('[data-placeholder="Write a message…"]');
    if (!msgBox) return { success: false, message: 'Message box not found' };

    await msgBox.click();
    await sleep(clickDelay());
    await humanType(msgBox, message);
    await sleep(clickDelay());

    const sendBtn = await page.$('button.msg-form__send-button') ||
                    await page.$('[data-control-name="send"]');
    if (sendBtn) {
      await sendBtn.click();
      console.log('✅ Message sent');
      return { success: true };
    }

    return { success: false, message: 'Send button not found' };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

async function actionInMail(page, profileUrl, subject, messageTemplate, lead) {
  console.log('📧 Sending InMail to:', lead.name);
  const message = personalizeMessage(messageTemplate, lead);

  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(readingDelay());

  try {
    const inMailBtn = await page.$('button[aria-label*="InMail"]') ||
                      await page.$('a[data-control-name="inmail"]');
    if (!inMailBtn) return { success: false, message: 'InMail button not found' };

    await inMailBtn.click();
    await sleep(readingDelay());

    // Subject
    const subjectInput = await page.$('input[name="subject"]');
    if (subjectInput) {
      await humanType(subjectInput, subject || personalizeMessage('Re: {headline}', lead));
      await sleep(clickDelay());
    }

    // Body
    const bodyBox = await page.$('textarea[name="body"]') ||
                    await page.$('.compose-form__message-field');
    if (!bodyBox) return { success: false, message: 'InMail body not found' };

    await humanType(bodyBox, message);
    await sleep(clickDelay());

    const sendBtn = await page.$('button[data-control-name="inmail_send"]') ||
                    await page.$('button[aria-label*="Send"]');
    if (sendBtn) {
      await sendBtn.click();
      console.log('✅ InMail sent');
      return { success: true };
    }

    return { success: false, message: 'Send button not found' };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

async function actionEndorse(page, profileUrl) {
  console.log('⭐ Endorsing skills for:', profileUrl);
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(readingDelay());

  try {
    // Scroll to skills section
    await page.evaluate(() => {
      const skillsSection = document.querySelector('#skills') ||
                            document.querySelector('[data-section="skills"]');
      if (skillsSection) skillsSection.scrollIntoView({ behavior: 'smooth' });
    });
    await sleep(gaussianDelay(2000, 500, 1000, 4000));

    // Click endorse buttons (up to 3)
    const endorseBtns = await page.$$('button[aria-label*="Endorse"]');
    const toEndorse   = endorseBtns.slice(0, 3);

    for (const btn of toEndorse) {
      await btn.click();
      await sleep(gaussianDelay(1500, 400, 800, 3000));
    }

    console.log(`✅ Endorsed ${toEndorse.length} skills`);
    return { success: true, endorsed: toEndorse.length };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ── Reply detection ──────────────────────────────────────────────────────────
async function checkForReplies(userId, liAt) {
  const browser = await launchBrowser(userId);
  try {
    const page = await makePage(browser, liAt);
    await page.goto('https://www.linkedin.com/messaging/', {
      waitUntil: 'domcontentloaded', timeout: 60000
    });
    await sleep(readingDelay());

    const threads = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('.msg-conversation-listitem').forEach(el => {
        const nameEl    = el.querySelector('.msg-conversation-listitem__participant-names');
        const timeEl    = el.querySelector('time');
        const unreadEl  = el.querySelector('.msg-conversation-listitem__unread-count');
        const linkEl    = el.querySelector('a');
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
    });

    // Update leads that have replied
    for (const thread of threads) {
      const leadsSnap = await db.collection('leads')
        .where('userId', '==', userId)
        .where('name', '==', thread.name)
        .where('status', '==', 'accepted')
        .get();

      for (const doc of leadsSnap.docs) {
        await doc.ref.update({
          status:    'replied',
          repliedAt: new Date().toISOString(),
        });
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

// ── Sequence executor ────────────────────────────────────────────────────────

/**
 * Execute one step of the sequence for a lead.
 * Returns whether the step was executed.
 */
async function executeStep(page, step, lead, profileUrl) {
  switch (step.type) {
    case 'connect':
      return actionConnect(page, profileUrl, step.note || '', lead);

    case 'message':
      return actionMessage(page, profileUrl, step.message || '', lead);

    case 'inmail':
      return actionInMail(page, profileUrl, step.subject || '', step.message || '', lead);

    case 'view_profile':
      return actionViewProfile(page, profileUrl);

    case 'follow':
      return actionFollow(page, profileUrl);

    case 'endorse':
      return actionEndorse(page, profileUrl);

    case 'wait':
      // Wait steps are handled by the scheduler, not here
      return { success: true, skipped: true };

    default:
      return { success: false, message: `Unknown step type: ${step.type}` };
  }
}

// ── Main campaign runner ─────────────────────────────────────────────────────

/**
 * Run a campaign's sequence for all eligible leads.
 * Respects daily limits, working hours, concurrency lock.
 */
async function runCampaign(campaignId) {
  const campaignRef = db.collection('campaigns').doc(campaignId);
  const campaignDoc = await campaignRef.get();

  if (!campaignDoc.exists) throw new Error('Campaign not found');

  const campaign = campaignDoc.data();

  if (campaign.status !== 'active') {
    console.log(`[campaign] ${campaignId} is ${campaign.status}, skipping`);
    return;
  }

  // ── Concurrency lock ──────────────────────────────────────────────────────
  if (campaign.isRunning) {
    console.log(`[campaign] ${campaignId} is already running, skipping`);
    return { status: 'already_running' };
  }

  await campaignRef.update({ isRunning: true, lastStartedAt: new Date().toISOString() });

  const userId = campaign.userId;

  try {
    // ── Anti-detection: working hours check ──────────────────────────────────
    if (!isSafeToRun()) {
      const nextWindow = getNextSafeWindow();
      console.log(`[automation] Outside safe hours. Next window: ${nextWindow}`);
      await campaignRef.update({ isRunning: false, nextScheduledAt: nextWindow });
      return { status: 'scheduled', nextWindow };
    }

    // ── Daily limit check ────────────────────────────────────────────────────
    const dailyLimit    = await getDailyLimit(userId);
    const variedLimit   = applyDailyVariance(dailyLimit);
    const sentToday     = await getConnectionsSentToday(userId);
    const remaining     = variedLimit - sentToday;

    if (remaining <= 0) {
      console.log(`[automation] Daily limit reached (${sentToday}/${variedLimit})`);
      await campaignRef.update({ isRunning: false });
      return { status: 'daily_limit_reached', sentToday, limit: variedLimit };
    }

    console.log(`[automation] Daily budget: ${remaining} actions remaining`);

    // ── Get user LinkedIn session ─────────────────────────────────────────────
    const userDoc = await db.collection('users').doc(userId).get();
    const user    = userDoc.data();

    if (!user.linkedinSession) {
      console.log('[automation] No LinkedIn session');
      await campaignRef.update({ isRunning: false });
      return;
    }

    const liAt    = decrypt(user.linkedinSession);
    const browser = await launchBrowser(userId);
    const page    = await makePage(browser, liAt);

    // ── Get sequence steps ────────────────────────────────────────────────────
    const sequence = campaign.sequence || [];
    if (sequence.length === 0) {
      console.log('[automation] No sequence defined');
      await browser.close();
      await campaignRef.update({ isRunning: false });
      return;
    }

    // ── Get pending leads ─────────────────────────────────────────────────────
    const leadsSnap = await db.collection('leads')
      .where('campaignId', '==', campaignId)
      .where('status', '==', 'pending')
      .limit(remaining)
      .get();

    console.log(`[campaign] Processing ${leadsSnap.size} leads`);

    let actionsCount = 0;

    for (const leadDoc of leadsSnap.docs) {
      if (actionsCount >= remaining) break;

      const lead    = { id: leadDoc.id, ...leadDoc.data() };
      const firstStep = sequence.find(s => s.type !== 'wait');

      if (!firstStep) continue;

      try {
        const result = await executeStep(page, firstStep, lead, lead.profileUrl);

        if (result.success && !result.skipped) {
          const newStatus = firstStep.type === 'connect' ? 'requested' : 'contacted';
          await leadDoc.ref.update({
            status:       newStatus,
            currentStep:  1,
            requestedAt:  new Date().toISOString(),
            nextActionAt: getNextActionAt(sequence, 1),
          });
          actionsCount++;
        }

        // Human-like delay between actions (2–8 minutes)
        await maybeBreak(6);
        await sleep(gaussianDelay(180000, 60000, 120000, 480000));

      } catch (err) {
        console.error(`[lead] Error processing ${lead.name}:`, err.message);
      }
    }

    await browser.close();

    await campaignRef.update({
      isRunning:    false,
      lastRunAt:    new Date().toISOString(),
      lastRunCount: actionsCount,
    });

    console.log(`[campaign] ✅ Done. ${actionsCount} new connections sent.`);

  } catch (err) {
    console.error('[campaign] Fatal error:', err.message);
    await campaignRef.update({ isRunning: false });
    throw err;
  }
}

/**
 * Calculate when the next action should happen based on wait steps.
 */
function getNextActionAt(sequence, fromIndex) {
  const nextWait = sequence[fromIndex];
  if (!nextWait || nextWait.type !== 'wait') return new Date().toISOString();

  const days  = nextWait.days  || 0;
  const hours = nextWait.hours || 0;
  const ms    = (days * 24 * 60 * 60 * 1000) + (hours * 60 * 60 * 1000);

  return new Date(Date.now() + ms).toISOString();
}

// ── Follow-up processor ───────────────────────────────────────────────────────
/**
 * Runs independently from runCampaign.
 * Processes ALL accepted leads across ALL active campaigns
 * whose nextActionAt has passed — regardless of daily connection limit
 * or safe hours (follow-ups are messages, not new connections).
 *
 * Called by the scheduler every hour.
 */
async function processFollowUps() {
  console.log('[follow-up] 🔄 Checking for due follow-ups...');

  try {
    // Get all active campaigns
    const campaignsSnap = await db.collection('campaigns')
      .where('status', '==', 'active')
      .get();

    if (campaignsSnap.empty) return;

    for (const campaignDoc of campaignsSnap.docs) {
      const campaign   = campaignDoc.data();
      const campaignId = campaignDoc.id;
      const sequence   = campaign.sequence || [];

      if (sequence.length === 0) continue;

      // Get user LinkedIn session
      const userDoc = await db.collection('users').doc(campaign.userId).get();
      const user    = userDoc.data();
      if (!user?.linkedinSession) continue;

      // Get all accepted leads for this campaign
      const leadsSnap = await db.collection('leads')
        .where('campaignId', '==', campaignId)
        .where('status', '==', 'accepted')
        .get();

      if (leadsSnap.empty) continue;

      // Filter to only leads whose nextActionAt has passed (in memory — no index needed)
      const now      = new Date();
      const dueleads = leadsSnap.docs.filter(doc => {
        const lead = doc.data();
        // No nextActionAt means it was never set — process it
        if (!lead.nextActionAt) return true;
        return new Date(lead.nextActionAt) <= now;
      });

      if (dueleads.length === 0) continue;

      console.log(`[follow-up] Campaign ${campaignId}: ${dueleads.length} leads due`);

      // Launch browser for this campaign's user
      const liAt    = decrypt(user.linkedinSession);
      const browser = await launchBrowser(campaign.userId);
      const page    = await makePage(browser, liAt);

      let followUpCount = 0;

      for (const leadDoc of dueleads) {
        const lead        = { id: leadDoc.id, ...leadDoc.data() };
        const currentStep = lead.currentStep || 0;

        // Find next non-wait step starting from currentStep
        let stepIdx = currentStep;
        let step    = sequence[stepIdx];

        // Skip wait steps
        while (step && step.type === 'wait') {
          stepIdx++;
          step = sequence[stepIdx];
        }

        // No more steps — lead has completed the full sequence
        if (!step) {
          await leadDoc.ref.update({
            status:      'sequence_complete',
            completedAt: new Date().toISOString(),
          });
          console.log(`[follow-up] ✅ ${lead.name} completed full sequence`);
          continue;
        }

        // Skip condition nodes — handle them as pass-through for now
        if (step.type === 'condition') {
          await leadDoc.ref.update({
            currentStep:  stepIdx + 1,
            nextActionAt: getNextActionAt(sequence, stepIdx + 1),
          });
          continue;
        }

        try {
          console.log(`[follow-up] Sending ${step.type} to ${lead.name} (step ${stepIdx + 1})`);

          const result = await executeStep(page, step, lead, lead.profileUrl);

          if (result.success && !result.skipped) {
            await leadDoc.ref.update({
              currentStep:  stepIdx + 1,
              nextActionAt: getNextActionAt(sequence, stepIdx + 1),
              lastActionAt: new Date().toISOString(),
              lastStepType: step.type,
            });
            followUpCount++;
            console.log(`[follow-up] ✅ ${step.type} sent to ${lead.name}`);
          } else {
            // Step failed — retry next run, don't advance
            await leadDoc.ref.update({
              lastError:   result.message || 'Step failed',
              lastErrorAt: new Date().toISOString(),
            });
            console.warn(`[follow-up] ⚠️  Failed for ${lead.name}: ${result.message}`);
          }

          // Human delay between follow-ups (1–3 minutes — shorter than new connections)
          await sleep(gaussianDelay(90000, 30000, 60000, 180000));

        } catch (err) {
          console.error(`[follow-up] ❌ Error for ${lead.name}:`, err.message);
          await leadDoc.ref.update({
            lastError:   err.message,
            lastErrorAt: new Date().toISOString(),
          });
        }
      }

      await browser.close();
      console.log(`[follow-up] Campaign ${campaignId}: ${followUpCount} follow-ups sent`);

      // Gap between campaigns
      await sleep(gaussianDelay(30000, 10000, 15000, 60000));
    }

  } catch (err) {
    console.error('[follow-up] Fatal error:', err.message);
  }
}

// ── Check and advance sequences for all active campaigns ────────────────────
async function checkAndSendMessages(campaignId) {
  const campaignDoc = await db.collection('campaigns').doc(campaignId).get();
  if (!campaignDoc.exists) return;

  const campaign = campaignDoc.data();
  const userId   = campaign.userId;

  const userDoc = await db.collection('users').doc(userId).get();
  const user    = userDoc.data();
  if (!user.linkedinSession) return;

  const liAt = decrypt(user.linkedinSession);

  // Also check for replies while we're at it
  try {
    await checkForReplies(userId, liAt);
  } catch (err) {
    console.error('[reply-check] Error:', err.message);
  }

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