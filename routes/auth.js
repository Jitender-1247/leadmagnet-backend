const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { db } = require('../config/firebase');
const { initiateLinkedInLogin, submitLinkedInOtp } = require('../services/linkedinService');
const authMiddleware = require('../middleware/authMiddleware');
const { sendOtpEmail } = require('./emailService');
const bcrypt = require('bcrypt');

// ── Shared cookie config ───────────────────────────────────────────────────
const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
};

const generateOtp = (length = 6) => {
    const min = 10 ** (length - 1);
    const max = 9 * min;
    return Math.floor(min + Math.random() * max).toString();
};

// POST /api/v1/auth/register
router.post('/register', async (req, res) => {
    const { email, password, name } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    try {
        const existing = await db.collection('users')
            .where('email', '==', email).get();

        if (!existing.empty) {
            const existingUser = existing.docs[0].data();
            if (existingUser.isVerified) {
                return res.status(400).json({ error: 'User already exists' });
            }
            await existing.docs[0].ref.delete();
        }

        const otp = generateOtp();
        const expiry = Date.now() + 5 * 60 * 1000;

        const userRef = await db.collection('users').add({
            email,
            password: hashedPassword,
            name,
            isVerified: false,
            emailOtp: otp,
            otpExpiry: expiry,
            createdAt: new Date().toISOString(),
            linkedinSession: null
        });

        await sendOtpEmail(email, otp);

        res.status(201).json({
            message: 'User registered. Please verify your email.',
            uid: userRef.id
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/v1/auth/platform-login
router.post('/platform-login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const snapshot = await db.collection('users')
            .where('email', '==', email)
            .get();

        if (snapshot.empty) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const userDoc = snapshot.docs[0];
        const user = userDoc.data();

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        if (!user.isVerified) {
            return res.status(403).json({
                error: 'Please verify your email before logging in.',
                uid: userDoc.id,
                requiresVerification: true
            });
        }

        const token = jwt.sign(
            { uid: userDoc.id, email },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.cookie('token', token, cookieOptions)
           .json({ uid: userDoc.id });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/v1/auth/linkedin-connect
router.post('/linkedin-connect', authMiddleware, async (req, res) => {
    const { email, password } = req.body;
    const uid = req.user.uid;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await initiateLinkedInLogin(uid, email, password);
    if (result.requiresOtp) return res.status(202).json(result);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
});

// POST /api/v1/auth/linkedin-verify-otp
router.post('/linkedin-verify-otp', authMiddleware, async (req, res) => {
    const { otp } = req.body;
    const uid = req.user.uid;

    if (!otp) {
        return res.status(400).json({ error: 'OTP is required' });
    }

    const result = await submitLinkedInOtp(uid, otp);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
});

// POST /api/v1/auth/verify-email
router.post('/verify-email', async (req, res) => {
    const { uid, otp } = req.body;

    try {
        const userRef = db.collection('users').doc(uid);
        const userSnap = await userRef.get();

        if (!userSnap.exists) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = userSnap.data();

        if (user.emailOtp !== otp) {
            return res.status(400).json({ error: 'Invalid OTP' });
        }

        if (Date.now() > user.otpExpiry) {
            return res.status(400).json({ error: 'OTP expired' });
        }

        await userRef.update({
            isVerified: true,
            emailOtp: null,
            otpExpiry: null
        });

        const token = jwt.sign(
            { uid, email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.cookie('token', token, cookieOptions)
           .json({ message: 'Email verified successfully', uid });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/v1/auth/resend-otp
router.post('/resend-otp', async (req, res) => {
    const { uid } = req.body;

    try {
        const otp = generateOtp();
        const expiry = Date.now() + 5 * 60 * 1000;

        const userRef = db.collection('users').doc(uid);
        const userSnap = await userRef.get();

        if (!userSnap.exists) {
            return res.status(404).json({ error: 'User not found' });
        }

        const email = userSnap.data().email;

        await userRef.update({ emailOtp: otp, otpExpiry: expiry });
        await sendOtpEmail(email, otp);
        res.json({ message: 'OTP resent' });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/v1/auth/logout
router.post('/logout', (req, res) => {
    res.clearCookie('token', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax'
    }).json({ message: 'Logged out successfully' });
});

// GET /api/v1/auth/me — verify session is still valid
router.get('/me', authMiddleware, async (req, res) => {
    try {
        const userSnap = await db.collection('users').doc(req.user.uid).get();
        if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });
        const { password, emailOtp, otpExpiry, linkedinSession, ...safeUser } = userSnap.data();
        res.json({ uid: req.user.uid, ...safeUser });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;