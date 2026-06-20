const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { db }  = require('../config/firebase');
const { initiateLinkedInLogin, submitLinkedInOtp , encrypt } = require('../services/linkedinService');
const authMiddleware = require('../middleware/authMiddleware');
const { sendOtpEmail } = require('./emailService');
const bcrypt = require('bcrypt');
const axios = require('axios');

// ── Shared cookie config ───────────────────────────────────────────────────────
const cookieOptions = {
  httpOnly: true,
  secure:   process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  maxAge:   7 * 24 * 60 * 60 * 1000
};

const generateOtp = (length = 6) => {
  const min = 10 ** (length - 1);
  const max = 9 * min;
  return Math.floor(min + Math.random() * max).toString();
};

// ── POST /api/v1/auth/register ────────────────────────────────────────────────
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
      // Unverified — delete stale record and allow re-registration
      await existing.docs[0].ref.delete();
    }

    const otp    = generateOtp();
    const expiry = Date.now() + 5 * 60 * 1000;

    const userRef = await db.collection('users').add({
      email,
      password:    hashedPassword,
      name,
      isVerified:  false,
      emailOtp:    otp,
      otpExpiry:   expiry,
      createdAt:   new Date().toISOString(),
      linkedinSession: null
    });

    await sendOtpEmail(email, otp);

    // No token yet — user must verify email first
    res.status(201).json({
      message: 'User registered. Please verify your email.',
      uid:     userRef.id
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/v1/auth/platform-login ─────────────────────────────────────────
router.post('/platform-login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const snapshot = await db.collection('users')
      .where('email', '==', email).get();

    if (snapshot.empty) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const userDoc = snapshot.docs[0];
    const user    = userDoc.data();

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.isVerified) {
      return res.status(403).json({
        error:                'Please verify your email before logging in.',
        uid:                  userDoc.id,
        requiresVerification: true
      });
    }

    const token = jwt.sign(
      { uid: userDoc.id, email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Set cookie AND return token in body (token needed for localhost dev)
    res.cookie('token', token, cookieOptions)
       .json({ uid: userDoc.id, token });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/v1/auth/linkedin-connect ───────────────────────────────────────
router.post('/linkedin-connect', authMiddleware, async (req, res) => {
  const { email, password } = req.body;
  const uid = req.user.uid;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const result = await initiateLinkedInLogin(uid, email, password);
  if (result.requiresOtp) return res.status(202).json(result);
  if (!result.success)    return res.status(400).json(result);
  res.json(result);
});

// ── POST /api/v1/auth/linkedin-verify-otp ────────────────────────────────────
router.post('/linkedin-verify-otp', authMiddleware, async (req, res) => {
  const { otp } = req.body;
  const uid     = req.user.uid;

  if (!otp) {
    return res.status(400).json({ error: 'OTP is required' });
  }

  const result = await submitLinkedInOtp(uid, otp);
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

// ── POST /api/v1/auth/verify-email ───────────────────────────────────────────
router.post('/verify-email', async (req, res) => {
  const { uid, otp } = req.body;

  try {
    const userRef  = db.collection('users').doc(uid);
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
      emailOtp:   null,
      otpExpiry:  null
    });

    // Issue token after email confirmed
    const token = jwt.sign(
      { uid, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Set cookie AND return token in body (token needed for localhost dev)
    res.cookie('token', token, cookieOptions)
       .json({ message: 'Email verified successfully', uid, token });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/v1/auth/resend-otp ─────────────────────────────────────────────
router.post('/resend-otp', async (req, res) => {
  const { uid } = req.body;

  try {
    const otp    = generateOtp();
    const expiry = Date.now() + 5 * 60 * 1000;

    const userRef  = db.collection('users').doc(uid);
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

// ── POST /api/v1/auth/logout ─────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  }).json({ message: 'Logged out successfully' });
});

// ── GET /api/v1/auth/me — verify session ─────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const userSnap = await db.collection('users').doc(req.user.uid).get();
    if (!userSnap.exists) {
      return res.status(404).json({ error: 'User not found' });
    }
    const { password, emailOtp, otpExpiry, linkedinSession, ...safeUser } = userSnap.data();
    res.json({ uid: req.user.uid, ...safeUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── POST /api/v1/auth/linkedin-cookie-connect ─────────────────────────────────
router.post('/linkedin-cookie-connect', authMiddleware, async (req, res) => {
  const { cookies } = req.body;
  const uid         = req.user.uid;

  if (!cookies || !cookies.li_at) {
    return res.status(400).json({ success: false, error: 'Missing li_at cookie' });
  }

  try {
    // ── Validate the cookie actually works by hitting LinkedIn's /me endpoint ──
    const testRes = await axios.get('https://www.linkedin.com/voyager/api/me', {
      headers: {
        'Cookie':       `li_at=${cookies.li_at}; JSESSIONID="${cookies.JSESSIONID || ''}"`,
        'Csrf-Token':   cookies.JSESSIONID || '',
        'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':       'application/json',
        'X-RestLi-Protocol-Version': '2.0.0',
      },
      validateStatus: () => true,
      timeout: 15000,
    });

    if (testRes.status !== 200) {
      console.warn('[linkedin-cookie-connect] Validation failed:', testRes.status);
      return res.status(400).json({
        success: false,
        error:   'Could not verify cookies with LinkedIn. They may be expired or invalid. Please try the bookmarklet again while logged into LinkedIn.',
      });
    }

    // ── Extract basic profile info from the response ───────────────────────
    const data         = testRes.data;
    const miniProfile  = data?.miniProfile || data?.included?.[0];
    const displayName  = miniProfile
      ? `${miniProfile.firstName || ''} ${miniProfile.lastName || ''}`.trim()
      : null;

    const picture      = miniProfile?.picture;
    const artifacts     = picture?.['com.linkedin.common.VectorImage']?.artifacts;
    const profileImage  = artifacts?.length
      ? picture['com.linkedin.common.VectorImage'].rootUrl + artifacts[artifacts.length - 1].fileIdentifyingUrlPathSegment
      : null;

    // ── Encrypt and store ────────────────────────────────────────────────────
    const cookiePayload = {
      li_at:      cookies.li_at,
      JSESSIONID: (cookies.JSESSIONID || '').replace(/"/g, ''),
    };
    const encrypted = encrypt(JSON.stringify(cookiePayload));

    await db.collection('users').doc(uid).update({
      linkedinSession:     encrypted,
      linkedinConnected:   true,
      linkedinConnectedAt: new Date().toISOString(),
      linkedinCookiesAt:   Date.now(),
      linkedinChallengeRequired: false,
      ...(profileImage && { linkedinProfileImage: profileImage }),
      ...(displayName  && { linkedinDisplayName:  displayName  }),
    });

    console.log(`[linkedin-cookie-connect] ✅ Connected via bookmarklet: ${uid}`);
    return res.json({ success: true, message: 'LinkedIn connected successfully' });

  } catch (err) {
    console.error('[linkedin-cookie-connect] Error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to verify LinkedIn cookies. Please try again.' });
  }
});

module.exports = router;