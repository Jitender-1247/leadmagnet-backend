/**
 * Scheduler.js
 * Node-cron based scheduler — updated for HTTP+Cookies approach.
 * No Playwright dependency. Uses linkedinService HTTP methods directly.
 */

const cron = require('node-cron');
const { db } = require('../config/firebase');
const {
  getCookies,
  viewProfile,
  sendConnectionRequest,
  sendMessage,
  sendInMail,
  followProfile,
  endorseSkills,
  checkForReplies,
  checkAcceptedConnections,
  decrypt,
} = require('./linkedinService');

// ── Safe hours check ──────────────────────────────────────────────────────────
function isSafeToRun() {
  const now  = new Date();
  const hour = now.getHours();
  const day  = now.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return hour >= 10 && hour < 16; // weekends: 10am-4pm
  return hour >= 9 && hour < 18;                               // weekdays: 9am-6pm
}

// ── Gaussian human delay ──────────────────────────────────────────────────────
function humanDelay(minMs = 3000, maxMs = 8000) {
  const mean   = (minMs + maxMs) / 2;
  const stdDev = (maxMs - minMs) / 6;
  const u1 = Math.random(), u2 = Math.random();
  const z  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const delay   = Math.round(mean + z * stdDev);
  const clamped = Math.max(minMs, Math.min(maxMs, delay));
  return new Promise(r => setTimeout(r, clamped));
}

// ── Personalise message template ──────────────────────────────────────────────
function personalise(template, lead) {
  if (!template) return '';
  return template
    .replace(/\{name\}/gi,      lead.name?.split(' ')[0] || 'there')
    .replace(/\{firstName\}/gi, lead.name?.split(' ')[0] || 'there')
    .replace(/\{lastName\}/gi,  lead.name?.split(' ').slice(1).join(' ') || '')
    .replace(/\{company\}/gi,   lead.company  || 'your company')
    .replace(/\{headline\}/gi,  lead.headline || 'your work')
    .replace(/\{location\}/gi,  lead.location || 'your area');
}

// ── Get daily connection count for user ───────────────────────────────────────
async function getDailyConnectionCount(uid) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const snap = await db.collection('leads')
    .where('userId', '==', uid)
    .where('status', '==', 'requested')
    .where('requestedAt', '>=', today.toISOString())
    .get();

  return snap.size;
}

// ── Get daily limit based on account warmup ───────────────────────────────────
function getDailyLimit(linkedinConnectedAt) {
  if (!linkedinConnectedAt) return 5;
  const days = Math.floor(
    (Date.now() - new Date(linkedinConnectedAt).getTime()) / (1000 * 60 * 60 * 24)
  );
  if (days <= 3)  return 5;
  if (days <= 7)  return 10;
  if (days <= 14) return 15;
  return 20;
}

// ── Execute a single sequence step for a lead ────────────────────────────────
async function executeStep(uid, lead, step) {
  const leadId = lead.id;

  console.log(`[scheduler] ▶️  Step "${step.type}" for lead ${leadId} (${lead.name})`);

  try {
    let result = { success: true };

    switch (step.type) {

      case 'view_profile': {
        if (!lead.profileId) { console.warn('[scheduler] No profileId — skipping view'); break; }
        result = await viewProfile(uid, lead.profileId);
        await humanDelay(3000, 6000);
        break;
      }

      case 'connect': {
        if (!lead.profileId) { console.warn('[scheduler] No profileId — skipping connect'); break; }
        const note = personalise(step.note || step.message || '', lead);
        result     = await sendConnectionRequest(uid, lead.profileId, note);
        if (result.success) {
          await db.collection('leads').doc(leadId).update({
            status:      'requested',
            requestedAt: new Date().toISOString(),
          });
        }
        await humanDelay(5000, 12000);
        break;
      }

      case 'message': {
        if (!lead.profileId && !lead.threadUrn) {
          console.warn('[scheduler] No profileId/threadUrn — skipping message'); break;
        }
        const msg = personalise(step.message || '', lead);
        if (!msg) { console.warn('[scheduler] Empty message — skipping'); break; }
        result = await sendMessage(uid, lead.threadUrn || lead.profileId, msg);
        await humanDelay(4000, 10000);
        break;
      }

      case 'inmail': {
        if (!lead.profileId) { console.warn('[scheduler] No profileId — skipping inmail'); break; }
        const subject = personalise(step.subject || 'Reaching out', lead);
        const body    = personalise(step.message || step.body || '', lead);
        result = await sendInMail(uid, lead.profileId, subject, body);
        await humanDelay(4000, 10000);
        break;
      }

      case 'follow': {
        if (!lead.profileId) { console.warn('[scheduler] No profileId — skipping follow'); break; }
        result = await followProfile(uid, lead.profileId);
        await humanDelay(2000, 5000);
        break;
      }

      case 'endorse': {
        if (!lead.profileId) { console.warn('[scheduler] No profileId — skipping endorse'); break; }
        result = await endorseSkills(uid, lead.profileId);
        await humanDelay(3000, 7000);
        break;
      }

      case 'wait': {
        // Wait steps are handled by nextActionAt scheduling — not executed here
        console.log(`[scheduler] ⏳ Wait step — scheduling next action`);
        result = { success: true, isWait: true };
        break;
      }

      case 'condition': {
        // Evaluate condition and pick branch
        const branch = evaluateCondition(step, lead);
        console.log(`[scheduler] 🔀 Condition "${step.condition}" → branch: ${branch}`);
        result = { success: true, branch };
        break;
      }

      default:
        console.warn(`[scheduler] Unknown step type: ${step.type}`);
        break;
    }

    // Handle challenge
    if (result?.requiresChallenge) {
      console.warn(`[scheduler] ⚠️ Challenge detected for user ${uid} — pausing all campaigns`);
      await pauseUserCampaigns(uid, 'linkedin_challenge');
      return { success: false, requiresChallenge: true };
    }

    return result;

  } catch (err) {
    console.error(`[scheduler] ❌ Step "${step.type}" error:`, err.message);
    return { success: false, error: err.message };
  }
}

// ── Evaluate condition step ───────────────────────────────────────────────────
function evaluateCondition(step, lead) {
  const status   = lead.status;
  const condition = step.condition;

  switch (condition) {
    case 'accepted':     return status === 'accepted' ? 'yes' : 'no';
    case 'not_accepted': return status !== 'accepted' ? 'yes' : 'no';
    case 'replied':      return status === 'replied'  ? 'yes' : 'no';
    case 'not_replied':  return status !== 'replied'  ? 'yes' : 'no';
    case 'no_response':  return (status === 'requested' || status === 'pending') ? 'yes' : 'no';
    default:             return 'no';
  }
}

// ── Flatten sequence into steps with offsets ──────────────────────────────────
function flattenSequence(sequence) {
  const steps = [];
  let   dayOffset = 0;

  function flatten(arr, branch = 'main') {
    for (const step of arr) {
      if (step.type === 'wait') {
        dayOffset += (step.days || 0) + (step.hours || 0) / 24;
        continue;
      }
      steps.push({ ...step, dayOffset: Math.round(dayOffset * 10) / 10, branch });
      if (step.type === 'condition') {
        // Don't flatten branches here — handled dynamically during execution
      }
    }
  }

  flatten(sequence);
  return steps;
}

// ── Pause all campaigns for a user ───────────────────────────────────────────
async function pauseUserCampaigns(uid, reason = 'unknown') {
  const snap = await db.collection('campaigns')
    .where('userId', '==', uid)
    .where('status', '==', 'active')
    .get();

  const batch = db.batch();
  snap.docs.forEach(doc => {
    batch.update(doc.ref, {
      status:             'paused',
      pausedReason:       reason,
      pausedAt:           new Date().toISOString(),
    });
  });
  await batch.commit();
  console.log(`[scheduler] ⏸️  Paused ${snap.size} campaigns for user ${uid} (reason: ${reason})`);
}

// ── Run a single campaign ─────────────────────────────────────────────────────
async function runCampaign(campaignId) {
  const campaignDoc = await db.collection('campaigns').doc(campaignId).get();
  if (!campaignDoc.exists) return;

  const campaign = campaignDoc.data();
  if (campaign.status !== 'active' || campaign.isRunning) return;

  const uid      = campaign.userId;
  const sequence = campaign.sequence || [];
  if (!sequence.length) return;

  // Check if user has LinkedIn connected
  const userDoc = await db.collection('users').doc(uid).get();
  const user    = userDoc.data();
  if (!user?.linkedinSession || !user?.linkedinConnected) {
    console.log(`[scheduler] User ${uid} has no LinkedIn session — skipping`);
    return;
  }

  // Check if challenge is pending
  if (user.linkedinChallengeRequired) {
    console.log(`[scheduler] User ${uid} has pending LinkedIn challenge — skipping`);
    return;
  }

  // Check daily limit
  const dailyCount = await getDailyConnectionCount(uid);
  const dailyLimit = getDailyLimit(user.linkedinConnectedAt);
  if (dailyCount >= dailyLimit) {
    console.log(`[scheduler] User ${uid} reached daily limit (${dailyCount}/${dailyLimit})`);
    return;
  }

  // Mark campaign as running
  await campaignDoc.ref.update({ isRunning: true });

  try {
    console.log(`[scheduler] 🚀 Running campaign: ${campaignId}`);

    // Get pending leads
    const leadsSnap = await db.collection('leads')
      .where('campaignId', '==', campaignId)
      .where('status',     '==', 'pending')
      .limit(5)
      .get();

    let connectionsThisRun = 0;
    const maxThisRun = Math.min(5, dailyLimit - dailyCount);

    for (const leadDoc of leadsSnap.docs) {
      if (connectionsThisRun >= maxThisRun) break;

      const lead = { id: leadDoc.id, ...leadDoc.data() };

      // Find the first step for this lead (view_profile or connect)
      const firstActionStep = sequence.find(s => s.type !== 'wait');
      if (!firstActionStep) continue;

      const result = await executeStep(uid, lead, firstActionStep);

      if (result?.requiresChallenge) break;

      if (result?.success && firstActionStep.type === 'connect') {
        connectionsThisRun++;
      }

      // Update lead's current step
      await leadDoc.ref.update({ currentStep: 1 });
      await humanDelay(8000, 15000); // gap between leads
    }

    console.log(`[scheduler] ✅ Campaign ${campaignId} done. Connections sent: ${connectionsThisRun}`);

  } catch (err) {
    console.error(`[scheduler] ❌ runCampaign error:`, err.message);
  } finally {
    await campaignDoc.ref.update({ isRunning: false });
  }
}

// ── Process follow-ups for accepted leads ─────────────────────────────────────
async function processFollowUps() {
  const now = new Date().toISOString();

  // Get leads that are accepted/replied and have a nextActionAt in the past
  const leadsSnap = await db.collection('leads')
    .where('status', 'in', ['accepted', 'replied'])
    .where('nextActionAt', '<=', now)
    .limit(20)
    .get();

  if (leadsSnap.empty) {
    console.log('[scheduler] No follow-ups due');
    return;
  }

  console.log(`[scheduler] 📬 Processing ${leadsSnap.size} follow-ups`);

  for (const leadDoc of leadsSnap.docs) {
    const lead     = { id: leadDoc.id, ...leadDoc.data() };
    const uid      = lead.userId;

    // Get campaign
    const campDoc  = await db.collection('campaigns').doc(lead.campaignId).get();
    if (!campDoc.exists || campDoc.data().status !== 'active') continue;

    const sequence    = campDoc.data().sequence || [];
    const currentStep = lead.currentStep || 0;

    // Find next step to execute
    const nextStep = findNextStep(sequence, currentStep, lead);
    if (!nextStep) {
      // No more steps — mark lead as completed
      await leadDoc.ref.update({ status: 'completed', completedAt: now });
      continue;
    }

    // Check for user challenge
    const userDoc = await db.collection('users').doc(uid).get();
    if (userDoc.data()?.linkedinChallengeRequired) continue;

    const result = await executeStep(uid, lead, nextStep.step);
    if (result?.requiresChallenge) continue;

    // Calculate next action time
    const nextActionAt = calculateNextActionAt(sequence, nextStep.index + 1);

    await leadDoc.ref.update({
      currentStep: nextStep.index + 1,
      lastActionAt: now,
      ...(nextActionAt ? { nextActionAt } : {}),
    });

    await humanDelay(5000, 10000);
  }
}

// ── Find next executable step given current index ────────────────────────────
function findNextStep(sequence, currentIndex, lead) {
  for (let i = currentIndex; i < sequence.length; i++) {
    const step = sequence[i];

    // Skip wait steps — they just set timing
    if (step.type === 'wait') continue;

    if (step.type === 'condition') {
      const branch = evaluateCondition(step, lead);
      const branchSteps = branch === 'yes' ? step.yesSteps : step.noSteps;
      if (branchSteps?.length) {
        return { step: branchSteps[0], index: i };
      }
      continue;
    }

    return { step, index: i };
  }
  return null;
}

// ── Calculate next action timestamp based on wait steps ──────────────────────
function calculateNextActionAt(sequence, fromIndex) {
  let totalMs = 0;
  for (let i = fromIndex; i < sequence.length; i++) {
    const step = sequence[i];
    if (step.type === 'wait') {
      totalMs += (step.days  || 0) * 24 * 60 * 60 * 1000;
      totalMs += (step.hours || 0) * 60 * 60 * 1000;
      break; // only count up to first wait
    }
  }
  if (!totalMs) return null;
  return new Date(Date.now() + totalMs).toISOString();
}

// ── Queue processor ───────────────────────────────────────────────────────────
async function processQueue() {
  const now     = new Date().toISOString();
  const queued  = await db.collection('jobQueue')
    .where('status',       '==', 'pending')
    .where('scheduledFor', '<=', now)
    .orderBy('scheduledFor', 'asc')
    .limit(5)
    .get();

  if (queued.empty) return;

  for (const jobDoc of queued.docs) {
    const job = jobDoc.data();

    // Mark as processing
    await jobDoc.ref.update({ status: 'processing', startedAt: now });

    try {
      await handleJob(job);
      await jobDoc.ref.update({ status: 'done', completedAt: new Date().toISOString() });
    } catch (err) {
      console.error('[queue] Job error:', err.message);
      await jobDoc.ref.update({ status: 'failed', error: err.message });
    }
  }
}

async function handleJob(job) {
  switch (job.type) {
    case 'send_connection':
      await sendConnectionRequest(job.uid, job.profileId, job.message);
      break;
    case 'send_message':
      await sendMessage(job.uid, job.profileUrn, job.message);
      break;
    case 'send_inmail':
      await sendInMail(job.uid, job.profileId, job.subject, job.body);
      break;
    case 'view_profile':
      await viewProfile(job.uid, job.profileId);
      break;
    case 'follow':
      await followProfile(job.uid, job.profileId);
      break;
    case 'endorse':
      await endorseSkills(job.uid, job.profileId);
      break;
    default:
      console.warn('[queue] Unknown job type:', job.type);
  }
}

// ── Cron jobs ────────────────────────────────────────────────────────────────

// Queue processor — every minute
cron.schedule('* * * * *', async () => {
  try { await processQueue(); }
  catch (err) { console.error('[cron] Queue error:', err.message); }
});

// Follow-up processor — every hour
cron.schedule('0 * * * *', async () => {
  console.log('[cron] 🔄 Follow-up processor running');
  try { await processFollowUps(); }
  catch (err) { console.error('[cron] Follow-up error:', err.message); }
});

// Campaign runner — weekdays 9am, 11am, 1pm, 3pm, 5pm
cron.schedule('0 9,11,13,15,17 * * 1-5', async () => {
  if (!isSafeToRun()) { console.log('[cron] Outside safe window'); return; }
  console.log('[cron] 🕐 Running campaigns');

  try {
    const snap = await db.collection('campaigns')
      .where('status',    '==', 'active')
      .where('isRunning', '==', false)
      .get();

    console.log(`[cron] Found ${snap.size} active campaigns`);

    for (const doc of snap.docs) {
      try {
        await runCampaign(doc.id);
        // Gap between campaigns (5–15 min)
        const gap = (5 + Math.floor(Math.random() * 10)) * 60 * 1000;
        await new Promise(r => setTimeout(r, gap));
      } catch (err) {
        console.error(`[cron] Campaign ${doc.id} error:`, err.message);
      }
    }
  } catch (err) {
    console.error('[cron] Scheduler error:', err.message);
  }
});

// Reply detection — every 3 hours
cron.schedule('0 9,12,15,18 * * *', async () => {
  console.log('[cron] 📩 Checking for replies');

  try {
    const usersSnap = await db.collection('users')
      .where('linkedinConnected', '==', true)
      .get();

    for (const userDoc of usersSnap.docs) {
      const user = userDoc.data();
      if (!user.linkedinSession || user.linkedinChallengeRequired) continue;

      try {
        const decrypted = decrypt(user.linkedinSession);
        const count     = await checkForReplies(userDoc.id, decrypted);
        if (count > 0) console.log(`[cron] ${count} replies found for user ${userDoc.id}`);
        // Gap between users
        await new Promise(r => setTimeout(r, 30000 + Math.random() * 30000));
      } catch (err) {
        console.error(`[cron] Reply check error for ${userDoc.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[cron] Reply check error:', err.message);
  }
});

// Check accepted connections — every 2 hours during the day
cron.schedule('0 10,12,14,16 * * *', async () => {
  console.log('[cron] 🤝 Checking accepted connections');

  try {
    const usersSnap = await db.collection('users')
      .where('linkedinConnected', '==', true)
      .get();

    for (const userDoc of usersSnap.docs) {
      const user = userDoc.data();
      if (!user.linkedinSession || user.linkedinChallengeRequired) continue;

      try {
        const accepted = await checkAcceptedConnections(userDoc.id);

        for (const invite of accepted) {
          const profileId = invite.invitation?.fromMember?.miniProfile?.publicIdentifier;
          if (!profileId) continue;

          // Find matching lead and update status
          const leadSnap = await db.collection('leads')
            .where('userId',    '==', userDoc.id)
            .where('profileId', '==', profileId)
            .where('status',    '==', 'requested')
            .limit(1)
            .get();

          if (!leadSnap.empty) {
            const leadRef = leadSnap.docs[0].ref;
            const lead    = leadSnap.docs[0].data();

            // Calculate when to send first follow-up message
            const campDoc  = await db.collection('campaigns').doc(lead.campaignId).get();
            const sequence = campDoc.data()?.sequence || [];
            const nextAt   = calculateNextActionAt(sequence, (lead.currentStep || 0) + 1);

            await leadRef.update({
              status:       'accepted',
              acceptedAt:   new Date().toISOString(),
              currentStep:  (lead.currentStep || 0) + 1,
              ...(nextAt ? { nextActionAt: nextAt } : {}),
            });

            console.log(`[cron] ✅ Connection accepted: ${profileId}`);
          }
        }

        await new Promise(r => setTimeout(r, 15000 + Math.random() * 15000));
      } catch (err) {
        console.error(`[cron] Accept check error for ${userDoc.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[cron] Accept check scheduler error:', err.message);
  }
});

// Weekend minimal runs — Saturday/Sunday at noon
cron.schedule('0 12 * * 0,6', async () => {
  console.log('[cron] 📅 Weekend minimal run');

  try {
    const snap = await db.collection('campaigns')
      .where('status',    '==', 'active')
      .where('isRunning', '==', false)
      .get();

    // Max 2 campaigns on weekends
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
    console.error('[cron] Weekend error:', err.message);
  }
});

// Daily stats snapshot — midnight
cron.schedule('0 0 * * *', async () => {
  console.log('[cron] 📊 Daily stats snapshot');

  try {
    const campaignsSnap = await db.collection('campaigns').get();

    for (const doc of campaignsSnap.docs) {
      const leadsSnap = await db.collection('leads')
        .where('campaignId', '==', doc.id)
        .get();

      const leads = leadsSnap.docs.map(d => d.data());
      await db.collection('dailyStats').add({
        date:       new Date().toISOString().split('T')[0],
        campaignId: doc.id,
        total:      leads.length,
        pending:    leads.filter(l => l.status === 'pending').length,
        requested:  leads.filter(l => l.status === 'requested').length,
        accepted:   leads.filter(l => ['accepted','replied','called'].includes(l.status)).length,
        replied:    leads.filter(l => ['replied','called'].includes(l.status)).length,
        called:     leads.filter(l => l.status === 'called').length,
      });
    }
  } catch (err) {
    console.error('[cron] Daily stats error:', err.message);
  }
});

// Cookie expiry warning — daily at 8am
// Warn users whose cookies are older than 20 days
cron.schedule('0 8 * * *', async () => {
  try {
    const twentyDaysAgo = Date.now() - 20 * 24 * 60 * 60 * 1000;

    const usersSnap = await db.collection('users')
      .where('linkedinConnected', '==', true)
      .get();

    for (const userDoc of usersSnap.docs) {
      const user = userDoc.data();
      if (user.linkedinCookiesAt && user.linkedinCookiesAt < twentyDaysAgo) {
        // Flag for reconnection reminder
        await userDoc.ref.update({ linkedinSessionOld: true });
        console.log(`[cron] ⚠️ Old session for user ${userDoc.id}`);
      }
    }
  } catch (err) {
    console.error('[cron] Cookie expiry check error:', err.message);
  }
});

console.log('[cron] ✅ Scheduler initialized (HTTP+Cookies mode)');

module.exports = {
  init:           () => console.log('[cron] Scheduler is active'),
  runCampaign,
  processFollowUps,
  processQueue,
  isSafeToRun,
};