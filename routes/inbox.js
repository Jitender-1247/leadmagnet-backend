const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const authMiddleware = require('../middleware/authMiddleware');
const { syncInboxMessages, replyToMessage } = require('../services/inboxService');

// GET /api/v1/inbox/messages
router.get('/messages', authMiddleware, async (req, res) => {
    const uid = req.user.uid;
    try {
        const snapshot = await db.collection('messages')
            .where('userId', '==', uid)
            .orderBy('receivedAt', 'desc')
            .limit(50)
            .get();

        const messages = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.json({ messages });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/v1/inbox/sync
router.post('/sync', authMiddleware, async (req, res) => {
    const uid = req.user.uid;
    try {
        const userDoc = await db.collection('users').doc(uid).get();
        const { linkedinSession } = userDoc.data();

        if (!linkedinSession) {
            return res.status(400).json({ error: 'LinkedIn not connected' });
        }

        const count = await syncInboxMessages(uid, linkedinSession);
        res.json({ success: true, messagesSynced: count });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/v1/inbox/reply
router.post('/reply', authMiddleware, async (req, res) => {
    const { threadUrl, message } = req.body;
    const uid = req.user.uid;

    if (!threadUrl || !message) {
        return res.status(400).json({ error: 'threadUrl and message are required' });
    }

    try {
        const userDoc = await db.collection('users').doc(uid).get();
        const { linkedinSession } = userDoc.data();

        if (!linkedinSession) {
            return res.status(400).json({ error: 'LinkedIn not connected' });
        }

        const result = await replyToMessage(linkedinSession, threadUrl, message);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;