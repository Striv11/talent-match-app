import { html, render, api, state, on, toast, openModal, closeModal, modalOpen, initials, icon, runAction } from './core.js';
import { renderJack, JACK_NAV, showPrep } from './jack.js';
import { renderJill, JILL_NAV, showOutreach, showOffer, applySourcing } from './jill.js';
import { startVoice, stopVoice, isVoiceActive, sendVoiceText } from './voice.js';

const PERSONAS = {
  candidate: { slug: 'jack', agent: 'Jack', tagline: 'for talent', nav: JACK_NAV, home: 'profile' },
  hr: { slug: 'jill', agent: 'Jill', tagline: 'for hiring', nav: JILL_NAV, home: 'overview' }
};
const SUGGESTIONS = {
  candidate: ['Find roles that fit me', 'What is missing from my profile?', 'Prep me for my best match', 'Any intro requests?'],
  hr: ['What needs my attention?', 'Source candidates for my newest role', 'Create a role: senior React engineer, Bengaluru, 30–45 LPA', 'Show this week\'s interviews']
};

// ---------- routing ----------

function parseRoute() {
  const [slug, view, ...params] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const persona = slug === 'jill' ? 'hr' : slug === 'jack' ? 'candidate' : (localStorageGet('jj-persona') || 'candidate');
  return { persona, view: view || PERSONAS[persona].home, params };
}

function localStorageGet(key) {
  try { return localStorage.getItem(key); } catch (error) { return null; }
}
function localStorageSet(key, value) {
  try { localStorage.setItem(key, value); } catch (error) { /* storage unavailable */ }
}

let renderToken = 0;

async function renderRoute() {
  if (!state.user) return;
  const route = parseRoute();
  state.route = route;
  state.persona = route.persona;
  localStorageSet('jj-persona', route.persona);
  document.body.dataset.persona = route.persona;
  renderShell();
  const view = document.getElementById('view');
  const token = ++renderToken;
  try {
    if (route.persona === 'hr') await renderJill(route.view, view, route.params);
    else await renderJack(route.view, view);
  } catch (error) {
    if (token !== renderToken) return;
    console.error(error);
    render(view, html`<div class="empty"><h3>Couldn't load this</h3><p class="muted">${error.message}</p><button class="btn" data-action="reload">Try again</button></div>`);
  }
}

state.rerender = () => renderRoute();
on('reload', () => renderRoute());
window.addEventListener('hashchange', () => {
  if (modalOpen()) closeModal();
  renderRoute();
  document.getElementById('view')?.scrollTo?.(0, 0);
});

// ---------- shell ----------

function renderShell() {
  const persona = PERSONAS[state.persona];
  render('#sidebar', html`
    <div class="brand"><span class="logo">j<span>&amp;</span>j</span><span class="brand-name">Jack &amp; Jill</span></div>
    <div class="persona-switch" role="tablist">
      ${Object.entries(PERSONAS).map(([key, item]) => html`<a role="tab" href="#/${item.slug}/${item.home}" class="${key === state.persona ? 'active' : ''}" aria-selected="${key === state.persona}">
        <strong>${item.agent}</strong><span>${item.tagline}</span></a>`)}
    </div>
    <nav class="nav">${persona.nav.map((item) => html`<a href="#/${persona.slug}/${item.view}" class="${state.route.view === item.view || (item.view === 'roles' && state.route.view === 'role') ? 'active' : ''}">${icon(item.icon)}<span>${item.label}</span></a>`)}</nav>
    <div class="sidebar-foot">
      ${state.developmentMode ? html`<button class="btn btn-ghost btn-sm full" data-action="seed">${icon('database')} Load demo data</button>` : ''}
      <div class="me">
        <div class="avatar">${initials(state.user.name)}</div>
        <div class="grow ellipsis"><strong class="small">${state.user.name}</strong><div class="muted tiny ellipsis">${state.developmentMode ? 'Local development' : state.user.email}</div></div>
        <button class="icon-btn" data-action="theme" title="Toggle theme" aria-label="Toggle theme">${icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon')}</button>
        ${state.authEnabled ? html`<button class="icon-btn" data-action="logout" title="Sign out" aria-label="Sign out">${icon('logout')}</button>` : ''}
      </div>
    </div>`);
  renderDock();
}

on('seed', async () => {
  const result = await api('/api/dev/seed', { method: 'POST', body: {} });
  toast(result.seeded ? `Added ${result.candidates} demo candidates and ${result.roles} demo roles` : 'Demo data is already loaded', 'success');
  renderRoute();
});

on('theme', () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  localStorageSet('jj-theme', dark ? 'dark' : 'light');
  renderShell();
});

on('logout', async () => {
  stopVoice();
  await api('/api/auth/logout', { method: 'POST', body: {} });
  location.reload();
});

// ---------- voice dock ----------

const dock = { status: 'idle', detail: '', caption: '', who: 'agent', tool: '', level: 0 };
const STATUS_TEXT = { idle: '', connecting: 'Connecting…', listening: 'Listening', speaking: 'Speaking', error: 'Voice error' };
const TOOL_TEXT = {
  update_my_profile: 'Saving to your profile', find_opportunities: 'Finding roles', create_role: 'Writing the JD', source_candidates: 'Ranking candidates',
  draft_outreach: 'Drafting outreach', schedule_interview: 'Booking interview', get_interview_kit: 'Building interview kit', draft_offer: 'Drafting offer',
  get_interview_prep: 'Preparing your brief', submit_screening: 'Sharing screening', get_sourcing_strings: 'Writing search strings'
};

function renderDock() {
  const agent = PERSONAS[state.persona].agent;
  const active = dock.status !== 'idle' && dock.status !== 'error';
  const root = document.getElementById('dock');
  root.dataset.status = dock.status;
  root.style.setProperty('--level', dock.level.toFixed(2));
  render(root, html`
    <button class="orb" data-action="voice-toggle" aria-label="${active ? 'End voice session' : `Talk to ${agent}`}" title="${active ? 'End' : `Talk to ${agent}`} (Ctrl+J)">
      <span class="orb-glow"></span>${icon(active ? 'stop' : 'mic', 20)}
    </button>
    <div class="dock-text">
      ${active || dock.status === 'error' ? html`
        <span class="dock-status">${dock.tool ? html`${icon('sparkle', 13)} ${dock.tool}…` : dock.status === 'error' ? dock.detail || STATUS_TEXT.error : `${agent} · ${STATUS_TEXT[dock.status]}`}</span>
        <span class="dock-caption ${dock.who === 'user' ? 'is-user' : ''}">${dock.caption || (dock.status === 'connecting' ? 'Getting the mic ready…' : 'Go ahead — I\'m listening.')}</span>`
      : html`<span class="dock-status">Talk to ${agent}</span><span class="dock-caption muted">Do anything here by voice — or type with Ctrl K</span>`}
    </div>
    <button class="kbd-btn" data-action="palette" title="Type a command (Ctrl+K)">${icon('command', 15)}<span>K</span></button>`);
}

function voiceHooks() {
  return {
    onStatus: (status, detail) => {
      dock.status = status;
      dock.detail = detail || '';
      if (status === 'idle') { dock.caption = ''; dock.tool = ''; dock.level = 0; }
      if (status === 'error' && detail) toast(detail, 'error');
      renderDock();
    },
    onCaption: (who, text) => {
      dock.who = who;
      dock.caption = text.length > 160 ? `…${text.slice(-160)}` : text;
      if (who === 'agent') dock.tool = '';
      renderDock();
    },
    onTurn: (who, text) => pushHistory(who === 'user' ? 'user' : 'model', text),
    onLevel: (level) => {
      dock.level = level;
      document.getElementById('dock').style.setProperty('--level', level.toFixed(2));
    },
    onTool: (name) => {
      dock.tool = TOOL_TEXT[name] || '';
      renderDock();
    },
    onAction: applyAction
  };
}

async function beginVoice(mode, roleId) {
  if (modalOpen()) closeModal();
  await startVoice({ mode, roleId, hooks: voiceHooks() });
}

on('voice', (element) => beginVoice(element.dataset.mode, element.dataset.roleId));
on('voice-toggle', () => {
  if (isVoiceActive()) return stopVoice();
  const roleId = state.route.view === 'role' ? state.route.params[0] : undefined;
  return beginVoice(state.persona === 'hr' ? 'jill' : 'jack', roleId);
});

// ---------- actions coming from the agent ----------

function applyAction(action) {
  const slug = PERSONAS[state.persona].slug;
  if (action.type === 'navigate') {
    const target = action.view === 'role' && action.roleId ? `#/${slug}/role/${action.roleId}/${action.tab || 'sourcing'}` : `#/${slug}/${action.view}`;
    if (location.hash !== target) location.hash = target;
    else renderRoute();
  } else if (action.type === 'refresh') {
    if (action.what === 'role' && state.cache.role) delete state.sourcing[state.cache.role.id];
    if (!modalOpen()) renderRoute();
  } else if (action.type === 'sourcing') {
    applySourcing(action.data);
    if (state.route.view === 'role' && state.route.params[0] === action.data.roleId) renderRoute();
  } else if (action.type === 'outreach') {
    showOutreach(action.draft);
  } else if (action.type === 'offer') {
    showOffer(action.offer);
  } else if (action.type === 'prep') {
    showPrep(action.prep);
  } else if (action.type === 'toast') {
    toast(action.text, 'success');
  }
}

// ---------- command palette ----------

function pushHistory(role, text) {
  const list = state.history[state.persona];
  list.push({ role, text });
  if (list.length > 30) list.splice(0, list.length - 30);
  if (document.getElementById('paletteLog')) renderPaletteLog();
}

function renderPaletteLog(thinking = false) {
  const list = state.history[state.persona];
  const log = render('#paletteLog', html`
    ${list.length ? '' : html`<div class="suggestions">${SUGGESTIONS[state.persona].map((text) => html`<button class="chip chip-btn" data-action="palette-suggest" data-text="${text}">${text}</button>`)}</div>`}
    ${list.map((turn) => html`<div class="msg msg-${turn.role}">${turn.text}</div>`)}
    ${thinking ? html`<div class="msg msg-model msg-thinking"><i></i><i></i><i></i></div>` : ''}`);
  if (log) log.scrollTop = log.scrollHeight;
}

on('palette', () => {
  const agent = PERSONAS[state.persona].agent;
  openModal({
    title: `Ask ${agent}`,
    subtitle: state.persona === 'hr' ? 'Create roles, source, move candidates, book interviews — in plain words.' : 'Update your profile, find roles, apply, prep — in plain words.',
    body: html`<div class="palette">
      <div id="paletteLog" class="palette-log"></div>
      <form data-action="palette-send" class="palette-input">
        <input name="message" autocomplete="off" placeholder="${state.persona === 'hr' ? 'e.g. move Aarav to interview for the backend role' : 'e.g. add Kubernetes and Terraform to my skills'}">
        <button class="btn btn-primary" type="submit" aria-label="Send">${icon('arrow')}</button>
      </form>
    </div>`
  });
  renderPaletteLog();
});

async function sendCommand(message) {
  if (!message.trim()) return;
  if (isVoiceActive() && sendVoiceText(message)) {
    renderPaletteLog();
    return;
  }
  const persona = state.persona;
  const history = state.history[persona].slice(-10);
  pushHistory('user', message);
  renderPaletteLog(true);
  try {
    const result = await api('/api/assistant', {
      method: 'POST',
      body: { persona, message, history, context: { view: state.route.view, roleId: state.route.view === 'role' ? state.route.params[0] : undefined } }
    });
    state.history[persona].push({ role: 'model', text: result.reply });
    const opensModal = result.actions.some((action) => ['outreach', 'offer', 'prep'].includes(action.type));
    if (opensModal) closeModal();
    result.actions.forEach(applyAction);
    if (!opensModal) renderPaletteLog();
  } catch (error) {
    state.history[persona].push({ role: 'model', text: error.message });
    renderPaletteLog();
  }
}

on('palette-send', async (form) => {
  const input = form.querySelector('input');
  const message = input.value;
  input.value = '';
  await sendCommand(message);
  document.querySelector('.palette-input input')?.focus();
});
on('palette-suggest', (element) => sendCommand(element.dataset.text));

document.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (state.user) runAction('palette');
  } else if (mod && event.key.toLowerCase() === 'j') {
    event.preventDefault();
    if (state.user) runAction('voice-toggle');
  } else if (event.key === 'Escape' && modalOpen()) {
    closeModal();
  }
});

// ---------- auth & boot ----------

async function loadGoogleIdentity() {
  if (window.google?.accounts?.id) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Google sign-in could not load.'));
    document.head.append(script);
  });
}

function showSignIn(clientId) {
  document.body.classList.add('signed-out');
  render('#view', html`<div class="signin">
    <span class="logo logo-lg">j<span>&amp;</span>j</span>
    <h1 class="display">Hiring, by conversation.</h1>
    <p class="muted">Jack finds you roles worth your time. Jill finds the people worth hiring. Just talk.</p>
    <div id="googleButton"></div>
  </div>`);
  loadGoogleIdentity().then(() => {
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: async (response) => {
        try {
          const result = await api('/api/auth/google', { method: 'POST', body: { credential: response.credential } });
          state.user = result.user;
          document.body.classList.remove('signed-out');
          renderRoute();
        } catch (error) {
          toast(error.message, 'error');
        }
      }
    });
    window.google.accounts.id.renderButton(document.getElementById('googleButton'), { theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with' });
  }).catch((error) => toast(error.message, 'error'));
}

async function boot() {
  const savedTheme = localStorageGet('jj-theme');
  document.documentElement.dataset.theme = savedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  try {
    const config = await api('/api/auth/config');
    state.authEnabled = config.enabled;
    state.developmentMode = config.developmentMode;
    if (config.enabled) {
      try {
        state.user = (await api('/api/auth/me')).user;
      } catch (error) {
        state.user = null;
      }
      if (!state.user) return showSignIn(config.clientId);
    } else if (config.developmentMode) {
      state.user = (await api('/api/auth/me')).user;
    } else {
      render('#view', html`<div class="empty"><h3>Sign-in is not configured</h3><p class="muted">Set GOOGLE_CLIENT_ID and SESSION_SECRET on the server.</p></div>`);
      return;
    }
    if (!location.hash) location.replace(`#/${PERSONAS[parseRoute().persona].slug}/${PERSONAS[parseRoute().persona].home}`);
    renderRoute();
  } catch (error) {
    render('#view', html`<div class="empty"><h3>Can't reach the server</h3><p class="muted">${error.message}</p></div>`);
  }
}

boot();
