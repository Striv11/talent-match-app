// ---------- safe HTML templating ----------

class Safe {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);

function format(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Safe) return value.value;
  if (Array.isArray(value)) return value.map(format).join('');
  return escape(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, index) => { out += format(value) + strings[index + 1]; });
  return new Safe(out);
}

export const raw = (value) => new Safe(String(value));

export function render(target, content) {
  const element = typeof target === 'string' ? document.querySelector(target) : target;
  if (element) element.innerHTML = format(content);
  return element;
}

// ---------- API ----------

export async function api(url, { method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (error) { data = null; }
  if (!response.ok) {
    const error = new Error(data?.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

// ---------- shared app state ----------

export const state = {
  user: null,
  authEnabled: false,
  developmentMode: false,
  persona: 'candidate',
  route: { persona: 'candidate', view: 'profile', params: [] },
  cache: {},
  sourcing: {},
  history: { candidate: [], hr: [] }
};

// ---------- delegated actions ----------

const actions = new Map();

export function on(name, handler) {
  actions.set(name, handler);
}

export async function runAction(name, element, event) {
  const handler = actions.get(name);
  if (!handler) return;
  const busyTarget = element?.tagName === 'BUTTON' ? element : null;
  if (busyTarget?.dataset.busy === '1') return;
  try {
    if (busyTarget) {
      busyTarget.dataset.busy = '1';
      busyTarget.classList.add('is-busy');
    }
    await handler(element, event);
  } catch (error) {
    console.error(error);
    toast(error.message || 'Something went wrong.', 'error');
  } finally {
    if (busyTarget) {
      delete busyTarget.dataset.busy;
      busyTarget.classList.remove('is-busy');
    }
  }
}

document.addEventListener('click', (event) => {
  const element = event.target.closest('[data-action]');
  if (!element || element.tagName === 'FORM') return;
  event.preventDefault();
  runAction(element.dataset.action, element, event);
});

document.addEventListener('submit', (event) => {
  const form = event.target.closest('form[data-action]');
  if (!form) return;
  event.preventDefault();
  const submit = form.querySelector('[type="submit"]');
  runAction(form.dataset.action, form, event).finally(() => submit?.classList.remove('is-busy'));
  submit?.classList.add('is-busy');
});

document.addEventListener('change', (event) => {
  const element = event.target.closest('[data-change]');
  if (element) runAction(element.dataset.change, element, event);
});

export function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// ---------- toasts ----------

export function toast(text, tone = 'info') {
  const root = document.getElementById('toasts');
  const item = document.createElement('div');
  item.className = `toast toast-${tone}`;
  item.textContent = text;
  root.append(item);
  requestAnimationFrame(() => item.classList.add('show'));
  setTimeout(() => {
    item.classList.remove('show');
    setTimeout(() => item.remove(), 300);
  }, tone === 'error' ? 6000 : 3500);
}

// ---------- modals ----------

let modalCloser = null;

export function openModal({ title, subtitle, body, wide = false, onClose }) {
  closeModal();
  const root = document.getElementById('modalRoot');
  root.innerHTML = format(html`
    <div class="modal-backdrop" data-modal-close>
      <div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
        <header class="modal-head">
          <div>
            <h2>${title}</h2>
            ${subtitle ? html`<p class="muted">${subtitle}</p>` : ''}
          </div>
          <button class="icon-btn" data-modal-close aria-label="Close">${icon('x')}</button>
        </header>
        <div class="modal-body">${body}</div>
      </div>
    </div>`);
  const backdrop = root.firstElementChild;
  requestAnimationFrame(() => backdrop.classList.add('show'));
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop || event.target.closest('.modal-head [data-modal-close]')) closeModal();
  });
  backdrop.querySelector('input, textarea, select')?.focus();
  modalCloser = () => {
    root.innerHTML = '';
    onClose?.();
  };
  return root.querySelector('.modal-body');
}

export function closeModal() {
  const closer = modalCloser;
  modalCloser = null;
  closer?.();
}

export const modalOpen = () => Boolean(modalCloser);

export function setModalBody(content) {
  render('#modalRoot .modal-body', content);
}

// ---------- formatting ----------

export function md(text) {
  const lines = escape(String(text || '')).split(/\r?\n/);
  const out = [];
  let inList = false;
  const inline = (line) => line
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  lines.forEach((line) => {
    const trimmed = line.trim();
    const bullet = trimmed.match(/^[-*•]\s+(.*)/) || trimmed.match(/^\d+[.)]\s+(.*)/);
    if (bullet) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(bullet[1])}</li>`);
      return;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    const heading = trimmed.match(/^(#{1,4})\s+(.*)/);
    if (heading) out.push(`<h${Math.min(heading[1].length + 2, 5)}>${inline(heading[2])}</h${Math.min(heading[1].length + 2, 5)}>`);
    else if (trimmed) out.push(`<p>${inline(trimmed)}</p>`);
  });
  if (inList) out.push('</ul>');
  return raw(`<div class="prose">${out.join('')}</div>`);
}

export const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('') || '?';

export const lpa = (min, max) => {
  if (min && max) return `₹${min}–${max} LPA`;
  if (max || min) return `₹${max || min} LPA`;
  return '';
};

export function relativeDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const diff = (date.getTime() - Date.now()) / 86400000;
  const formatter = new Intl.RelativeTimeFormat('en-IN', { numeric: 'auto' });
  if (Math.abs(diff) < 1 / 24) return formatter.format(Math.round(diff * 24 * 60), 'minute');
  if (Math.abs(diff) < 1) return formatter.format(Math.round(diff * 24), 'hour');
  if (Math.abs(diff) < 30) return formatter.format(Math.round(diff), 'day');
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export const dateTime = (iso) => new Date(iso).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function scoreRing(score, size = 44) {
  const value = Math.max(0, Math.min(100, Math.round(score || 0)));
  const radius = (size - 6) / 2;
  const circumference = 2 * Math.PI * radius;
  const tone = value >= 75 ? 'high' : value >= 50 ? 'mid' : 'low';
  return html`<div class="ring ring-${tone}" style="width:${size}px;height:${size}px" title="Match score ${value}/100">
    <svg viewBox="0 0 ${size} ${size}" aria-hidden="true">
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" class="ring-track"></circle>
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" class="ring-value" stroke-dasharray="${(circumference * value) / 100} ${circumference}"></circle>
    </svg>
    <span>${value}</span>
  </div>`;
}

export const chips = (items, tone = '') => html`${(items || []).map((item) => html`<span class="chip ${tone}">${item}</span>`)}`;

export function emptyState({ title, text, action }) {
  return html`<div class="empty"><div class="empty-mark">${icon('sparkle')}</div><h3>${title}</h3><p class="muted">${text}</p>${action || ''}</div>`;
}

export const skeleton = (rows = 3) => html`<div class="skeleton-list">${Array.from({ length: rows }, () => html`<div class="skeleton"></div>`)}</div>`;

// ---------- files ----------

const MIME_BY_EXTENSION = { pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

export function readFile(file) {
  return new Promise((resolve, reject) => {
    const extension = file.name.split('.').pop().toLowerCase();
    if (['doc', 'docx'].includes(extension)) {
      reject(new Error('Word files are not supported yet — save it as PDF and try again.'));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      reject(new Error(`${file.name} is over 10 MB.`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, mimeType: file.type || MIME_BY_EXTENSION[extension] || 'application/octet-stream', data: String(reader.result).split(',')[1] });
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

export function dropZone({ action, label, hint, multiple = false }) {
  return html`<label class="dropzone" data-drop="${action}">
    <input type="file" hidden ${multiple ? raw('multiple') : ''} accept=".pdf,.txt,.md,.png,.jpg,.jpeg,.webp" data-change="${action}">
    <span class="dropzone-icon">${icon('upload')}</span>
    <strong>${label}</strong>
    <span class="muted small">${hint}</span>
  </label>`;
}

document.addEventListener('dragover', (event) => {
  const zone = event.target.closest('[data-drop]');
  if (!zone) return;
  event.preventDefault();
  zone.classList.add('is-over');
});
document.addEventListener('dragleave', (event) => event.target.closest?.('[data-drop]')?.classList.remove('is-over'));
document.addEventListener('drop', (event) => {
  const zone = event.target.closest('[data-drop]');
  if (!zone) return;
  event.preventDefault();
  zone.classList.remove('is-over');
  runAction(zone.dataset.drop, { files: event.dataTransfer.files, dataset: zone.dataset, closest: (selector) => zone.closest(selector) }, event);
});

export const filesFrom = (element) => [...(element.files || [])];

export async function copyText(text) {
  await navigator.clipboard.writeText(text);
  toast('Copied');
}

// ---------- icons (inline, stroke-based) ----------

const ICONS = {
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 3v4M17 5h4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/>',
  inbox: '<path d="M4 13h4l2 3h4l2-3h4"/><path d="M5 5h14l2 8v6H3v-6z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 4 6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  command: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  back: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>'
};

export const icon = (name, size = 18) => raw(`<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`);
