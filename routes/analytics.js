const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const authMiddleware = require('../middleware/authMiddleware');

// Helper — filter leads by period
function getStartDate(period) {
    const now = new Date();
    switch (period) {
        case '7d':  return new Date(now - 7  * 24 * 60 * 60 * 1000).toISOString();
        case '30d': return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
        case '90d': return new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
        default:    return null;
    }
}

// GET /api/v1/analytics/overview
router.get('/overview', authMiddleware, async (req, res) => {
    const uid = req.user.uid;
    const { campaignId, period } = req.query;
    const startDate = getStartDate(period);

    try {
        let query = db.collection('leads').where('userId', '==', uid);
        if (campaignId) query = query.where('campaignId', '==', campaignId);

        const snapshot = await query.get();
        let leads = snapshot.docs.map(doc => doc.data());

        if (startDate) {
            leads = leads.filter(l => l.createdAt >= startDate);
        }

        const connectionsSent = leads.length;
        const accepted        = leads.filter(l => ['accepted', 'replied', 'called'].includes(l.status)).length;
        const replied         = leads.filter(l => ['replied', 'called'].includes(l.status)).length;
        const meetingsBooked  = leads.filter(l => l.status === 'called').length;

        res.json({
            connectionsSent,
            accepted,
            replied,
            meetingsBooked,
            acceptanceRate: connectionsSent > 0 ? Math.round((accepted       / connectionsSent) * 100) : 0,
            replyRate:      accepted > 0        ? Math.round((replied        / accepted)        * 100) : 0,
            meetingRate:    replied  > 0        ? Math.round((meetingsBooked / replied)         * 100) : 0,
            total:          connectionsSent,
            pending:        leads.filter(l => l.status === 'pending').length,
            requested:      leads.filter(l => l.status === 'requested').length,
            skipped:        leads.filter(l => l.status === 'skipped').length,
            conversionRate: connectionsSent > 0
                ? ((meetingsBooked / connectionsSent) * 100).toFixed(1) + '%'
                : '0%',
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/v1/analytics/conversions
router.get('/conversions', authMiddleware, async (req, res) => {
    const uid = req.user.uid;
    const { type, campaignId, period } = req.query;
    const startDate = getStartDate(period);

    const statusMap = {
        micro:    'accepted',
        standard: 'replied',
        ultimate: 'called'
    };

    if (type && !statusMap[type]) {
        return res.status(400).json({ error: 'type must be micro, standard or ultimate' });
    }

    try {
        let query = db.collection('leads').where('userId', '==', uid);
        if (campaignId) query = query.where('campaignId', '==', campaignId);
        if (type) query = query.where('status', '==', statusMap[type]);

        const snapshot = await query.get();
        let leads = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        if (startDate) {
            leads = leads.filter(l => l.createdAt >= startDate);
        }

        res.json({
            micro:    leads.filter(l => l.status === 'accepted').length,
            standard: leads.filter(l => l.status === 'replied').length,
            ultimate: leads.filter(l => l.status === 'called').length,
            leads:    type ? leads : undefined
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/v1/analytics/campaigns — stats per campaign
router.get('/campaigns', authMiddleware, async (req, res) => {
    const uid = req.user.uid;

    try {
        // Step 1: Get all campaigns for the user
        const campaignsSnapshot = await db.collection('campaigns')
            .where('userId', '==', uid)
            .get();

        if (campaignsSnapshot.empty) {
            return res.json({ stats: [] });
        }

        // Step 2: Fetch leads for ALL campaigns in parallel
        const stats = await Promise.all(
            campaignsSnapshot.docs.map(async (doc) => {
                const campaign = { id: doc.id, ...doc.data() };
                
                const leadsSnapshot = await db.collection('leads')
                    .where('campaignId', '==', campaign.id)
                    .get();

                const leads = leadsSnapshot.docs.map(d => d.data());
                
                // Calculations
                const total     = leads.length;
                const accepted  = leads.filter(l => ['accepted', 'replied', 'called'].includes(l.status)).length;
                const replied   = leads.filter(l => ['replied', 'called'].includes(l.status)).length;
                const called    = leads.filter(l => l.status === 'called').length;

                return {
                    campaignId:     campaign.id,
                    name:           campaign.name,
                    status:         campaign.status,
                    total,
                    pending:        leads.filter(l => l.status === 'pending').length,
                    requested:      leads.filter(l => l.status === 'requested').length,
                    accepted,
                    replied,
                    called,
                    acceptanceRate: total    > 0 ? Math.round((accepted / total)    * 100) : 0,
                    replyRate:      accepted > 0 ? Math.round((replied  / accepted) * 100) : 0,
                    meetingRate:    replied  > 0 ? Math.round((called   / replied)  * 100) : 0,
                };
            })
        );

        res.json({ stats });
    } catch (err) {
        console.error('Analytics Error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
