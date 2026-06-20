/**
 * linkedinAuth.js — OAuth 2.0 routes for LinkedIn OpenID Connect
 * Handles:
 *   A) Login/Register with LinkedIn button
 *   B) Import LinkedIn profile data after email signup
 */

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const jwt     = require('jsonwebtoken');
const { db }  = require('../config/firebase');
const authMiddleware = require('../middleware/authMiddleware');

const CLIENT_ID     = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const REDIRECT_URI  = process.env.LINKEDIN_REDIRECT_URI;
const FRONTEND_URL  = process.env.FRONTEND_URL || 'http://localhost:5173';

const cookieOptions = {
  httpOnly: true,
  secure:   process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  maxAge:   7 * 24 * 60 * 60 * 1000,
};

// ── GET /api/v1/auth/linkedin — kick off OAuth (login or import) ──────────────
// ?mode=login  → login/register flow
// ?mode=import → import profile for existing user
router.get('/linkedin', (req, res) => {
  const mode  = req.query.mode || 'login';
  const state = Buffer.from(JSON.stringify({
    mode,
    // If import mode, carry the JWT so we know which user after callback
    token: mode === 'import' ? (req.cookies?.token || req.headers.authorization?.split(' ')[1] || '') : '',
    ts:    Date.now(),
  })).toString('base64');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    state,
    scope:         'openid profile email',
  });

  res.redirect(`https://www.linkedin.com/oauth/v2/authorization?${params}`);
});

// ── GET /api/v1/auth/linkedin/callback — handle OAuth callback ────────────────
router.get('/linkedin/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('[linkedin-oauth] Error:', error);
    return res.redirect(`${FRONTEND_URL}/login?error=linkedin_denied`);
  }

  if (!code) {
    return res.redirect(`${FRONTEND_URL}/login?error=no_code`);
  }

  // Decode state
  let stateData = { mode: 'login', token: '' };
  try {
    stateData = JSON.parse(Buffer.from(state, 'base64').toString());
  } catch {}

  try {
    // ── Step 1: Exchange code for access token ──────────────────────────────
    const tokenRes = await axios.post(
      'https://www.linkedin.com/oauth/v2/accessToken',
      new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  REDIRECT_URI,
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token } = tokenRes.data;

    // ── Step 2: Fetch LinkedIn profile via OpenID Connect userinfo ────────
    const profileRes = await axios.get(
      'https://api.linkedin.com/v2/userinfo',
      { headers: { Authorization: `Bearer ${access_token}` } }
    );

    const profile = profileRes.data;
    // OpenID Connect userinfo fields:
    // sub, name, given_name, family_name, email, email_verified, picture
    const linkedinId   = profile.sub;
    const email        = profile.email        || null;
    const name         = profile.name         || `${profile.given_name || ''} ${profile.family_name || ''}`.trim();
    const picture      = profile.picture      || null;

    console.log(`[linkedin-oauth] Profile: ${name} (${email})`);

    // ── Mode A: Login / Register ──────────────────────────────────────────
    if (stateData.mode === 'login') {
      // Check if user exists by linkedinId or email
      let userDoc  = null;
      let uid      = null;

      // Try finding by linkedinId first
      const byLinkedIn = await db.collection('users')
        .where('linkedinId', '==', linkedinId)
        .limit(1).get();

      if (!byLinkedIn.empty) {
        userDoc = byLinkedIn.docs[0];
        uid     = userDoc.id;
      } else if (email) {
        // Try by email
        const byEmail = await db.collection('users')
          .where('email', '==', email)
          .limit(1).get();

        if (!byEmail.empty) {
          userDoc = byEmail.docs[0];
          uid     = userDoc.id;
          // Link LinkedIn ID to existing account
          await userDoc.ref.update({
            linkedinId,
            linkedinOAuthPicture:      picture,
            linkedinOAuthName:         name,
            linkedinOAuthConnectedAt:  new Date().toISOString(),
          });
        }
      }

      // New user — create account
      if (!userDoc) {
        const newUserRef = await db.collection('users').add({
          email:         email || null,
          name,
          linkedinId,
          isVerified:    true,   // LinkedIn already verified the email
          password:      null,   // no password for OAuth users
          createdAt:     new Date().toISOString(),
          profileImage:  picture || null,
          linkedinOAuthPicture:     picture,
          linkedinOAuthName:        name,
          linkedinOAuthConnectedAt: new Date().toISOString(),
          linkedinSession: null,
        });
        uid = newUserRef.id;
        console.log(`[linkedin-oauth] New user created: ${uid}`);
      } else {
        // Update profile picture and name from OAuth
        await userDoc.ref.update({
          linkedinOAuthPicture:     picture,
          linkedinOAuthName:        name,
          linkedinOAuthConnectedAt: new Date().toISOString(),
          ...(picture && !userDoc.data().profileImage ? { profileImage: picture } : {}),
        });
        console.log(`[linkedin-oauth] Existing user logged in: ${uid}`);
      }

      // Issue JWT
      const token = jwt.sign(
        { uid, email: email || linkedinId },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      // Set cookie and redirect to dashboard with uid in query for localStorage
      res.cookie('token', token, cookieOptions);
      return res.redirect(`${FRONTEND_URL}/oauth-callback?uid=${uid}&token=${token}&mode=login`);
    }

    // ── Mode B: Import profile for existing user ──────────────────────────
    if (stateData.mode === 'import') {
      // Verify the user's existing JWT from state
      let existingUid = null;
      try {
        const decoded = jwt.verify(stateData.token, process.env.JWT_SECRET);
        existingUid   = decoded.uid;
      } catch {
        return res.redirect(`${FRONTEND_URL}/settings?error=session_expired`);
      }

      // Update their profile with LinkedIn data
      await db.collection('users').doc(existingUid).update({
        linkedinId,
        linkedinOAuthPicture:     picture,
        linkedinOAuthName:        name,
        linkedinOAuthEmail:       email,
        linkedinOAuthConnectedAt: new Date().toISOString(),
        // Only set profileImage if user doesn't already have one
        ...(picture ? { profileImage: picture } : {}),
      });

      console.log(`[linkedin-oauth] Profile imported for user: ${existingUid}`);
      return res.redirect(`${FRONTEND_URL}/oauth-callback?mode=import&success=true`);
    }

  } catch (err) {
    console.error('[linkedin-oauth] Callback error:', err.message);
    return res.redirect(`${FRONTEND_URL}/login?error=oauth_failed`);
  }
});

module.exports = router;