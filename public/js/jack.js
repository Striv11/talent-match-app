import { html, raw, render, api, state, on, toast, openModal, closeModal, setModalBody, md, initials, lpa, relativeDate, dateTime, scoreRing, chips, emptyState, skeleton, readFile, dropZone, filesFrom, formData, icon } from './core.js';

const rerender = () => state.rerender?.();

// ---------- profile ----------

function onboarding() {
  return html`
    <section class="hero-block">
      <p class="eyebrow">Jack · your AI career agent</p>
      <h1 class="display">Tell your story once.<br><span class="accent-text">Get roles that actually fit.</span></h1>
      <p class="lead muted">Pick whichever is fastest for you. Jack builds your profile, keeps it private until you say so, and brings you matched roles — no spray-and-pray applications.</p>
    </section>
    <section class="option-grid">
      <article class="option-card option-primary">
        <span class="option-icon">${icon('mic', 22)}</span>
        <h3>Talk to Jack</h3>
        <p class="muted">A relaxed 10-minute conversation. Jack asks the right follow-ups and writes your profile as you talk.</p>
        <button class="btn btn-primary" data-action="voice" data-mode="jack-interview">${icon('mic')} Start interview</button>
      </article>
      <article class="option-card">
        <span class="option-icon">${icon('upload', 22)}</span>
        <h3>Import LinkedIn or résumé</h3>
        ${dropZone({ action: 'jack-import-file', label: 'Drop a PDF here or browse', hint: 'LinkedIn → your profile → Resources → Save to PDF' })}
      </article>
      <article class="option-card">
        <span class="option-icon">${icon('file', 22)}</span>
        <h3>Paste anything</h3>
        <form data-action="jack-import-text" class="stack-sm">
          <textarea name="text" rows="4" placeholder="Paste your LinkedIn About + Experience, or résumé text"></textarea>
          <input name="linkedinUrl" placeholder="linkedin.com/in/you (optional)">
          <button class="btn" type="submit">${icon('sparkle')} Build my profile</button>
        </form>
      </article>
    </section>`;
}

function preferenceRow(label, value) {
  return value ? html`<div class="kv"><span>${label}</span><strong>${value}</strong></div>` : '';
}

function profileView({ profile: p, completeness }) {
  const missing = completeness.missing || [];
  return html`
    <section class="card profile-head">
      <div class="avatar avatar-lg">${initials(p.name)}</div>
      <div class="profile-id">
        <h1>${p.name}</h1>
        <p class="muted">${p.headline || [p.currentTitle, p.currentCompany].filter(Boolean).join(' at ')}</p>
        <div class="meta-row">
          ${p.city ? html`<span>${p.city}</span>` : ''}
          ${Number.isFinite(p.experienceYears) ? html`<span>${p.experienceYears} yrs experience</span>` : ''}
          ${p.noticePeriod ? html`<span>${p.noticePeriod} notice</span>` : ''}
          ${p.email ? html`<span>${p.email}</span>` : ''}
        </div>
      </div>
      <div class="profile-actions">
        <label class="switch" title="Let hiring teams find you and request introductions">
          <input type="checkbox" data-change="jack-discoverable" ${p.discoverable ? raw('checked') : ''}>
          <span class="switch-track"></span>
          <span>${p.discoverable ? 'Visible to hiring teams' : 'Private'}</span>
        </label>
        <div class="row-sm">
          <button class="btn btn-ghost" data-action="jack-edit">${icon('edit')} Edit</button>
          <button class="btn btn-ghost" data-action="jack-reimport">${icon('upload')} Import</button>
        </div>
      </div>
    </section>

    ${missing.length ? html`
      <section class="card nudge">
        <div class="nudge-ring">${scoreRing(completeness.percent, 56)}</div>
        <div class="grow">
          <h3>Profile ${completeness.percent}% complete</h3>
          <p class="muted small">Jack still wants to know: ${missing.slice(0, 5).join(' · ')}${missing.length > 5 ? ` +${missing.length - 5} more` : ''}</p>
        </div>
        <button class="btn btn-primary" data-action="voice" data-mode="jack-interview">${icon('mic')} Fill gaps by voice</button>
      </section>` : ''}

    <div class="split">
      <div class="stack">
        ${p.summary ? html`<section class="card"><h3 class="card-title">Summary</h3><p>${p.summary}</p></section>` : ''}
        <section class="card">
          <h3 class="card-title">Experience</h3>
          ${(p.experience || []).length ? html`<ol class="timeline">${p.experience.map((job) => html`
            <li>
              <div class="timeline-head"><strong>${job.title}</strong><span class="muted">${job.company}</span><span class="muted small">${[job.start, job.end].filter(Boolean).join(' – ')}</span></div>
              ${(job.highlights || []).length ? html`<ul class="bullets">${job.highlights.map((item) => html`<li>${item}</li>`)}</ul>` : ''}
            </li>`)}</ol>` : html`<p class="muted small">No work history yet — talk to Jack or import your résumé.</p>`}
        </section>
        ${(p.achievements || []).length ? html`<section class="card"><h3 class="card-title">Achievements</h3><ul class="bullets">${p.achievements.map((item) => html`<li>${item}</li>`)}</ul></section>` : ''}
      </div>
      <div class="stack">
        <section class="card"><h3 class="card-title">Skills</h3><div class="chips">${chips(p.skills)}</div></section>
        <section class="card">
          <h3 class="card-title">Looking for</h3>
          ${preferenceRow('Roles', (p.targetRoles || []).join(', '))}
          ${preferenceRow('Cities', (p.preferredCities || []).join(', '))}
          ${preferenceRow('Work mode', p.workMode)}
          ${preferenceRow('Expected CTC', p.salaryExpectation ? `₹${p.salaryExpectation} LPA` : '')}
          ${preferenceRow('Current CTC', p.salaryCurrent ? `₹${p.salaryCurrent} LPA` : '')}
          ${p.careerGoals ? html`<p class="small muted top-gap">${p.careerGoals}</p>` : ''}
        </section>
        ${(p.education || []).length ? html`<section class="card"><h3 class="card-title">Education</h3>${p.education.map((item) => html`<div class="kv"><span>${item.degree || ''}</span><strong>${[item.school, item.year].filter(Boolean).join(' · ')}</strong></div>`)}</section>` : ''}
        ${(p.interviewInsights || []).length ? html`<section class="card card-soft"><h3 class="card-title">${icon('sparkle')} Jack's notes</h3><ul class="bullets small">${p.interviewInsights.map((item) => html`<li>${item}</li>`)}</ul></section>` : ''}
      </div>
    </div>`;
}

async function renderProfile(el) {
  const data = await api('/api/me/profile');
  state.cache.profile = data;
  render(el, data.profile?.name ? profileView(data) : onboarding());
}

async function importProfile(body) {
  const progress = openModal({ title: 'Building your profile', body: html`<div class="working">${icon('sparkle', 28)}<p>Jack is reading it and structuring your experience…</p></div>` });
  try {
    const data = await api('/api/me/profile/import', { method: 'POST', body });
    closeModal();
    toast(`Profile imported · ${data.completeness.percent}% complete`, 'success');
    location.hash = '#/jack/profile';
    rerender();
  } catch (error) {
    if (progress) closeModal();
    throw error;
  }
}

on('jack-import-file', async (element) => {
  const [file] = filesFrom(element);
  if (!file) return;
  await importProfile({ file: await readFile(file) });
});

on('jack-import-text', async (form) => {
  const { text, linkedinUrl } = formData(form);
  if (!text.trim()) {
    toast(linkedinUrl ? 'LinkedIn blocks automated reading of profiles — paste the text or upload the "Save to PDF" export.' : 'Paste some profile text first.', 'error');
    return;
  }
  await importProfile({ text, linkedinUrl });
});

on('jack-reimport', () => {
  openModal({
    title: 'Import more',
    subtitle: 'New details are merged into your existing profile.',
    body: html`<div class="stack">
      ${dropZone({ action: 'jack-import-file', label: 'Drop a résumé or LinkedIn PDF', hint: 'PDF, image or text · max 10 MB' })}
      <form data-action="jack-import-text" class="stack-sm">
        <textarea name="text" rows="5" placeholder="…or paste text"></textarea>
        <input name="linkedinUrl" placeholder="LinkedIn URL (optional)">
        <button class="btn btn-primary" type="submit">Import</button>
      </form>
    </div>`
  });
});

on('jack-discoverable', async (input) => {
  await api('/api/me/discoverable', { method: 'POST', body: { discoverable: input.checked } });
  toast(input.checked ? 'Hiring teams can now find you and request intros' : 'Your profile is private', 'success');
  rerender();
});

on('jack-edit', () => {
  const p = state.cache.profile?.profile || {};
  const field = (name, label, value, type = 'text') => html`<label class="field"><span>${label}</span><input name="${name}" type="${type}" value="${value ?? ''}"></label>`;
  const area = (name, label, value, rows = 3) => html`<label class="field field-wide"><span>${label}</span><textarea name="${name}" rows="${rows}">${value ?? ''}</textarea></label>`;
  openModal({
    title: 'Edit profile',
    wide: true,
    body: html`<form data-action="jack-save" class="form-grid">
      ${field('name', 'Name', p.name)}
      ${field('headline', 'Headline', p.headline)}
      ${field('currentTitle', 'Current title', p.currentTitle)}
      ${field('currentCompany', 'Current company', p.currentCompany)}
      ${field('city', 'City', p.city)}
      ${field('experienceYears', 'Years of experience', p.experienceYears, 'number')}
      ${field('phone', 'Phone', p.phone)}
      ${field('linkedinUrl', 'LinkedIn URL', p.linkedinUrl)}
      ${area('summary', 'Summary', p.summary)}
      ${area('skills', 'Skills (comma separated)', (p.skills || []).join(', '), 2)}
      ${area('achievements', 'Achievements (one per line)', (p.achievements || []).join('\n'))}
      ${field('targetRoles', 'Target roles', (p.targetRoles || []).join(', '))}
      ${field('preferredCities', 'Preferred cities', (p.preferredCities || []).join(', '))}
      <label class="field"><span>Work mode</span><select name="workMode">${['', 'Remote', 'Hybrid', 'Onsite'].map((mode) => html`<option ${mode === p.workMode ? raw('selected') : ''}>${mode}</option>`)}</select></label>
      ${field('noticePeriod', 'Notice period', p.noticePeriod)}
      ${field('salaryCurrent', 'Current CTC (LPA)', p.salaryCurrent, 'number')}
      ${field('salaryExpectation', 'Expected CTC (LPA)', p.salaryExpectation, 'number')}
      ${area('careerGoals', 'Career goals', p.careerGoals, 2)}
      <div class="form-actions field-wide"><button class="btn btn-primary" type="submit">Save</button></div>
    </form>`
  });
});

on('jack-save', async (form) => {
  await api('/api/me/profile', { method: 'PATCH', body: formData(form) });
  closeModal();
  toast('Profile saved', 'success');
  rerender();
});

// ---------- opportunities ----------

function opportunityCard(item) {
  const role = item.role;
  return html`<article class="card opp">
    <div class="opp-score">${scoreRing(item.score, 52)}</div>
    <div class="grow">
      <div class="opp-head">
        <div>
          <h3><a href="#" data-action="jack-view-role" data-role-id="${role.id}">${role.title}</a></h3>
          <p class="muted small">${[role.companyName, role.companyIndustry, role.companyStage].filter(Boolean).join(' · ')}</p>
        </div>
        ${item.status ? html`<span class="pill pill-accent">${item.status}</span>` : ''}
      </div>
      <div class="meta-row">${[role.city, role.workMode, lpa(role.salaryMin, role.salaryMax), role.seniority].filter(Boolean).map((part) => html`<span>${part}</span>`)}</div>
      <div class="chips top-gap">${chips(item.reasons, 'chip-good')}${chips(item.gaps, 'chip-warn')}</div>
      <div class="row-sm top-gap">
        ${item.status ? '' : html`<button class="btn btn-primary btn-sm" data-action="jack-respond" data-role-id="${role.id}" data-response="interested">${icon('check')} I'm interested</button>`}
        ${item.screeningDone ? '' : html`<button class="btn btn-sm" data-action="voice" data-mode="jack-screening" data-role-id="${role.id}">${icon('mic')} Voice screening</button>`}
        <button class="btn btn-ghost btn-sm" data-action="jack-prep" data-role-id="${role.id}">${icon('sparkle')} Prep me</button>
        ${item.status ? '' : html`<button class="btn btn-ghost btn-sm" data-action="jack-respond" data-role-id="${role.id}" data-response="passed">Pass</button>`}
      </div>
    </div>
  </article>`;
}

async function renderOpportunities(el) {
  render(el, html`<div class="page-intro"><h1>Opportunities</h1><p class="muted">Ranked for you on skills, level, pay, location and how your experience reads against the role.</p></div>${skeleton(3)}`);
  let items;
  try {
    items = await api('/api/me/opportunities');
  } catch (error) {
    if (error.status === 404) {
      render(el, emptyState({ title: 'Build your profile first', text: 'Jack needs to know you before matching you.', action: html`<a class="btn btn-primary" href="#/jack/profile">Go to profile</a>` }));
      return;
    }
    throw error;
  }
  render(el, html`<div class="page-intro"><h1>Opportunities</h1><p class="muted">Ranked for you on skills, level, pay, location and how your experience reads against the role.</p></div>
    ${items.length ? html`<div class="stack">${items.map(opportunityCard)}</div>` : emptyState({ title: 'No open roles yet', text: 'Jack will surface roles here as companies post them.' })}`);
}

on('jack-respond', async (element) => {
  const { roleId, response } = element.dataset;
  await api(`/api/me/opportunities/${roleId}/respond`, { method: 'POST', body: { response } });
  toast(response === 'interested' ? 'Applied — the hiring team can now see your profile' : 'Passed. Jack will learn from this.', 'success');
  rerender();
});

on('jack-view-role', async (element) => {
  const role = await api(`/api/roles/${element.dataset.roleId}/public`);
  openModal({
    title: role.title,
    subtitle: [role.companyName, role.city, role.workMode, lpa(role.salaryMin, role.salaryMax)].filter(Boolean).join(' · '),
    wide: true,
    body: html`${md(role.jd || role.summary)}<div class="row-sm top-gap">
      <button class="btn btn-primary" data-action="jack-respond" data-role-id="${role.id}" data-response="interested">I'm interested</button>
      <button class="btn" data-action="voice" data-mode="jack-screening" data-role-id="${role.id}">${icon('mic')} Voice screening</button>
    </div>`
  });
});

export function showPrep(prep, title = 'Interview prep') {
  const body = html`<div class="stack">
    ${prep.pitch ? html`<section class="callout"><h4>How to pitch yourself</h4><p>${prep.pitch}</p></section>` : ''}
    ${(prep.likelyQuestions || []).length ? html`<section><h4>Likely questions</h4><ol class="qa">${prep.likelyQuestions.map((item) => html`<li><strong>${item.question}</strong><p class="muted small">${item.tip}</p></li>`)}</ol></section>` : ''}
    ${(prep.storiesToPrepare || []).length ? html`<section><h4>Stories to have ready</h4><ul class="bullets">${prep.storiesToPrepare.map((item) => html`<li>${item}</li>`)}</ul></section>` : ''}
    ${(prep.gapsToAddress || []).length ? html`<section><h4>Gaps to address head-on</h4><ul class="bullets">${prep.gapsToAddress.map((item) => html`<li>${item}</li>`)}</ul></section>` : ''}
    ${(prep.questionsToAsk || []).length ? html`<section><h4>Ask them</h4><ul class="bullets">${prep.questionsToAsk.map((item) => html`<li>${item}</li>`)}</ul></section>` : ''}
    ${prep.salaryNote ? html`<section class="callout callout-soft"><h4>On salary</h4><p>${prep.salaryNote}</p></section>` : ''}
  </div>`;
  if (document.querySelector('#modalRoot .modal')) setModalBody(body);
  else openModal({ title, wide: true, body });
}

on('jack-prep', async (element) => {
  openModal({ title: 'Interview prep', wide: true, body: html`<div class="working">${icon('sparkle', 28)}<p>Jack is preparing a brief tailored to you…</p></div>` });
  try {
    showPrep(await api(`/api/me/prep/${element.dataset.roleId}`, { method: 'POST', body: {} }));
  } catch (error) {
    closeModal();
    throw error;
  }
});

// ---------- applications & intros ----------

async function renderApplications(el) {
  const { applications, introductions } = await api('/api/me/applications');
  const pending = introductions.filter((intro) => intro.status === 'pending');
  render(el, html`
    <div class="page-intro"><h1>Applications</h1><p class="muted">Introductions from companies and where each application stands.</p></div>
    ${pending.length ? html`<section class="stack">
      <h2 class="section-title">Introduction requests</h2>
      ${pending.map((intro) => html`<article class="card intro">
        <div class="grow">
          <h3>${intro.roleTitle} · ${intro.companyName}</h3>
          <div class="meta-row">${[intro.city, intro.workMode, lpa(intro.salaryMin, intro.salaryMax)].filter(Boolean).map((part) => html`<span>${part}</span>`)}<span>${relativeDate(intro.createdAt)}</span></div>
          ${intro.message ? html`<blockquote>${intro.message}${intro.requestedBy ? html` <span class="muted">— ${intro.requestedBy}</span>` : ''}</blockquote>` : ''}
        </div>
        <div class="row-sm">
          <button class="btn btn-ghost btn-sm" data-action="jack-view-role" data-role-id="${intro.roleId}">View role</button>
          <button class="btn btn-sm" data-action="jack-intro" data-id="${intro.id}" data-response="declined">Decline</button>
          <button class="btn btn-primary btn-sm" data-action="jack-intro" data-id="${intro.id}" data-response="accepted">Accept & share contact</button>
        </div>
      </article>`)}
    </section>` : ''}
    <section class="stack top-gap">
      <h2 class="section-title">Your applications</h2>
      ${applications.length ? html`<div class="card list">${applications.map((app) => html`<div class="list-row">
        <div class="grow"><strong>${app.roleTitle}</strong><div class="muted small">${app.companyName}${app.city ? ` · ${app.city}` : ''} · updated ${relativeDate(app.updatedAt)}</div>
          ${app.interviews.map((interview) => html`<div class="small accent-text">${icon('calendar', 14)} ${dateTime(interview.startsAt)} · ${interview.mode}</div>`)}
        </div>
        ${app.screeningDone || !['applied', 'contacted', 'screening'].includes(app.stage) ? '' : html`<button class="btn btn-sm" data-action="voice" data-mode="jack-screening" data-role-id="${app.roleId}">${icon('mic')} Screening</button>`}
        <span class="pill stage-${app.stage}">${app.status}</span>
      </div>`)}</div>` : emptyState({ title: 'Nothing yet', text: 'Say you\'re interested in a role and it shows up here.', action: html`<a class="btn btn-primary" href="#/jack/opportunities">See opportunities</a>` })}
    </section>`);
}

on('jack-intro', async (element) => {
  await api(`/api/me/intros/${element.dataset.id}/respond`, { method: 'POST', body: { response: element.dataset.response } });
  toast(element.dataset.response === 'accepted' ? 'Accepted — the team will reach out' : 'Declined', 'success');
  rerender();
});

// ---------- router entry ----------

export const JACK_NAV = [
  { view: 'profile', label: 'Profile', icon: 'user' },
  { view: 'opportunities', label: 'Opportunities', icon: 'briefcase' },
  { view: 'applications', label: 'Applications', icon: 'inbox' }
];

export async function renderJack(view, el) {
  if (view === 'opportunities') return renderOpportunities(el);
  if (view === 'applications') return renderApplications(el);
  return renderProfile(el);
}
