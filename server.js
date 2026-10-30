const express = require('express');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const { OAuth2Client } = require('google-auth-library');
const services = require('./lib/services');
const agent = require('./lib/agent');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

app.use(express.json({ limit: '32mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- auth ----------

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const oauthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const googleAuthEnabled = Boolean(oauthClient && SESSION_SECRET.length >= 32);

app.get('/api/auth/config', (req, res) => {
  res.json({
    enabled: googleAuthEnabled,
    clientId: googleAuthEnabled ? GOOGLE_CLIENT_ID : null,
    developmentMode: !googleAuthEnabled && !IS_PRODUCTION
  });
});

app.post('/api/auth/google', async (req, res) => {
  if (!googleAuthEnabled) return res.status(503).json({ error: 'Google OAuth is not configured on this server.' });
  try {
    const ticket = await oauthClient.verifyIdToken({ idToken: req.body.credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email || !payload.email_verified) {
      return res.status(401).json({ error: 'A verified Google account is required.' });
    }

    const sessionPayload = Buffer.from(JSON.stringify({
      sub: payload.sub,
      email: payload.email.toLowerCase(),
      name: payload.name || payload.email,
      picture: payload.picture,
      exp: Date.now() + 8 * 60 * 60 * 1000
    })).toString('base64url');
    const signature = crypto.createHmac('sha256', SESSION_SECRET).update(sessionPayload).digest('base64url');
    const secureFlag = IS_PRODUCTION ? '; Secure' : '';
    res.set('Set-Cookie', `jj_session=${sessionPayload}.${signature}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${secureFlag}`);
    res.json({ user: { sub: payload.sub, email: payload.email.toLowerCase(), name: payload.name || payload.email, picture: payload.picture } });
  } catch (error) {
    res.status(401).json({ error: 'Google sign-in could not be verified.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const secureFlag = IS_PRODUCTION ? '; Secure' : '';
  res.set('Set-Cookie', `jj_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureFlag}`);
  res.json({ signedOut: true });
});

function requireUser(req, res, next) {
  if (!googleAuthEnabled) {
    if (IS_PRODUCTION) return res.status(503).json({ error: 'Configure Google OAuth before production use.' });
    req.user = { sub: 'local-dev', email: 'local@development.invalid', name: 'Local developer' };
    return next();
  }

  const cookie = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('jj_session='));
  const value = cookie?.slice('jj_session='.length) || '';
  const separator = value.lastIndexOf('.');
  if (separator < 0) return res.status(401).json({ error: 'Sign in with Google to continue.' });

  const sessionPayload = value.slice(0, separator);
  const receivedSignature = Buffer.from(value.slice(separator + 1), 'base64url');
  const expectedSignature = crypto.createHmac('sha256', SESSION_SECRET).update(sessionPayload).digest();
  if (receivedSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(receivedSignature, expectedSignature)) {
    return res.status(401).json({ error: 'Your sign-in session is invalid. Sign in again.' });
  }

  try {
    const user = JSON.parse(Buffer.from(sessionPayload, 'base64url').toString('utf8'));
    if (!user.sub || user.exp < Date.now()) return res.status(401).json({ error: 'Your sign-in session expired. Sign in again.' });
    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Your sign-in session is invalid. Sign in again.' });
  }
}

app.use('/api', requireUser);
app.get('/api/auth/me', (req, res) => res.json({ user: req.user }));

// Wraps async handlers so thrown HttpErrors and AI errors reach the error middleware.
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).then((body) => {
  if (body !== undefined && !res.headersSent) res.json(body);
}).catch(next);

// ---------- voice ----------

const VOICE_MODES = {
  jack: { voice: 'Puck', greeting: 'Greet the candidate by first name in one short sentence and ask how you can help today — or, if their profile is thin, suggest building it together.' },
  'jack-interview': { voice: 'Puck', greeting: 'Start the get-to-know-you interview now.' },
  'jack-screening': { voice: 'Puck', greeting: 'Start the screening now.' },
  jill: { voice: 'Aoede', greeting: 'Greet the user by first name in one short sentence and ask what they would like to work on — offer the most useful next step based on their roles.' }
};

const tokenRequestWindow = new Map();
app.post('/api/voice/session-token', route(async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new services.HttpError(503, 'Voice is not configured yet. Set GEMINI_API_KEY on the server.');

  const now = Date.now();
  const windowKey = req.user.sub || req.ip;
  const requestWindow = tokenRequestWindow.get(windowKey);
  if (requestWindow && now - requestWindow.startedAt < 15 * 60 * 1000 && requestWindow.count >= 20) {
    throw new services.HttpError(429, 'Too many voice sessions. Try again in a few minutes.');
  }
  if (!requestWindow || now - requestWindow.startedAt >= 15 * 60 * 1000) tokenRequestWindow.set(windowKey, { startedAt: now, count: 1 });
  else requestWindow.count += 1;

  const mode = VOICE_MODES[req.body.mode] ? req.body.mode : 'jack';
  const persona = agent.personaForMode(mode);
  const config = {
    responseModalities: ['AUDIO'],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: { slidingWindow: {} },
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_MODES[mode].voice } } },
    systemInstruction: { parts: [{ text: agent.instructions(req.user, mode, { roleId: req.body.roleId }) }] },
    tools: [{ functionDeclarations: agent.declarationsFor(persona, { voice: true }) }]
  };

  try {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
        liveConnectConstraints: { model: GEMINI_LIVE_MODEL, config }
      }
    });
    res.set('Cache-Control', 'no-store');
    return { token: token.name, model: GEMINI_LIVE_MODEL, config, persona, mode, greeting: VOICE_MODES[mode].greeting };
  } catch (error) {
    console.error('Could not create Gemini Live token:', error.message);
    throw new services.HttpError(502, 'Could not start the voice service. Check the Gemini API configuration.');
  }
}));

app.post('/api/tools/:name', route(async (req) => {
  const persona = req.body.persona === 'hr' ? 'hr' : 'candidate';
  return agent.runTool(req.user, persona, req.params.name, req.body.args || {}, req.body.utterance || '');
}));

app.post('/api/assistant', route(async (req) => {
  if (!String(req.body.message || '').trim()) throw new services.HttpError(400, 'Type a message.');
  return agent.runTextAgent(req.user, {
    persona: req.body.persona === 'hr' ? 'hr' : 'candidate',
    message: req.body.message,
    history: Array.isArray(req.body.history) ? req.body.history : [],
    context: req.body.context || {}
  });
}));

// ---------- candidate (Jack) ----------

app.get('/api/me/home', route((req) => services.candidateHome(req.user)));
app.get('/api/me/profile', route((req) => services.getMyProfile(req.user)));
app.patch('/api/me/profile', route((req) => services.updateMyProfile(req.user, req.body, { replaceLists: true })));
app.post('/api/me/profile/import', route((req) => services.importMyProfile(req.user, req.body)));
app.post('/api/me/discoverable', route((req) => services.setDiscoverable(req.user, req.body.discoverable)));
app.get('/api/me/opportunities', route((req) => services.myOpportunities(req.user)));
app.post('/api/me/opportunities/:roleId/respond', route((req) => services.respondToRole(req.user, { roleId: req.params.roleId, response: req.body.response })));
app.get('/api/me/applications', route((req) => services.myApplications(req.user)));
app.post('/api/me/intros/:id/respond', route((req) => services.respondToIntro(req.user, { introId: req.params.id, response: req.body.response })));
app.post('/api/me/prep/:roleId', route((req) => services.prepForRole(req.user, req.params.roleId)));
app.get('/api/roles/:id/public', route((req) => services.publicRole(req.user, req.params.id)));

// ---------- hiring team (Jill) ----------

app.get('/api/hr/summary', route((req) => services.hiringSummary(req.user)));
app.get('/api/hr/companies', route((req) => services.listMyCompanies(req.user)));
app.post('/api/hr/companies', route((req) => services.upsertCompany(req.user, req.body)));
app.get('/api/hr/roles', route((req) => services.listMyRoles(req.user)));
app.post('/api/hr/roles/generate', route((req) => services.createRoleFromBrief(req.user, req.body)));
app.post('/api/hr/roles/ingest', route((req) => services.ingestJobDescription(req.user, req.body)));
app.get('/api/hr/roles/:id', route((req) => services.getMyRole(req.user, req.params.id)));
app.patch('/api/hr/roles/:id', route((req) => services.updateRole(req.user, req.params.id, req.body)));
app.post('/api/hr/roles/:id/source', route((req) => services.sourceForRole(req.user, req.params.id, { deep: Boolean(req.body.deep) })));
app.post('/api/hr/roles/:id/sourcing-plan', route((req) => services.getSourcingPlan(req.user, req.params.id, { refresh: Boolean(req.body.refresh) })));
app.post('/api/hr/roles/:id/kit', route((req) => services.getInterviewKit(req.user, req.params.id, { refresh: Boolean(req.body.refresh) })));
app.get('/api/hr/pipeline', route((req) => services.getPipeline(req.user, req.query.roleId)));
app.post('/api/hr/pipeline/move', route((req) => services.moveCandidate(req.user, req.body)));
app.post('/api/hr/pipeline/note', route((req) => services.addNote(req.user, req.body)));
app.post('/api/hr/outreach', route((req) => services.draftOutreach(req.user, req.body)));
app.post('/api/hr/intros', route((req) => services.requestIntro(req.user, req.body)));
app.post('/api/hr/offer', route((req) => services.draftOffer(req.user, req.body)));
app.get('/api/hr/talent', route((req) => services.talentPool(req.user, { query: req.query.q })));
app.post('/api/hr/candidates/import', route((req) => services.importCandidates(req.user, req.body)));
app.get('/api/hr/candidates/:id', route((req) => services.getCandidateForHR(req.user, req.params.id, req.query.roleId)));
app.get('/api/hr/interviews', route((req) => services.listInterviews(req.user)));
app.post('/api/hr/interviews', route((req) => services.scheduleInterview(req.user, req.body)));
app.post('/api/hr/interviews/:id/feedback', route((req) => services.addInterviewFeedback(req.user, req.params.id, req.body)));
app.get('/api/hr/interviews/:id/ics', route((req, res) => {
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="interview-${req.params.id}.ics"`);
  res.send(services.interviewICS(req.user, req.params.id));
}));

if (!IS_PRODUCTION) {
  app.post('/api/dev/seed', route(() => services.seedDemo()));
}

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((error, req, res, next) => {
  const status = error.status || (error.type === 'entity.too.large' ? 413 : 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 && !error.status ? 'Something went wrong. Please try again.' : error.message });
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Jack & Jill India is running on http://localhost:${PORT}`);
});
