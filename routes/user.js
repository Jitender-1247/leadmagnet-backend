const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const authMiddleware = require('../middleware/authMiddleware');
const bcrypt = require('bcrypt');

// GET /api/v1/user/profile
router.get('/profile', authMiddleware, async (req, res) => {
    const uid = req.user.uid;
    try {
        const userDoc = await db.collection('users').doc(uid).get();

        if (!userDoc.exists) {
            return res.status(404).json({ error: 'User not found' });
        }

        const data = userDoc.data();

        // ✅ Never send password or sensitive session data to frontend
        res.json({
            uid,
            name:                  data.name,
            email:                 data.email,
            createdAt:             data.createdAt,
            isVerified:            data.isVerified,
            linkedinConnected:     !!data.linkedinSession,
            linkedinEmail:         data.linkedinEmail         || null,
            linkedinConnectedAt:   data.linkedinConnectedAt   || null,
            linkedinProfileImage:  data.linkedinProfileImage  || null,
            linkedinDisplayName:   data.linkedinDisplayName   || null,
            profileImage:          data.profileImage          || null,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/v1/user/profile — update name and/or email
router.put('/profile', authMiddleware, async (req, res) => {
    const uid = req.user.uid;
    const { name, email } = req.body;

    if (!name && !email) {
        return res.status(400).json({ error: 'Provide at least name or email to update' });
    }

    try {
        const updates = {};
        if (name)  updates.name  = name;
        if (email) updates.email = email;

        await db.collection('users').doc(uid).update(updates);
        res.json({ success: true, updated: updates });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/v1/user/change-password
router.put('/change-password', authMiddleware, async (req, res) => {
    const uid = req.user.uid;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }

    if (newPassword.length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    try {
        const userDoc = await db.collection('users').doc(uid).get();
        const user = userDoc.data();

        // ✅ Verify current password before allowing change
        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await db.collection('users').doc(uid).update({ password: hashedPassword });

        res.json({ success: true, message: 'Password updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/v1/user/linkedin-disconnect
router.post('/linkedin-disconnect', authMiddleware, async (req, res) => {
    const uid = req.user.uid;
    try {
        await db.collection('users').doc(uid).update({
            linkedinSession:     null,
            linkedinEmail:       null,
            linkedinConnectedAt: null,
        });
        res.json({ success: true, message: 'LinkedIn disconnected' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/v1/user/profile-image
router.post('/profile-image', authMiddleware, async (req, res) => {
  const uid = req.user.uid
  const { profileImage } = req.body

  if (!profileImage) {
    return res.status(400).json({ error: 'profileImage is required' })
  }

  // Validate it's a base64 image
  if (!profileImage.startsWith('data:image/')) {
    return res.status(400).json({ error: 'Invalid image format' })
  }

  // Rough size check — base64 string should be under 100KB
  const sizeKB = Math.round((profileImage.length * 3) / 4 / 1024)
  if (sizeKB > 100) {
    return res.status(400).json({ error: `Image too large (${sizeKB}KB). Max 100KB after compression.` })
  }

  try {
    await db.collection('users').doc(uid).update({ profileImage })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
router.get('/stats', authMiddleware, async (req, res) => {
    const uid = req.user.uid;
    try {
        const [campaignsSnap, leadsSnap, messagesSnap] = await Promise.all([
            db.collection('campaigns').where('userId', '==', uid).get(),
            db.collection('leads').where('userId', '==', uid).get(),
            db.collection('messages').where('userId', '==', uid).get(),
        ]);

        const leads = leadsSnap.docs.map(d => d.data());

        res.json({
            totalCampaigns:  campaignsSnap.size,
            totalLeads:      leadsSnap.size,
            totalMessages:   messagesSnap.size,
            accepted:        leads.filter(l => l.status === 'accepted').length,
            replied:         leads.filter(l => l.status === 'replied').length,
            meetings:        leads.filter(l => l.status === 'meeting').length,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;