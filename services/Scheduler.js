/**
 * scheduler.js
 * Node-cron based scheduler for:
 * 1. Queue processor — every minute, picks up due jobs
 * 2. Running active campaigns — every 2 hours during working hours
 * 3. Checking for replies periodically
 * 4. Daily stats snapshot
 */

const cron = require('node-cron');
const { db } = require('../config/firebase');
const { runCampaign, checkForReplies, isSafeToRun, processFollowUps } = require('./automationService');
const { decrypt } = require('./linkedinService');
const { processQueue } = require('./queueService');

/**
 * ── Queue processor — every minute ───────────────────────────────────────────
 * Picks up pending jobs where scheduledFor <= now and executes them.
 */
cron.schedule('* * * * *', async () => {
  try {
    await processQueue();
  } catch (err) {
    console.error('[cron] Queue processor error:', err.message);
  }
});

/**
 * ── Follow-up processor — every hour, every day ──────────────────────────────
 * Runs independently from new connections. Processes accepted leads whose
 * nextActionAt has passed — no daily limit, no safe hours restriction.
 * Follow-ups are messages not new connections so they don't need the same guards.
 */
cron.schedule('0 * * * *', async () => {
  console.log('[cron] 🔄 Running follow-up processor');
  try {
    await processFollowUps();
  } catch (err) {
    console.error('[cron] Follow-up processor error:', err.message);
  }
});


cron.schedule('0 9,11,13,15,17 * * 1-5', async () => {
  console.log('[cron] 🕐 Running campaign scheduler');

  if (!isSafeToRun()) {
    console.log('[cron] Outside safe window, skipping');
    return;
  }

  try {
    const snap = await db.collection('campaigns')
      .where('status', '==', 'active')
      .where('isRunning', '==', false)
      .get();

    console.log(`[cron] Found ${snap.size} active campaigns`);

    // Process campaigns sequentially to avoid server overload
    for (const doc of snap.docs) {
      try {
        console.log(`[cron] Starting campaign: ${doc.id}`);
        await runCampaign(doc.id);

        // Gap between campaigns (5–15 minutes)
        const gap = Math.floor(Math.random() * 10 + 5) * 60 * 1000;
        await new Promise(r => setTimeout(r, gap));
      } catch (err) {
        console.error(`[cron] Campaign ${doc.id} error:`, err.message);
      }
    }
  } catch (err) {
    console.error('[cron] Scheduler error:', err.message);
  }
});

/**
 * Reply detection — runs every 3 hours.
 * Scrapes LinkedIn inbox for each connected user.
 */
cron.schedule('0 9,12,15,18 * * *', async () => {
  console.log('[cron] 📩 Checking for replies');

  try {
    const usersSnap = await db.collection('users')
      .where('linkedinSession', '!=', null)
      .get();

    for (const userDoc of usersSnap.docs) {
      const user = userDoc.data();
      if (!user.linkedinSession) continue;

      try {
        const liAt  = decrypt(user.linkedinSession);
        const count = await checkForReplies(userDoc.id, liAt);
        if (count > 0) {
          console.log(`[cron] Found ${count} replies for user ${userDoc.id}`);
        }

        // Gap between users
        await new Promise(r => setTimeout(r, 30000 + Math.random() * 30000));
      } catch (err) {
        console.error(`[cron] Reply check error for ${userDoc.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[cron] Reply check scheduler error:', err.message);
  }
});

/**
 * Weekend minimal runs — just 3–5 actions on Saturday/Sunday at noon.
 */
cron.schedule('0 12 * * 0,6', async () => {
  console.log('[cron] 📅 Weekend minimal run');

  try {
    const snap = await db.collection('campaigns')
      .where('status', '==', 'active')
      .where('isRunning', '==', false)
      .get();

    // Only process 2 campaigns max on weekends
    const limited = snap.docs.slice(0, 2);

    for (const doc of limited) {
      try {
        await runCampaign(doc.id);
        await new Promise(r => setTimeout(r, 15 * 60 * 1000));
      } catch (err) {
        console.error(`[cron] Weekend campaign error ${doc.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[cron] Weekend scheduler error:', err.message);
  }
});

/**
 * Daily stats snapshot — runs at midnight.
 */
cron.schedule('0 0 * * *', async () => {
  console.log('[cron] 📊 Daily stats snapshot');

  try {
    const campaignsSnap = await db.collection('campaigns').get();

    for (const doc of campaignsSnap.docs) {
      const campaign = doc.data();
      const leadsSnap = await db.collection('leads')
        .where('campaignId', '==', doc.id)
        .get();

      const leads = leadsSnap.docs.map(d => d.data());
      const stats = {
        date:       new Date().toISOString().split('T')[0],
        campaignId: doc.id,
        total:      leads.length,
        pending:    leads.filter(l => l.status === 'pending').length,
        requested:  leads.filter(l => l.status === 'requested').length,
        accepted:   leads.filter(l => ['accepted', 'replied', 'called'].includes(l.status)).length,
        replied:    leads.filter(l => ['replied', 'called'].includes(l.status)).length,
        called:     leads.filter(l => l.status === 'called').length,
      };

      await db.collection('dailyStats').add(stats);
    }
  } catch (err) {
    console.error('[cron] Daily stats error:', err.message);
  }
});

console.log('[cron] ✅ Scheduler initialized');

module.exports = {
  init: () => console.log('[cron] Scheduler is active and monitoring...')
};