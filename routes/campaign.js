const express      = require('express');
const router       = express.Router();
const rateLimit    = require('express-rate-limit');
const { db }       = require('../config/firebase');
const authMiddleware = require('../middleware/authMiddleware');

// ── Rate limiters ─────────────────────────────────────────────────────────────

const campaignStartLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:      5,
  message:  { error: 'Too many campaign start requests. Please wait 15 minutes.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

const importLeadsLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max:      10,              // increased from 3 to 10
  message:  { error: 'Too many import requests. Please wait 10 minutes.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max:      30,
  message:  { error: 'Too many requests.' },
});

router.use(generalLimiter);

// ── Validate sequence ─────────────────────────────────────────────────────────
function validateSequence(sequence) {
  if (!Array.isArray(sequence) || sequence.length === 0) {
    return 'sequence must be a non-empty array';
  }

  const validTypes = ['connect', 'message', 'inmail', 'view_profile', 'follow', 'endorse', 'wait', 'condition'];

  for (let i = 0; i < sequence.length; i++) {
    const step = sequence[i];
    if (!validTypes.includes(step.type)) {
      return `Step ${i}: invalid type "${step.type}"`;
    }
    if (step.type === 'wait' && !step.days && !step.hours) {
      return `Step ${i}: wait step must have days or hours`;
    }
    if ((step.type === 'message' || step.type === 'inmail') && !step.message) {
      return `Step ${i}: ${step.type} step must have a message`;
    }
  }

  return null;
}

// ── POST /api/v1/campaigns/create ─────────────────────────────────────────────
router.post('/create', authMiddleware, async (req, res) => {
  const { name, messageTemplate, sequence } = req.body;
  const uid = req.user.uid;

  if (!name) return res.status(400).json({ error: 'name is required' });

  // Support both legacy messageTemplate and new sequence format
  let finalSequence = sequence;

  if (!finalSequence && messageTemplate) {
    // Convert legacy single message to sequence
    finalSequence = [
      { type: 'connect', note: '', id: 'step-1' },
      { type: 'wait', days: 1, id: 'step-2' },
      { type: 'message', message: messageTemplate, id: 'step-3' },
      { type: 'wait', days: 3, id: 'step-4' },
      { type: 'message', message: 'Hi {name}, just following up on my previous message. Would love to connect!', id: 'step-5' },
      { type: 'wait', days: 7, id: 'step-6' },
      { type: 'message', message: 'Hey {name}, final follow-up — happy to connect whenever works for you!', id: 'step-7' },
    ];
  }

  if (!finalSequence) {
    return res.status(400).json({ error: 'sequence or messageTemplate is required' });
  }

  const seqError = validateSequence(finalSequence);
  if (seqError) return res.status(400).json({ error: seqError });

  try {
    const campaignRef = await db.collection('campaigns').add({
      userId:          uid,
      name,
      messageTemplate: messageTemplate || '',
      sequence:        finalSequence,
      status:          'active',
      isRunning:       false,
      createdAt:       new Date().toISOString(),
      lastRunAt:       null,
      lastRunCount:    0,
      totalActions:    0,
    });

    res.status(201).json({ success: true, campaignId: campaignRef.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/v1/campaigns ─────────────────────────────────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  const uid = req.user.uid;
  try {
    const snapshot = await db.collection('campaigns')
      .where('userId', '==', uid)
      .get();

    const campaigns = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({ campaigns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/v1/campaigns/:campaignId ────────────────────────────────────────
router.get('/:campaignId', authMiddleware, async (req, res) => {
  const { campaignId } = req.params;
  const uid = req.user.uid;

  try {
    const doc = await db.collection('campaigns').doc(campaignId).get();
    if (!doc.exists || doc.data().userId !== uid) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/v1/campaigns/:campaignId/sequence ────────────────────────────────
router.put('/:campaignId/sequence', authMiddleware, async (req, res) => {
  const { campaignId } = req.params;
  const { sequence }   = req.body;
  const uid = req.user.uid;

  const seqError = validateSequence(sequence);
  if (seqError) return res.status(400).json({ error: seqError });

  try {
    const ref = db.collection('campaigns').doc(campaignId);
    const doc = await ref.get();

    if (!doc.exists || doc.data().userId !== uid) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await ref.update({ sequence, updatedAt: new Date().toISOString() });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/v1/campaigns/:campaignId/status ──────────────────────────────────
router.put('/:campaignId/status', authMiddleware, async (req, res) => {
  const { campaignId } = req.params;
  const { status }     = req.body;
  const uid = req.user.uid;

  if (!['active', 'paused', 'completed'].includes(status)) {
    return res.status(400).json({ error: 'status must be active, paused, or completed' });
  }

  try {
    const ref = db.collection('campaigns').doc(campaignId);
    const doc = await ref.get();

    if (!doc.exists || doc.data().userId !== uid) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await ref.update({ status });
    res.json({ success: true, campaignId, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/v1/campaigns/:campaignId/leads ───────────────────────────────────
router.get('/:campaignId/leads', authMiddleware, async (req, res) => {
  const { campaignId } = req.params;
  const uid = req.user.uid;

  try {
    const campaignDoc = await db.collection('campaigns').doc(campaignId).get();
    if (!campaignDoc.exists || campaignDoc.data().userId !== uid) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const snapshot = await db.collection('leads')
      .where('campaignId', '==', campaignId)
      .get();

    const leads = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ leads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/v1/campaigns/:campaignId/import-leads ──────────────────────────
router.post('/:campaignId/import-leads', authMiddleware, importLeadsLimiter, async (req, res) => {
  const { campaignId }        = req.params;
  const { searchUrl, maxLeads } = req.body;
  const uid = req.user.uid;

  if (!searchUrl) return res.status(400).json({ error: 'searchUrl is required' });

  const limit = Math.min(100, Math.max(10, parseInt(maxLeads) || 25));

  try {
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });

    const userData = userDoc.data();
    if (!userData.linkedinSession) {
      return res.status(400).json({ error: 'LinkedIn not connected' });
    }

    const { scrapeLeads } = require('../services/linkedinService');
    const leads = await scrapeLeads(uid, userData.linkedinSession, searchUrl, campaignId, limit);

    res.json({ success: true, leadsImported: leads.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/v1/campaigns/:campaignId/launch ─────────────────────────────────
router.post('/:campaignId/launch', authMiddleware, importLeadsLimiter, async (req, res) => {
  const { campaignId }          = req.params;
  const { searchUrl, maxLeads } = req.body;
  const uid                     = req.user.uid;

  if (!searchUrl) return res.status(400).json({ error: 'searchUrl is required' });
  if (!searchUrl.includes('linkedin.com')) {
    return res.status(400).json({ error: 'Must be a LinkedIn search URL' });
  }

  const limit = Math.min(100, Math.max(10, parseInt(maxLeads) || 25));

  try {
    const campaignRef = db.collection('campaigns').doc(campaignId);
    const campaignDoc = await campaignRef.get();

    if (!campaignDoc.exists || campaignDoc.data().userId !== uid) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (campaignDoc.data().isRunning) {
      return res.status(409).json({ error: 'Campaign is already running' });
    }

    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });

    const userData = userDoc.data();
    if (!userData.linkedinSession) {
      return res.status(400).json({ error: 'LinkedIn not connected. Please connect LinkedIn first.' });
    }

    // Mark as scraping immediately
    await campaignRef.update({
      launchStatus:  'scraping',
      launchError:   null,
      lastLaunchAt:  new Date().toISOString(),
      leadsScraped:  0,
    });

    // Respond immediately
    res.json({
      success: true,
      status:  'launching',
      message: '🚀 Launching! Scraping profiles then sending connections automatically...',
    });

    // Run in background
    ;(async () => {
      try {
        console.log(`[launch] 🔍 Scraping ${limit} leads for campaign ${campaignId}`);

        const { scrapeLeads }  = require('../services/linkedinService');
        const { enqueueJob }   = require('../services/Queueservice');
        const { runCampaign }  = require('../services/automationService');

        // Step 1 — Scrape leads
        const leads = await scrapeLeads(uid, userData.linkedinSession, searchUrl, campaignId, limit);
        console.log(`[launch] ✅ Scraped ${leads.length} leads`);

        await campaignRef.update({
          leadsScraped: leads.length,
        });

        if (leads.length === 0) {
          await campaignRef.update({
            launchStatus: 'error',
            launchError:  'No profiles found. Check your LinkedIn search URL and filters.',
          });
          return;
        }

        // Step 2 — Auto-start campaign
        await campaignRef.update({ launchStatus: 'running' });
        console.log(`[launch] 🚀 Auto-starting campaign ${campaignId}`);

        const job = await enqueueJob(campaignId, uid);

        if (job.runNow) {
          await runCampaign(campaignId);
          await campaignRef.update({
            launchStatus: 'done',
            launchError:  null,
          });
          console.log(`[launch] ✅ Campaign completed`);
        } else {
          await campaignRef.update({
            launchStatus:    'queued',
            launchScheduled: job.scheduledLabel,
            launchError:     null,
          });
          console.log(`[launch] ⏰ Campaign queued for ${job.scheduledLabel}`);
        }

      } catch (err) {
        console.error(`[launch] ❌ Error:`, err.message);
        await campaignRef.update({
          launchStatus: 'error',
          launchError:  err.message,
          isRunning:    false,
        }).catch(() => {});
      }
    })();

  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ── POST /api/v1/campaigns/:campaignId/start ─────────────────────────────────
router.post('/:campaignId/start', authMiddleware, campaignStartLimiter, async (req, res) => {
  const { campaignId } = req.params;
  const uid = req.user.uid;

  try {
    const ref = db.collection('campaigns').doc(campaignId);
    const doc = await ref.get();

    if (!doc.exists || doc.data().userId !== uid) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (doc.data().isRunning) {
      return res.status(409).json({
        error: 'Campaign is already running. Please wait for it to complete.',
        isRunning: true,
      });
    }

    if (doc.data().status !== 'active') {
      return res.status(400).json({ error: 'Campaign must be active to start' });
    }

    const { enqueueJob } = require('../services/Queueservice');
    const { isSafeToRun, runCampaign } = require('../services/automationService');

    const job = await enqueueJob(campaignId, uid);

    // Already had a pending job queued
    if (job.alreadyQueued) {
      return res.json({
        success:        true,
        status:         'already_queued',
        message:        `Already scheduled to run ${job.scheduledLabel}.`,
        scheduledFor:   job.scheduledFor,
        scheduledLabel: job.scheduledLabel,
      });
    }

    // Safe to run right now — execute immediately
    if (job.runNow) {
      // Run in background so response returns fast
      runCampaign(campaignId).catch(err => {
        console.error(`❌ Campaign ${campaignId} failed:`, err.message);
      });

      return res.json({
        success: true,
        status:  'running',
        message: '🚀 Campaign started! Connection requests are being sent.',
        jobId:   job.jobId,
      });
    }

    // Queued for later
    return res.json({
      success:        true,
      status:         'queued',
      message:        `⏰ Queued — will run automatically ${job.scheduledLabel}.`,
      scheduledFor:   job.scheduledFor,
      scheduledLabel: job.scheduledLabel,
      jobId:          job.jobId,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/v1/campaigns/:campaignId/queue-status ───────────────────────────
router.get('/:campaignId/queue-status', authMiddleware, async (req, res) => {
  const { campaignId } = req.params;
  const uid = req.user.uid;

  try {
    const doc = await db.collection('campaigns').doc(campaignId).get();
    if (!doc.exists || doc.data().userId !== uid) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { getCampaignQueueStatus } = require('../services/Queueservice');
    const status = await getCampaignQueueStatus(campaignId);

    res.json({ queued: !!status, job: status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/v1/campaigns/:campaignId/cancel-queue ──────────────────────────
router.post('/:campaignId/cancel-queue', authMiddleware, async (req, res) => {
  const { campaignId } = req.params;
  const uid = req.user.uid;

  try {
    const doc = await db.collection('campaigns').doc(campaignId).get();
    if (!doc.exists || doc.data().userId !== uid) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { cancelCampaignJobs } = require('../services/Queueservice');
    const cancelled = await cancelCampaignJobs(campaignId);

    res.json({ success: true, cancelled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.post('/:campaignId/check-accepted', authMiddleware, async (req, res) => {
  const { campaignId } = req.params;
  const uid = req.user.uid;

  try {
    const doc = await db.collection('campaigns').doc(campaignId).get();
    if (!doc.exists || doc.data().userId !== uid) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { checkAndSendMessages } = require('../services/automationService');
    checkAndSendMessages(campaignId).catch(err => {
      console.error(`❌ checkAndSendMessages failed:`, err.message);
    });

    res.json({ success: true, message: 'Checking accepted connections...' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/v1/campaigns/leads/:leadId/status ────────────────────────────────
router.put('/leads/:leadId/status', authMiddleware, async (req, res) => {
  const { leadId } = req.params;
  const { status } = req.body;
  const uid = req.user.uid;

  const validStatuses = ['pending', 'requested', 'accepted', 'replied', 'called', 'skipped'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
  }

  try {
    const ref = db.collection('leads').doc(leadId);
    const doc = await ref.get();

    if (!doc.exists || doc.data().userId !== uid) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await ref.update({
      status,
      statusUpdatedAt: new Date().toISOString(),
      statusUpdatedBy: 'manual',
    });

    res.json({ success: true, leadId, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/v1/campaigns/:campaignId ─────────────────────────────────────
router.delete('/:campaignId', authMiddleware, async (req, res) => {
  const { campaignId } = req.params;
  const uid = req.user.uid;

  try {
    const ref = db.collection('campaigns').doc(campaignId);
    const doc = await ref.get();

    if (!doc.exists || doc.data().userId !== uid) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (doc.data().isRunning) {
      return res.status(409).json({ error: 'Cannot delete a running campaign. Pause it first.' });
    }

    await ref.delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;