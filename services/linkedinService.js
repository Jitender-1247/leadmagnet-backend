require('dotenv').config();
const axios   = require('axios');
// tough-cookie and axios-cookiejar-support removed — using manual cookie
// management in login flow to avoid httpsAgent conflicts
const crypto  = require('crypto');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { db }  = require('../config/firebase');

// ── Crypto (unchanged — same encrypted storage) ───────────────────────────────
const IV_LENGTH = 16;

function getKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY is not set');
  if (Buffer.from(key).length !== 32) throw new Error('ENCRYPTION_KEY must be exactly 32 characters');
  return key;
}

function encrypt(text) {
  const key = getKey();
  const iv  = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
  const key = getKey();
  const [ivHex, encryptedHex] = text.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encryptedText = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

// ── Human delay — Gaussian distribution ──────────────────────────────────────
function humanDelay(minMs = 2000, maxMs = 8000) {
  const mean   = (minMs + maxMs) / 2;
  const stdDev = (maxMs - minMs) / 6;
  const u1 = Math.random(), u2 = Math.random();
  const z  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const delay   = Math.round(mean + z * stdDev);
  const clamped = Math.max(minMs, Math.min(maxMs, delay));
  return new Promise(r => setTimeout(r, clamped));
}

// ── Random tracking ID (required by LinkedIn API) ─────────────────────────────
function generateTrackingId() {
  return Buffer.from(crypto.randomBytes(16)).toString('base64');
}

// ── Consistent User Agent per user (same UA = less fingerprint flags) ─────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
];

function getUserAgent(uid) {
  const index = uid.charCodeAt(0) % USER_AGENTS.length;
  return USER_AGENTS[index];
}

// ── Proxy config (optional — set PROXY_HOST/PORT/USER/PASS in .env) ───────────
function getProxyAgent(uid) {
  const host = process.env.PROXY_HOST;
  const port = process.env.PROXY_PORT;
  const user = process.env.PROXY_USER;
  const pass = process.env.PROXY_PASS;
  if (!host || !port) return null;
  // Sticky session per user — same IP for same user
  const sessionId = `user-${uid.slice(0, 8)}`;
  const auth      = user ? `${user}-session-${sessionId}:${pass}` : null;
  const proxyUrl  = auth
    ? `http://${auth}@${host}:${port}`
    : `http://${host}:${port}`;
  return new HttpsProxyAgent(proxyUrl);
}

// ── Build authenticated LinkedIn HTTP client ──────────────────────────────────
function buildClient(cookies, uid) {
  const agent = getProxyAgent(uid);
  const ua    = getUserAgent(uid);

  const config = {
    headers: {
      'User-Agent':                  ua,
      'Accept-Language':             'en-US,en;q=0.9',
      'Accept':                      'application/json',
      'Cookie':                      `li_at=${cookies.li_at}; JSESSIONID="${cookies.JSESSIONID}"`,
      'Csrf-Token':                  cookies.JSESSIONID,
      'X-RestLi-Protocol-Version':   '2.0.0',
      'X-Li-Lang':                   'en_US',
      'X-Li-Track':                  JSON.stringify({
        clientVersion:  '1.13.1291',
        mpVersion:      '1.13.1291',
        osName:         'web',
        timezoneOffset: 5.5,
        timezone:       'Asia/Calcutta',
        deviceFormFactor: 'DESKTOP',
        mpName:         'voyager-web',
      }),
      'sec-fetch-dest':              'empty',
      'sec-fetch-mode':              'cors',
      'sec-fetch-site':              'same-origin',
      'Referer':                     'https://www.linkedin.com/feed/',
    },
    baseURL:       'https://www.linkedin.com',
    timeout:       30000,
    maxRedirects:  5,
    ...(agent ? { httpsAgent: agent } : {}),
  };

  return axios.create(config);
}

// ── Detect challenge / session expired ───────────────────────────────────────
function isChallenge(err) {
  const status = err?.response?.status;
  const url    = err?.response?.config?.url || '';
  const data   = JSON.stringify(err?.response?.data || '');
  if (status === 999)  return true;
  if (status === 401)  return true;
  if (status === 302 && url.includes('challenge')) return true;
  if (data.includes('challenge'))  return true;
  if (data.includes('checkpoint')) return true;
  return false;
}

// ── Retry wrapper with backoff ────────────────────────────────────────────────
async function withRetry(fn, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.response?.status;
      if (isChallenge(err)) throw err;                // don't retry challenges
      if (status === 429) {
        const wait = attempt * 10 * 60 * 1000;        // 10, 20, 30 min
        console.warn(`[linkedin] Rate limited. Waiting ${wait / 60000}m (attempt ${attempt})`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 2000));
        continue;
      }
      throw err;
    }
  }
}

// ── In-memory OTP session store (login step 1 → step 2) ──────────────────────
// Stores the cookie jar between the two login steps
const pendingLogins = {};

// ── STEP 1 — Initiate LinkedIn login ─────────────────────────────────────────
async function initiateLinkedInLogin(uid, email, password) {
  console.log(`[linkedin] 🔐 Initiating login for user ${uid}`);

  try {
    const proxyAgent = getProxyAgent(uid);
    const ua         = getUserAgent(uid);

    // Manual cookie store — avoids axios-cookiejar-support entirely
    // which conflicts with httpsAgent. We extract Set-Cookie headers
    // from responses and pass Cookie headers in subsequent requests manually.
    let cookieStore = {};

    function parseCookies(setCookieHeaders) {
      if (!setCookieHeaders) return;
      const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
      arr.forEach(line => {
        const part = line.split(';')[0].trim();
        const idx  = part.indexOf('=');
        if (idx > 0) {
          const key = part.slice(0, idx).trim();
          const val = part.slice(idx + 1).trim();
          cookieStore[key] = val;
        }
      });
    }

    function buildCookieHeader() {
      return Object.entries(cookieStore).map(([k, v]) => `${k}=${v}`).join('; ');
    }

    // Plain axios instance — no wrapper, no conflict
    const http = axios.create({
      timeout:         30000,
      maxRedirects:    10,
      validateStatus:  () => true,  // handle all status codes manually
      headers: {
        'User-Agent':      ua,
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      ...(proxyAgent ? { httpsAgent: proxyAgent } : {}),
    });

    async function httpGet(url, extraHeaders = {}) {
      const res = await http.get(url, {
        headers: { Cookie: buildCookieHeader(), ...extraHeaders },
      });
      parseCookies(res.headers['set-cookie']);
      return res;
    }

    async function httpPost(url, data, extraHeaders = {}) {
      const res = await http.post(url, data, {
        headers: { Cookie: buildCookieHeader(), ...extraHeaders },
      });
      parseCookies(res.headers['set-cookie']);
      return res;
    }

    // Thin client wrapper matching the rest of the function
    const client = {
      get:  (url, cfg = {}) => httpGet(url,  cfg.headers || {}),
      post: (url, data, cfg = {}) => httpPost(url, data, cfg.headers || {}),
    };

    // ── Step 1: Load login page to get CSRF token ─────────────────────────────
    console.log('[linkedin] Loading login page...');
    const loginPage = await client.get('https://www.linkedin.com/login', {
      headers: { 'Referer': 'https://www.linkedin.com/' }
    });

    // Extract CSRF token
    const csrfMatch = loginPage.data.match(/name="loginCsrfParam"[^>]*value="([^"]+)"/);
    const csrf      = csrfMatch?.[1];
    if (!csrf) {
      console.error('[linkedin] Could not extract CSRF token');
      return { success: false, message: 'Could not load LinkedIn login page. LinkedIn may be blocking this IP.' };
    }
    console.log('[linkedin] ✅ CSRF token extracted');

    await humanDelay(1500, 3000);

    // ── Step 2: Submit credentials ────────────────────────────────────────────
    console.log('[linkedin] Submitting credentials...');
    const loginRes = await client.post(
      'https://www.linkedin.com/checkpoint/lg/login-submit',
      new URLSearchParams({
        session_key:      email,
        session_password: password,
        loginCsrfParam:   csrf,
        trk:              'guest_homepage-basic_nav-header-signin',
        fromSignIn:       '1',
        joinNow:          '',
        session_redirect: '/feed/',
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer':      'https://www.linkedin.com/login',
          'Origin':       'https://www.linkedin.com',
        },
      }
    );

    // ── Get cookies from jar ──────────────────────────────────────────────────
    const finalUrl  = loginRes.request?.res?.responseUrl || loginRes.config?.url || '';
    const liAt      = cookieStore['li_at']      ? { value: cookieStore['li_at'] }      : null;
    const jsession  = cookieStore['JSESSIONID'] ? { value: cookieStore['JSESSIONID'] } : null;

    console.log('[linkedin] Final URL:', finalUrl);
    console.log('[linkedin] li_at found:', !!liAt);

    // ── Success — logged in directly ──────────────────────────────────────────
    if (liAt && (
      finalUrl.includes('/feed') ||
      finalUrl.includes('/mynetwork') ||
      finalUrl.includes('/jobs') ||
      !finalUrl.includes('/login')
    )) {
      const authCookies = {
        li_at:     liAt.value,
        JSESSIONID: jsession?.value?.replace(/"/g, '') || '',
      };

      const encryptedCookies = encrypt(JSON.stringify(authCookies));

      // Fetch profile data
      const profileData = await fetchProfileData(authCookies, uid);

      await db.collection('users').doc(uid).update({
        linkedinSession:      encryptedCookies,
        linkedinEmail:        email,
        linkedinConnected:    true,
        linkedinConnectedAt:  new Date().toISOString(),
        linkedinCookiesAt:    Date.now(),
        ...(profileData.profileImage && { linkedinProfileImage: profileData.profileImage }),
        ...(profileData.displayName  && { linkedinDisplayName:  profileData.displayName  }),
      });

      console.log('[linkedin] ✅ Login successful');
      return { success: true, message: 'LinkedIn connected successfully ✅' };
    }

    // ── OTP / Challenge required ──────────────────────────────────────────────
    if (
      finalUrl.includes('checkpoint') ||
      finalUrl.includes('challenge') ||
      finalUrl.includes('verify') ||
      finalUrl.includes('pin') ||
      loginRes.data?.includes?.('verification') ||
      loginRes.data?.includes?.('challenge')
    ) {
      console.log('[linkedin] 🔐 OTP/challenge required:', finalUrl);

      // Store cookie store for step 2
      pendingLogins[uid] = {
        cookieStore,
        client,
        challengeUrl: finalUrl,
        email,
        expiresAt: Date.now() + 10 * 60 * 1000,
      };

      // Auto-cleanup after 10 minutes
      setTimeout(() => { delete pendingLogins[uid]; }, 10 * 60 * 1000);

      return {
        success:     false,
        requiresOtp: true,
        message:     'Verification required — submit the OTP sent to your email/phone',
      };
    }

    // ── Wrong credentials or other error ─────────────────────────────────────
    const errorMatch = loginRes.data?.match?.(/aria-live="polite"[^>]*>([^<]+)</);
    const errorMsg   = errorMatch?.[1]?.trim() || 'Invalid credentials or LinkedIn is blocking this login.';
    console.error('[linkedin] ❌ Login failed:', errorMsg);
    return { success: false, message: errorMsg };

  } catch (err) {
    console.error('[linkedin] ❌ Login error:', err.message);
    return { success: false, message: err.message };
  }
}

// ── STEP 2 — Submit OTP ───────────────────────────────────────────────────────
async function submitLinkedInOtp(uid, otp) {
  const session = pendingLogins[uid];
  if (!session) {
    return { success: false, message: 'Session expired. Please restart the login process.' };
  }

  if (Date.now() > session.expiresAt) {
    delete pendingLogins[uid];
    return { success: false, message: 'OTP session expired. Please restart the login process.' };
  }

  const { client, cookieStore, email } = session;

  try {
    console.log('[linkedin] Submitting OTP...');
    await humanDelay(1000, 2000);

    // Submit the PIN/OTP
    await client.post(
      'https://www.linkedin.com/checkpoint/challenge/verify',
      new URLSearchParams({
        pin:              otp,
        challengeType:    'EMAIL_PIN',
        resendPinCounter: '0',
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer':      session.challengeUrl,
          'Origin':       'https://www.linkedin.com',
        },
      }
    );

    // Read cookies from cookieStore (manual cookie management)
    const liAt     = cookieStore['li_at']      ? { value: cookieStore['li_at'] }      : null;
    const jsession = cookieStore['JSESSIONID'] ? { value: cookieStore['JSESSIONID'] } : null;

    if (!liAt) {
      delete pendingLogins[uid];
      return { success: false, message: 'OTP verification failed. Please check the code and try again.' };
    }

    const authCookies = {
      li_at:      liAt.value,
      JSESSIONID: jsession?.value?.replace(/"/g, '') || '',
    };

    const encryptedCookies = encrypt(JSON.stringify(authCookies));
    const profileData      = await fetchProfileData(authCookies, uid);

    await db.collection('users').doc(uid).update({
      linkedinSession:     encryptedCookies,
      linkedinEmail:       email,
      linkedinConnected:   true,
      linkedinConnectedAt: new Date().toISOString(),
      linkedinCookiesAt:   Date.now(),
      ...(profileData.profileImage && { linkedinProfileImage: profileData.profileImage }),
      ...(profileData.displayName  && { linkedinDisplayName:  profileData.displayName  }),
    });

    delete pendingLogins[uid];
    console.log('[linkedin] ✅ OTP verified — LinkedIn connected');
    return { success: true, message: 'LinkedIn connected successfully ✅' };

  } catch (err) {
    delete pendingLogins[uid];
    console.error('[linkedin] ❌ OTP error:', err.message);
    return { success: false, message: err.message };
  }
}

// ── Fetch profile data after login (name + photo) ─────────────────────────────
async function fetchProfileData(cookies, uid) {
  try {
    const client = buildClient(cookies, uid);
    const res    = await client.get('/voyager/api/me', {
      headers: { 'Accept': 'application/json' }
    });

    const data        = res.data;
    const miniProfile = data?.miniProfile || data?.included?.[0];
    const displayName = miniProfile
      ? `${miniProfile.firstName || ''} ${miniProfile.lastName || ''}`.trim()
      : null;

    const picture       = miniProfile?.picture;
    const artifacts     = picture?.['com.linkedin.common.VectorImage']?.artifacts;
    const profileImage  = artifacts?.length
      ? picture['com.linkedin.common.VectorImage'].rootUrl + artifacts[artifacts.length - 1].fileIdentifyingUrlPathSegment
      : null;

    return { displayName, profileImage };
  } catch (err) {
    console.warn('[linkedin] Could not fetch profile data:', err.message);
    return { displayName: null, profileImage: null };
  }
}

// ── Get cookies from DB, decrypt, parse ──────────────────────────────────────
async function getCookies(uid) {
  const userDoc = await db.collection('users').doc(uid).get();
  const user    = userDoc.data();

  if (!user?.linkedinSession) {
    throw new Error('LinkedIn not connected. Please connect your LinkedIn account.');
  }

  const decrypted = decrypt(user.linkedinSession);

  // Support both old format (raw li_at string) and new format (JSON object)
  let cookies;
  try {
    cookies = JSON.parse(decrypted);
  } catch {
    // Old format — just the li_at value as a plain string
    cookies = { li_at: decrypted, JSESSIONID: '' };
  }

  return cookies;
}

// ── Mark challenge required on user ──────────────────────────────────────────
async function markChallengeRequired(uid) {
  await db.collection('users').doc(uid).update({
    linkedinChallengeRequired: true,
    linkedinConnected:         false,
    campaignPausedReason:      'linkedin_challenge',
  });
}

// ── View a LinkedIn profile ───────────────────────────────────────────────────
async function viewProfile(uid, profileId) {
  const cookies = await getCookies(uid);
  const client  = buildClient(cookies, uid);

  await withRetry(async () => {
    await client.get(`/voyager/api/identity/profiles/${profileId}/profileView`);
  });

  await humanDelay(3000, 7000);
  console.log(`[linkedin] 👁️ Viewed profile: ${profileId}`);
}

// ── Send connection request ───────────────────────────────────────────────────
async function sendConnectionRequest(uid, profileId, message = '') {
  const cookies = await getCookies(uid);
  const client  = buildClient(cookies, uid);

  try {
    await withRetry(async () => {
      const body = {
        trackingId: generateTrackingId(),
        invitee: {
          'com.linkedin.voyager.growth.invitation.InviteeProfile': {
            profileId,
          },
        },
      };
      if (message?.trim()) body.message = message.trim();

      const res = await client.post(
        '/voyager/api/growth/normInvitations',
        body,
        { headers: { 'Content-Type': 'application/json' } }
      );
      return res;
    });

    await humanDelay(3000, 8000);
    console.log(`[linkedin] 🤝 Connection request sent to: ${profileId}`);
    return { success: true };

  } catch (err) {
    if (isChallenge(err)) {
      await markChallengeRequired(uid);
      return { success: false, requiresChallenge: true };
    }
    console.error('[linkedin] ❌ sendConnectionRequest error:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Send a direct message ─────────────────────────────────────────────────────
async function sendMessage(uid, profileUrn, messageText) {
  const cookies = await getCookies(uid);
  const client  = buildClient(cookies, uid);

  try {
    await withRetry(async () => {
      await client.post(
        '/voyager/api/messaging/conversations',
        {
          keyVersion: 'LEGACY_INBOX',
          conversationCreate: {
            eventCreate: {
              value: {
                'com.linkedin.voyager.messaging.create.MessageCreate': {
                  attributedBody: { text: messageText, attributes: [] },
                  attachments:    [],
                },
              },
            },
            recipients: [profileUrn],
            subtype:    'MEMBER_TO_MEMBER',
          },
        },
        { headers: { 'Content-Type': 'application/json' } }
      );
    });

    await humanDelay(2000, 5000);
    console.log(`[linkedin] 💬 Message sent to: ${profileUrn}`);
    return { success: true };

  } catch (err) {
    if (isChallenge(err)) {
      await markChallengeRequired(uid);
      return { success: false, requiresChallenge: true };
    }
    console.error('[linkedin] ❌ sendMessage error:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Send InMail ───────────────────────────────────────────────────────────────
async function sendInMail(uid, profileId, subject, body) {
  const cookies = await getCookies(uid);
  const client  = buildClient(cookies, uid);

  try {
    await withRetry(async () => {
      await client.post(
        `/voyager/api/premium/inMails/${profileId}`,
        { subject, body, includedCustomMessage: !!body },
        { headers: { 'Content-Type': 'application/json' } }
      );
    });

    await humanDelay(3000, 7000);
    console.log(`[linkedin] 📧 InMail sent to: ${profileId}`);
    return { success: true };

  } catch (err) {
    if (isChallenge(err)) {
      await markChallengeRequired(uid);
      return { success: false, requiresChallenge: true };
    }
    console.error('[linkedin] ❌ sendInMail error:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Follow a profile ──────────────────────────────────────────────────────────
async function followProfile(uid, profileId) {
  const cookies = await getCookies(uid);
  const client  = buildClient(cookies, uid);

  try {
    await withRetry(async () => {
      await client.post(
        '/voyager/api/identity/follows',
        { 'com.linkedin.voyager.identity.follow.FollowProfile': { profileId } },
        { headers: { 'Content-Type': 'application/json' } }
      );
    });

    await humanDelay(2000, 5000);
    console.log(`[linkedin] ❤️ Followed: ${profileId}`);
    return { success: true };

  } catch (err) {
    if (isChallenge(err)) { await markChallengeRequired(uid); return { success: false, requiresChallenge: true }; }
    console.error('[linkedin] ❌ followProfile error:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Endorse skills ────────────────────────────────────────────────────────────
async function endorseSkills(uid, profileId) {
  const cookies = await getCookies(uid);
  const client  = buildClient(cookies, uid);

  try {
    // First get their skills
    const skillsRes = await client.get(
      `/voyager/api/identity/profiles/${profileId}/skills`
    );
    const skills = skillsRes.data?.elements?.slice(0, 3) || [];

    for (const skill of skills) {
      await withRetry(async () => {
        await client.post(
          '/voyager/api/identity/normSkillEndorsements',
          {
            endorsee:  { profileId },
            skillName: skill.name,
          },
          { headers: { 'Content-Type': 'application/json' } }
        );
      });
      await humanDelay(1500, 3000);
    }

    console.log(`[linkedin] ⭐ Endorsed ${skills.length} skills for: ${profileId}`);
    return { success: true };

  } catch (err) {
    if (isChallenge(err)) { await markChallengeRequired(uid); return { success: false, requiresChallenge: true }; }
    console.error('[linkedin] ❌ endorseSkills error:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Get inbox messages ────────────────────────────────────────────────────────
async function getInboxMessages(uid) {
  const cookies = await getCookies(uid);
  const client  = buildClient(cookies, uid);

  const res = await withRetry(() =>
    client.get('/voyager/api/messaging/conversations', {
      params: {
        keyVersion: 'LEGACY_INBOX',
        q:          'participants',
        count:      20,
      },
    })
  );

  return res.data?.elements || [];
}

// ── Check for accepted connections ───────────────────────────────────────────
async function checkAcceptedConnections(uid) {
  const cookies = await getCookies(uid);
  const client  = buildClient(cookies, uid);

  const res = await withRetry(() =>
    client.get('/voyager/api/relationships/invitationViews', {
      params: { invitationType: 'CONNECTION', q: 'receivedInvitations', count: 100 },
    })
  );

  const accepted = (res.data?.elements || [])
    .filter(e => e.invitation?.genericInvitationType === 'CONNECTION');

  return accepted;
}

// ── Check for replies ─────────────────────────────────────────────────────────
async function checkForReplies(uid, liAt) {
  try {
    // liAt might be a raw string (old format) or decrypt result
    let cookies;
    try {
      cookies = JSON.parse(liAt);
    } catch {
      cookies = { li_at: liAt, JSESSIONID: '' };
    }

    const client = buildClient(cookies, uid);
    const res    = await client.get('/voyager/api/messaging/conversations', {
      params: {
        keyVersion: 'LEGACY_INBOX',
        q:          'participants',
        count:      50,
      },
    });

    const conversations = res.data?.elements || [];
    let   repliesFound  = 0;

    for (const conv of conversations) {
      // Check if conversation has unread messages from the prospect
      const lastActivity = conv.lastActivityAt;
      const leadSnap = await db.collection('leads')
        .where('userId', '==', uid)
        .where('threadUrl', '==', conv.entityUrn)
        .get();

      if (!leadSnap.empty) {
        const lead = leadSnap.docs[0];
        if (lead.data().status === 'requested' || lead.data().status === 'accepted') {
          await lead.ref.update({ status: 'replied', repliedAt: new Date().toISOString() });
          repliesFound++;
        }
      }
    }

    return repliesFound;
  } catch (err) {
    console.error('[linkedin] ❌ checkForReplies error:', err.message);
    return 0;
  }
}

// ── Scrape leads from LinkedIn search URL ─────────────────────────────────────
async function scrapeLeads(uid, encryptedCookie, searchUrl, campaignId, maxLeads = 25) {
  console.log(`[linkedin] 🔍 Scraping leads for campaign ${campaignId}`);

  let cookies;
  try {
    const decrypted = decrypt(encryptedCookie);
    try { cookies = JSON.parse(decrypted); }
    catch { cookies = { li_at: decrypted, JSESSIONID: '' }; }
  } catch (err) {
    throw new Error('Invalid LinkedIn session. Please reconnect.');
  }

  const client = buildClient(cookies, uid);

  // ── Extract search params from URL ───────────────────────────────────────
  let searchParams;
  try {
    const urlObj = new URL(searchUrl);
    searchParams = Object.fromEntries(urlObj.searchParams.entries());
  } catch {
    throw new Error('Invalid search URL');
  }

  const allProfiles = [];
  let   start       = 0;
  const pageSize    = 10;

  console.log('[DEBUG] Extracted searchParams:', JSON.stringify(searchParams));
  console.log('[DEBUG] keywords value:', searchParams.keywords);

  while (allProfiles.length < maxLeads) {
    console.log(`[linkedin] 📄 Fetching page start=${start}...`);

    try {
      // RestLi query DSL requires string values inside parens to NOT use
      // encodeURIComponent (axios encodes the whole param string already).
      // Spaces inside keywords must become %20 only once, and the keywords
      // value itself should not be additionally URL-encoded here.
      const keywordsRaw = searchParams.keywords || '';
      const queryDsl = `(keywords:${keywordsRaw},flagshipSearchIntent:SEARCH_SRP,queryParameters:(resultType:List(PEOPLE)),includeFiltersInResponse:false)`;

      console.log('[DEBUG] keywordsRaw:', keywordsRaw);
      console.log('[DEBUG] queryDsl:', queryDsl);

      const res = await withRetry(() =>
        client.get('/voyager/api/search/dash/clusters', {
          params: {
            decorationId: 'com.linkedin.voyager.dash.deco.search.SearchClusterCollection-181',
            origin:       'GLOBAL_SEARCH_HEADER',
            q:            'all',
            query:        queryDsl,
            start,
            count: pageSize,
          },
          headers: {
            'Accept': 'application/vnd.linkedin.normalized+json+2.1',
          },
        })
      );

      const included = res.data?.included || [];
      console.log('[DEBUG] Raw response status:', res.status);
      console.log('[DEBUG] Top-level keys:', Object.keys(res.data || {}));
      console.log('[DEBUG] Full response (first 1500 chars):', JSON.stringify(res.data).slice(0, 1500));
      console.log('[DEBUG] included[] length:', included.length);

      const people   = included.filter(e =>
        e.$type === 'com.linkedin.voyager.dash.identity.profile.Profile' ||
        e.entityUrn?.includes('fsd_profile')
      );

      if (people.length === 0) {
        console.log('[linkedin] No more results');
        break;
      }

      for (const person of people) {
        if (allProfiles.length >= maxLeads) break;

        const miniProfile = person.hitInfo?.['com.linkedin.voyager.search.SearchProfile']?.miniProfile
          || person.miniProfile;

        if (!miniProfile) continue;

        const profileId  = miniProfile.publicIdentifier || miniProfile.entityUrn?.split(':').pop();
        const name       = `${miniProfile.firstName || ''} ${miniProfile.lastName || ''}`.trim();
        const headline   = miniProfile.occupation || null;
        const profileUrl = profileId ? `https://www.linkedin.com/in/${profileId}` : null;

        const picture      = miniProfile.picture?.['com.linkedin.common.VectorImage'];
        const artifacts    = picture?.artifacts;
        const profileImage = artifacts?.length
          ? picture.rootUrl + artifacts[artifacts.length - 1].fileIdentifyingUrlPathSegment
          : null;

        allProfiles.push({ profileId, profileUrl, name, headline, profileImage, company: null, location: null });
        await humanDelay(200, 500); // small delay between profile processing
      }

      start += pageSize;
      await humanDelay(3000, 6000); // delay between search pages

    } catch (err) {
      if (isChallenge(err)) {
        await markChallengeRequired(uid);
        throw new Error('LinkedIn session challenge detected. Please re-verify your account.');
      }
      console.error('[linkedin] ❌ Search page error:', err.message);
      break;
    }
  }

  const leads = allProfiles.slice(0, maxLeads);
  console.log(`[linkedin] 📋 Scraped ${leads.length} profiles`);

  // ── Enrich profiles with detailed data (optional, adds time) ─────────────
  const ENRICH_LIMIT = Math.min(leads.length, 10); // only enrich first 10 to save time
  for (let i = 0; i < ENRICH_LIMIT; i++) {
    const lead = leads[i];
    if (!lead.profileId) continue;

    try {
      await humanDelay(4000, 8000);
      const res = await client.get(`/voyager/api/identity/profiles/${lead.profileId}/profileView`);
      const profile   = res.data?.profile;
      const positions = res.data?.positionView?.elements || [];
      const topPos    = positions[0];

      if (profile) {
        lead.location = profile.geoLocationName || profile.locationName || null;
      }
      if (topPos) {
        lead.company = topPos.companyName || null;
      }
      console.log(`[linkedin] ✅ Enriched: ${lead.name}`);
    } catch (err) {
      console.warn(`[linkedin] Could not enrich ${lead.profileId}: ${err.message}`);
    }
  }

  // ── Save to Firestore ─────────────────────────────────────────────────────
  if (leads.length > 0) {
    const batch = db.batch();
    leads.forEach(lead => {
      const ref = db.collection('leads').doc();
      batch.set(ref, {
        campaignId,
        userId:       uid,
        profileUrl:   lead.profileUrl   || null,
        profileId:    lead.profileId    || null,
        name:         lead.name         || null,
        headline:     lead.headline     || null,
        location:     lead.location     || null,
        company:      lead.company      || null,
        profileImage: lead.profileImage || null,
        status:    'pending',
        createdAt: new Date().toISOString(),
      });
    });
    await batch.commit();
    console.log(`[linkedin] 💾 Saved ${leads.length} leads to Firestore`);
  }

  return leads;
}

module.exports = {
  initiateLinkedInLogin,
  submitLinkedInOtp,
  scrapeLeads,
  viewProfile,
  sendConnectionRequest,
  sendMessage,
  sendInMail,
  followProfile,
  endorseSkills,
  getInboxMessages,
  checkAcceptedConnections,
  checkForReplies,
  getCookies,
  decrypt,
  encrypt,
};