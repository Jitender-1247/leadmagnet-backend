/**
 * queueService.js
 * Firestore-backed job queue for campaign execution.
 * Guarantees campaigns run at the exact next safe window
 * even if the user triggered them outside working hours.
 *
 * Queue document shape:
 * {
 *   campaignId:   string,
 *   userId:       string,
 *   status:       'pending' | 'running' | 'completed' | 'failed',
 *   scheduledFor: ISO string  ← exact time to execute
 *   createdAt:    ISO string,
 *   startedAt:    ISO string | null,
 *   completedAt:  ISO string | null,
 *   attempts:     number,
 *   lastError:    string | null,
 * }
 */

const { db }        = require('../config/firebase');
const { isSafeToRun, runCampaign } = require('./automationService');

const WORKING_HOUR_START = 9;   // 9 AM
const WORKING_HOUR_END   = 18;  // 6 PM
const MAX_ATTEMPTS       = 3;

// ── Calculate exact next safe window as a Date object ────────────────────────
function getNextSafeWindowDate() {
  const now  = new Date();
  const hour = now.getHours();
  const day  = now.getDay(); // 0=Sun 6=Sat
  const next = new Date(now);

  // Helper to set time to start of working hours
  const setToWorkStart = (d) => {
    d.setHours(WORKING_HOUR_START, 0, 0, 0);
    return d;
  };

  // Weekend — go to Monday 8am
  if (day === 6) { // Saturday
    next.setDate(now.getDate() + 2);
    return setToWorkStart(next);
  }
  if (day === 0) { // Sunday
    next.setDate(now.getDate() + 1);
    return setToWorkStart(next);
  }

  // Weekday before work hours — same day 8am
  if (hour < WORKING_HOUR_START) {
    return setToWorkStart(next);
  }

  // Weekday after work hours — next weekday 8am
  if (hour >= WORKING_HOUR_END) {
    if (day === 5) { // Friday → Monday
      next.setDate(now.getDate() + 3);
    } else {
      next.setDate(now.getDate() + 1);
    }
    return setToWorkStart(next);
  }

  // Currently in safe hours — run now
  return now;
}

// ── Human readable label from Date ───────────────────────────────────────────
function formatScheduledFor(date) {
  const now  = new Date();
  const diff = date - now;

  if (diff <= 0) return 'now';

  const mins  = Math.round(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days  = Math.floor(hours / 24);

  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dayName = date.toLocaleDateString([], { weekday: 'long' });
  const isToday    = date.toDateString() === now.toDateString();
  const isTomorrow = date.toDateString() === new Date(now.getTime() + 86400000).toDateString();

  if (isToday)    return `today at ${timeStr}`;
  if (isTomorrow) return `tomorrow at ${timeStr}`;
  return `${dayName} at ${timeStr}`;
}

// ── Create a job in the queue ─────────────────────────────────────────────────
async function enqueueJob(campaignId, userId) {
  // Check if there's already a pending job for this campaign
  const existing = await db.collection('jobQueue')
    .where('campaignId', '==', campaignId)
    .where('status', '==', 'pending')
    .get();

  if (!existing.empty) {
    // Return existing job info
    const job = existing.docs[0].data();
    return {
      jobId:        existing.docs[0].id,
      alreadyQueued: true,
      scheduledFor: job.scheduledFor,
      scheduledLabel: formatScheduledFor(new Date(job.scheduledFor)),
    };
  }

  const scheduledFor = getNextSafeWindowDate();
  const isNow        = scheduledFor <= new Date();

  const jobRef = await db.collection('jobQueue').add({
    campaignId,
    userId,
    status:       'pending',
    scheduledFor: scheduledFor.toISOString(),
    createdAt:    new Date().toISOString(),
    startedAt:    null,
    completedAt:  null,
    attempts:     0,
    lastError:    null,
  });

  return {
    jobId:          jobRef.id,
    alreadyQueued:  false,
    runNow:         isNow,
    scheduledFor:   scheduledFor.toISOString(),
    scheduledLabel: isNow ? 'now' : formatScheduledFor(scheduledFor),
  };
}

// ── Process all due pending jobs ──────────────────────────────────────────────
// Called by the 1-minute cron in scheduler.js
async function processQueue() {
  const now = new Date().toISOString();

  // Query only on status — filter scheduledFor in memory to avoid composite index
  const snapshot = await db.collection('jobQueue')
    .where('status', '==', 'pending')
    .get();

  if (snapshot.empty) return;

  // Filter to only jobs that are due now
  const dueJobs = snapshot.docs.filter(doc =>
    doc.data().scheduledFor <= now
  );

  if (dueJobs.length === 0) return;

  console.log(`[queue] ⚡ Processing ${dueJobs.length} due job(s)`);

  for (const doc of dueJobs) {
    const job    = doc.data();
    const jobRef = doc.ref;

    // Skip if too many attempts
    if (job.attempts >= MAX_ATTEMPTS) {
      await jobRef.update({ status: 'failed', lastError: 'Max attempts reached' });
      continue;
    }

    // Mark as running
    await jobRef.update({
      status:    'running',
      startedAt: new Date().toISOString(),
      attempts:  job.attempts + 1,
    });

    try {
      console.log(`[queue] 🚀 Running campaign ${job.campaignId}`);
      const result = await runCampaign(job.campaignId);

      // If still outside safe hours (edge case), re-queue
      if (result?.status === 'scheduled') {
        const nextWindow = getNextSafeWindowDate();
        await jobRef.update({
          status:       'pending',
          scheduledFor: nextWindow.toISOString(),
          lastError:    'Still outside safe hours, rescheduled',
        });
        console.log(`[queue] ⏰ Re-queued campaign ${job.campaignId} → ${formatScheduledFor(nextWindow)}`);
        continue;
      }

      await jobRef.update({
        status:      'completed',
        completedAt: new Date().toISOString(),
        result:      result?.status || 'completed',
      });

      console.log(`[queue] ✅ Job completed for campaign ${job.campaignId}`);

    } catch (err) {
      console.error(`[queue] ❌ Job failed for campaign ${job.campaignId}:`, err.message);

      const nextAttempt = job.attempts + 1;

      if (nextAttempt >= MAX_ATTEMPTS) {
        await jobRef.update({
          status:    'failed',
          lastError: err.message,
        });
      } else {
        // Retry in 30 minutes
        const retryAt = new Date(Date.now() + 30 * 60 * 1000);
        await jobRef.update({
          status:       'pending',
          scheduledFor: retryAt.toISOString(),
          lastError:    err.message,
        });
        console.log(`[queue] 🔄 Will retry at ${formatScheduledFor(retryAt)}`);
      }
    }
  }
}

// ── Get queue status for a campaign ──────────────────────────────────────────
async function getCampaignQueueStatus(campaignId) {
  // Query only on campaignId — filter status in memory to avoid composite index
  const snap = await db.collection('jobQueue')
    .where('campaignId', '==', campaignId)
    .get();

  if (snap.empty) return null;

  // Filter to active jobs and sort in memory
  const activeJobs = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(j => j.status === 'pending' || j.status === 'running')
    .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))

  if (activeJobs.length === 0) return null;

  const job = activeJobs[0];
  return {
    jobId:          job.id,
    status:         job.status,
    scheduledFor:   job.scheduledFor,
    scheduledLabel: formatScheduledFor(new Date(job.scheduledFor)),
    attempts:       job.attempts,
  };
}

// ── Cancel pending jobs for a campaign ───────────────────────────────────────
async function cancelCampaignJobs(campaignId) {
  const snap = await db.collection('jobQueue')
    .where('campaignId', '==', campaignId)
    .where('status', '==', 'pending')
    .get();

  const batch = db.batch();
  snap.docs.forEach(doc => batch.update(doc.ref, { status: 'cancelled' }));
  await batch.commit();

  return snap.size;
}

module.exports = {
  enqueueJob,
  processQueue,
  getCampaignQueueStatus,
  cancelCampaignJobs,
  getNextSafeWindowDate,
  formatScheduledFor,
};