import { html, raw, render, api, state, on, toast, openModal, closeModal, setModalBody, md, initials, lpa, relativeDate, dateTime, scoreRing, chips, emptyState, skeleton, readFile, dropZone, filesFrom, formData, copyText, icon } from './core.js';

const rerender = () => state.rerender?.();
const STAGES = ['sourced', 'applied', 'contacted', 'screening', 'interview', 'offer', 'hired'];
const STAGE_LABEL = { sourced: 'Sourced', applied: 'Applied', contacted: 'Contacted', screening: 'Screening', interview: 'Interview', offer: 'Offer', hired: 'Hired', rejected: 'Rejected', withdrawn: 'Withdrawn' };
const working = (text) => html`<div class="working">${icon('sparkle', 28)}<p>${text}</p></div>`;

// ---------- new role ----------

function newRoleBody(tab = 'speak') {
  const tabs = [['speak', 'Speak it'], ['brief', 'Quick brief'], ['jd', 'Paste or upload JD']];
  return html`
    <div class="seg">${tabs.map(([key, label]) => html`<button class="${key === tab ? 'active' : ''}" data-action="jill-new-role-tab" data-tab="${key}">${label}</button>`)}</div>
    ${tab === 'speak' ? html`<div class="center-block">
      <p class="muted">Describe the role like you would to a recruiter friend. Jill asks only what's missing, writes the JD and saves it when you say yes.</p>
      <button class="btn btn-primary btn-lg" data-action="voice" data-mode="jill">${icon('mic')} Talk to Jill</button>
    </div>` : ''}
    ${tab === 'brief' ? html`<form data-action="jill-generate-role" class="form-grid">
      <label class="field"><span>Role title *</span><input name="title" required placeholder="Senior Backend Engineer"></label>
      <label class="field"><span>Seniority / experience</span><input name="experience" placeholder="Senior, 5–8 years"></label>
      <label class="field"><span>City</span><input name="city" placeholder="Bengaluru"></label>
      <label class="field"><span>Work mode</span><select name="workMode"><option>Hybrid</option><option>Remote</option><option>Onsite</option></select></label>
      <label class="field"><span>Salary band</span><input name="salary" placeholder="40–60 LPA"></label>
      <label class="field"><span>Must-have skills</span><input name="mustHaveSkills" placeholder="Go, PostgreSQL, Kafka"></label>
      <label class="field field-wide"><span>Anything else — team, why it's open, what they'll own</span><textarea name="notes" rows="3"></textarea></label>
      <div class="form-actions field-wide"><button class="btn btn-primary" type="submit">${icon('sparkle')} Write JD & create role</button></div>
    </form>` : ''}
    ${tab === 'jd' ? html`<div class="stack">
      ${dropZone({ action: 'jill-ingest-file', label: 'Drop a JD (PDF, image or text)', hint: 'Jill extracts skills, level, band and responsibilities' })}
      <form data-action="jill-ingest-text" class="stack-sm">
        <textarea name="text" rows="7" placeholder="…or paste the job description"></textarea>
        <button class="btn btn-primary" type="submit">Import JD</button>
      </form>
    </div>` : ''}`;
}

on('jill-new-role', () => openModal({ title: 'New role', subtitle: 'Three ways in — all end with a structured role and a polished JD.', wide: true, body: newRoleBody() }));
on('jill-new-role-tab', (element) => setModalBody(newRoleBody(element.dataset.tab)));

async function createRole(url, body, message) {
  setModalBody(working(message));
  try {
    const role = await api(url, { method: 'POST', body });
    closeModal();
    toast(`${role.title} created`, 'success');
    location.hash = `#/jill/role/${role.id}/jd`;
  } catch (error) {
    closeModal();
    throw error;
  }
}

on('jill-generate-role', (form) => createRole('/api/hr/roles/generate', formData(form), 'Jill is writing the job description…'));
on('jill-ingest-text', (form) => {
  const { text } = formData(form);
  if (!text.trim()) throw new Error('Paste a job description first.');
  return createRole('/api/hr/roles/ingest', { text }, 'Reading the JD and structuring the role…');
});
on('jill-ingest-file', async (element) => {
  const [file] = filesFrom(element);
  if (file) await createRole('/api/hr/roles/ingest', { file: await readFile(file) }, 'Reading the JD and structuring the role…');
});

// ---------- company ----------

on('jill-company', () => {
  const company = state.cache.summary?.company || {};
  openModal({
    title: company.id ? 'Company profile' : 'Set up your company',
    subtitle: 'Used in JDs, outreach and offers.',
    body: html`<form data-action="jill-save-company" class="form-grid">
      <input type="hidden" name="id" value="${company.id || ''}">
      <label class="field"><span>Name *</span><input name="name" required value="${company.name || ''}"></label>
      <label class="field"><span>Industry</span><input name="industry" value="${company.industry || ''}" placeholder="Fintech"></label>
      <label class="field"><span>Stage</span><input name="stage" value="${company.stage || ''}" placeholder="Series A"></label>
      <label class="field"><span>HQ city</span><input name="city" value="${company.city || ''}"></label>
      <label class="field field-wide"><span>Website</span><input name="website" value="${company.website || ''}"></label>
      <label class="field field-wide"><span>About</span><textarea name="about" rows="3">${company.about || ''}</textarea></label>
      <div class="form-actions field-wide"><button class="btn btn-primary" type="submit">Save</button></div>
    </form>`
  });
});

on('jill-save-company', async (form) => {
  const body = formData(form);
  if (!body.id) delete body.id;
  await api('/api/hr/companies', { method: 'POST', body });
  closeModal();
  toast('Company saved', 'success');
  rerender();
});

// ---------- overview ----------

async function renderOverview(el) {
  const summary = await api('/api/hr/summary');
  state.cache.summary = summary;
  if (!summary.roles.length) {
    render(el, html`
      <section class="hero-block">
        <p class="eyebrow">Jill · your AI hiring partner</p>
        <h1 class="display">Hire your next great person<br><span class="accent-text">in a few sentences.</span></h1>
        <p class="lead muted">Speak or paste the role. Jill writes the JD, ranks talent, drafts outreach, books interviews and keeps the pipeline moving.</p>
      </section>
      <section class="option-grid">
        <article class="option-card option-primary"><span class="option-icon">${icon('mic', 22)}</span><h3>Speak the role</h3><p class="muted">Two minutes of talking becomes a full JD.</p><button class="btn btn-primary" data-action="voice" data-mode="jill">${icon('mic')} Talk to Jill</button></article>
        <article class="option-card"><span class="option-icon">${icon('file', 22)}</span><h3>Bring an existing JD</h3><p class="muted">Paste or upload — Jill structures it for matching.</p><button class="btn" data-action="jill-new-role">Import JD</button></article>
        <article class="option-card"><span class="option-icon">${icon('briefcase', 22)}</span><h3>${summary.company ? summary.company.name : 'Company profile'}</h3><p class="muted">${summary.company ? 'Edit how Jill describes you.' : 'Add your company once; Jill reuses it everywhere.'}</p><button class="btn" data-action="jill-company">${summary.company ? 'Edit' : 'Set up'}</button></article>
      </section>`);
    return;
  }
  const max = Math.max(1, ...summary.funnel.map((item) => item.count));
  render(el, html`
    <div class="page-intro row-between">
      <div><h1>${summary.company?.name || 'Hiring'} overview</h1><p class="muted">Everything moving across your roles.</p></div>
      <div class="row-sm"><button class="btn btn-ghost" data-action="jill-company">${icon('edit')} Company</button><button class="btn btn-primary" data-action="jill-new-role">${icon('plus')} New role</button></div>
    </div>
    <section class="kpis">
      ${[['Open roles', summary.openRoles], ['In pipeline', summary.inPipeline], ['Interviews this week', summary.upcomingInterviews.length], ['Offers out', summary.offers], ['Hired', summary.hired]].map(([label, value]) => html`<div class="kpi"><span class="muted small">${label}</span><strong>${value}</strong></div>`)}
    </section>
    <div class="split">
      <div class="stack">
        <section class="card">
          <h3 class="card-title">Roles</h3>
          <div class="list">${summary.roles.map((role) => html`<a class="list-row link-row" href="#/jill/role/${role.id}/pipeline">
            <div class="grow"><strong>${role.title}</strong><div class="muted small">${[role.city, role.status].filter(Boolean).join(' · ')}</div></div>
            <div class="mini-funnel" title="Pipeline by stage">${STAGES.map((stage) => html`<span style="--n:${role.counts[stage] || 0}" title="${STAGE_LABEL[stage]}: ${role.counts[stage] || 0}"></span>`)}</div>
            <span class="pill">${role.inPipeline} active</span>
          </a>`)}</div>
        </section>
        <section class="card">
          <h3 class="card-title">Funnel</h3>
          <div class="funnel">${summary.funnel.map((item) => html`<div class="funnel-row"><span>${STAGE_LABEL[item.stage]}</span><div class="bar"><i style="width:${(item.count / max) * 100}%"></i></div><strong>${item.count}</strong></div>`)}</div>
        </section>
      </div>
      <div class="stack">
        <section class="card">
          <h3 class="card-title">Needs your attention</h3>
          ${summary.needsAttention.length ? html`<div class="list">${summary.needsAttention.map((entry) => html`<button class="list-row link-row" data-action="jill-candidate" data-candidate-id="${entry.candidateId}" data-role-id="${entry.roleId}">
            <div class="avatar">${initials(entry.candidate?.name)}</div>
            <div class="grow"><strong>${entry.candidate?.name}</strong><div class="muted small">${entry.stage === 'applied' ? 'Applied to' : 'Screening done for'} ${entry.roleTitle}</div></div>
            ${icon('arrow')}
          </button>`)}</div>` : html`<p class="muted small">All caught up.</p>`}
        </section>
        <section class="card">
          <h3 class="card-title">Upcoming interviews</h3>
          ${summary.upcomingInterviews.length ? html`<div class="list">${summary.upcomingInterviews.map((item) => html`<div class="list-row"><div class="grow"><strong>${item.candidateName}</strong><div class="muted small">${item.roleTitle}</div></div><span class="small">${dateTime(item.startsAt)}</span></div>`)}</div>` : html`<p class="muted small">Nothing scheduled this week.</p>`}
        </section>
      </div>
    </div>`);
}

// ---------- roles ----------

async function renderRoles(el) {
  const roles = await api('/api/hr/roles');
  render(el, html`
    <div class="page-intro row-between"><div><h1>Roles</h1><p class="muted">${roles.length} role${roles.length === 1 ? '' : 's'}</p></div><button class="btn btn-primary" data-action="jill-new-role">${icon('plus')} New role</button></div>
    ${roles.length ? html`<div class="role-grid">${roles.map((role) => html`<a class="card role-card" href="#/jill/role/${role.id}/sourcing">
      <div class="row-between"><span class="pill ${role.status === 'Open' ? 'pill-accent' : ''}">${role.status}</span><span class="muted small">${relativeDate(role.createdAt)}</span></div>
      <h3>${role.title}</h3>
      <p class="muted small">${[role.companyName, role.city, role.workMode, lpa(role.salaryMin, role.salaryMax)].filter(Boolean).join(' · ')}</p>
      <div class="chips">${chips((role.mustHaveSkills || []).slice(0, 5))}</div>
      <div class="role-stats">${['applied', 'screening', 'interview', 'offer'].map((stage) => html`<div><strong>${role.counts[stage] || 0}</strong><span>${STAGE_LABEL[stage]}</span></div>`)}</div>
    </a>`)}</div>` : emptyState({ title: 'No roles yet', text: 'Speak, paste or brief your first role.', action: html`<button class="btn btn-primary" data-action="jill-new-role">New role</button>` })}`);
}

// ---------- role workspace ----------

const ROLE_TABS = [['jd', 'Job description'], ['sourcing', 'Sourcing'], ['pipeline', 'Pipeline'], ['kit', 'Interview kit']];

async function renderRole(el, roleId, tab = 'sourcing') {
  const role = await api(`/api/hr/roles/${roleId}`);
  state.cache.role = role;
  render(el, html`
    <a class="back-link" href="#/jill/roles">${icon('back', 16)} Roles</a>
    <header class="role-head">
      <div class="grow">
        <h1>${role.title}</h1>
        <div class="meta-row">${[role.companyName, role.city, role.workMode, role.seniority, lpa(role.salaryMin, role.salaryMax), role.experienceMin !== undefined ? `${role.experienceMin}${role.experienceMax ? `–${role.experienceMax}` : '+'} yrs` : ''].filter(Boolean).map((part) => html`<span>${part}</span>`)}</div>
      </div>
      <div class="row-sm">
        <select class="select-sm" data-change="jill-role-status" data-role-id="${role.id}">${['Open', 'Paused', 'Closed'].map((status) => html`<option ${status === role.status ? raw('selected') : ''}>${status}</option>`)}</select>
        <button class="btn" data-action="voice" data-mode="jill" data-role-id="${role.id}">${icon('mic')} Ask Jill</button>
      </div>
    </header>
    <nav class="tabs">${ROLE_TABS.map(([key, label]) => html`<a href="#/jill/role/${role.id}/${key}" class="${key === tab ? 'active' : ''}">${label}${key === 'pipeline' && role.inPipeline ? html`<span class="count">${role.inPipeline}</span>` : ''}</a>`)}</nav>
    <div id="roleTab"></div>`);
  const target = el.querySelector('#roleTab');
  if (tab === 'jd') return renderJD(target, role);
  if (tab === 'pipeline') return renderPipeline(target, role);
  if (tab === 'kit') return renderKit(target, role);
  return renderSourcing(target, role);
}

on('jill-role-status', async (select) => {
  await api(`/api/hr/roles/${select.dataset.roleId}`, { method: 'PATCH', body: { status: select.value } });
  toast(`Role ${select.value.toLowerCase()}`, 'success');
});

function renderJD(el, role) {
  render(el, html`<div class="split">
    <section class="card">
      <div class="row-between"><h3 class="card-title">Job description</h3><div class="row-sm">
        <button class="btn btn-ghost btn-sm" data-action="jill-copy-jd">${icon('copy')} Copy</button>
        <button class="btn btn-ghost btn-sm" data-action="jill-edit-jd">${icon('edit')} Edit</button>
      </div></div>
      ${md(role.jd || role.summary || '')}
    </section>
    <div class="stack">
      <section class="card">
        <div class="row-between"><h3 class="card-title">Matching criteria</h3><button class="btn btn-ghost btn-sm" data-action="jill-edit-role">${icon('edit')} Edit</button></div>
        <p class="small muted">Must have</p><div class="chips">${chips(role.mustHaveSkills, 'chip-strong')}</div>
        ${(role.niceToHaveSkills || []).length ? html`<p class="small muted top-gap">Nice to have</p><div class="chips">${chips(role.niceToHaveSkills)}</div>` : ''}
      </section>
      ${(role.responsibilities || []).length ? html`<section class="card"><h3 class="card-title">They will</h3><ul class="bullets small">${role.responsibilities.map((item) => html`<li>${item}</li>`)}</ul></section>` : ''}
      <a class="btn btn-primary" href="#/jill/role/${role.id}/sourcing">${icon('search')} Find candidates</a>
    </div>
  </div>`);
}

on('jill-copy-jd', () => copyText(state.cache.role?.jd || ''));

on('jill-edit-jd', () => {
  openModal({
    title: 'Edit job description',
    wide: true,
    body: html`<form data-action="jill-save-role" class="stack-sm"><textarea name="jd" rows="20" class="mono">${state.cache.role?.jd || ''}</textarea><div class="form-actions"><button class="btn btn-primary" type="submit">Save</button></div></form>`
  });
});

on('jill-edit-role', () => {
  const role = state.cache.role || {};
  const field = (name, label, value, type = 'text') => html`<label class="field"><span>${label}</span><input name="${name}" type="${type}" value="${value ?? ''}"></label>`;
  openModal({
    title: 'Matching criteria',
    wide: true,
    body: html`<form data-action="jill-save-role" class="form-grid">
      ${field('title', 'Title', role.title)}
      ${field('seniority', 'Seniority', role.seniority)}
      ${field('city', 'City', role.city)}
      <label class="field"><span>Work mode</span><select name="workMode">${['Remote', 'Hybrid', 'Onsite'].map((mode) => html`<option ${mode === role.workMode ? raw('selected') : ''}>${mode}</option>`)}</select></label>
      ${field('experienceMin', 'Min years', role.experienceMin, 'number')}
      ${field('experienceMax', 'Max years', role.experienceMax, 'number')}
      ${field('salaryMin', 'Salary min (LPA)', role.salaryMin, 'number')}
      ${field('salaryMax', 'Salary max (LPA)', role.salaryMax, 'number')}
      <label class="field field-wide"><span>Must-have skills</span><input name="mustHaveSkills" value="${(role.mustHaveSkills || []).join(', ')}"></label>
      <label class="field field-wide"><span>Nice-to-have skills</span><input name="niceToHaveSkills" value="${(role.niceToHaveSkills || []).join(', ')}"></label>
      <div class="form-actions field-wide"><button class="btn btn-primary" type="submit">Save</button></div>
    </form>`
  });
});

on('jill-save-role', async (form) => {
  await api(`/api/hr/roles/${state.cache.role.id}`, { method: 'PATCH', body: formData(form) });
  delete state.sourcing[state.cache.role.id];
  closeModal();
  toast('Role updated', 'success');
  rerender();
});

// ---------- sourcing ----------

function sourcingRow(item, index, role) {
  const c = item.candidate;
  return html`<article class="card source-row">
    <span class="rank">${index + 1}</span>
    ${scoreRing(item.score, 48)}
    <div class="grow">
      <div class="row-between">
        <button class="link-btn" data-action="jill-candidate" data-candidate-id="${c.id}" data-role-id="${role.id}"><strong>${c.name}</strong></button>
        <div class="row-sm">${c.hasAccount ? html`<span class="pill pill-soft" title="Signed up on Jack & Jill">On platform</span>` : html`<span class="pill pill-soft">Imported</span>`}${item.stage ? html`<span class="pill stage-${item.stage}">${STAGE_LABEL[item.stage]}</span>` : ''}</div>
      </div>
      <div class="muted small">${[c.currentTitle, c.currentCompany, c.city, Number.isFinite(c.experienceYears) ? `${c.experienceYears} yrs` : '', c.salaryExpectation ? `exp. ₹${c.salaryExpectation}L` : '', c.noticePeriod].filter(Boolean).join(' · ')}</div>
      ${item.aiSummary ? html`<p class="ai-note">${icon('sparkle', 14)} ${item.aiSummary}</p>` : ''}
      <div class="chips top-gap">${chips(item.reasons, 'chip-good')}${chips(item.gaps, 'chip-warn')}</div>
      <div class="row-sm top-gap">
        ${item.stage ? '' : html`<button class="btn btn-sm btn-primary" data-action="jill-move" data-candidate-id="${c.id}" data-role-id="${role.id}" data-stage="sourced">${icon('plus')} Pipeline</button>`}
        ${c.hasAccount && !c.contactShared && !item.intro ? html`<button class="btn btn-sm" data-action="jill-intro" data-candidate-id="${c.id}" data-role-id="${role.id}" data-name="${c.name}">${icon('link')} Request intro</button>` : ''}
        ${item.intro ? html`<span class="pill">Intro ${item.intro}</span>` : ''}
        <button class="btn btn-sm btn-ghost" data-action="jill-outreach" data-candidate-id="${c.id}" data-role-id="${role.id}">${icon('mail')} Outreach</button>
      </div>
    </div>
  </article>`;
}

function sourcingPlanCard(plan, role) {
  if (!plan) {
    return html`<section class="card card-soft"><h3 class="card-title">${icon('search')} Search beyond the pool</h3><p class="muted small">Boolean strings for LinkedIn, Naukri, GitHub and Google X-ray, plus target companies.</p><button class="btn btn-sm" data-action="jill-plan" data-role-id="${role.id}">${icon('sparkle')} Generate</button></section>`;
  }
  const row = (label, value) => value ? html`<div class="bool"><div class="row-between"><span class="small muted">${label}</span><button class="icon-btn" data-action="jill-copy" data-text="${value}" aria-label="Copy ${label}">${icon('copy', 15)}</button></div><code>${value}</code></div>` : '';
  return html`<section class="card">
    <div class="row-between"><h3 class="card-title">Search beyond the pool</h3><button class="btn btn-ghost btn-sm" data-action="jill-plan" data-role-id="${role.id}" data-refresh="1">Regenerate</button></div>
    ${plan.idealProfile ? html`<p class="small">${plan.idealProfile}</p>` : ''}
    ${row('LinkedIn', plan.linkedin)}${row('Naukri Resdex', plan.naukri)}${row('GitHub', plan.github)}${row('Google X-ray', plan.googleXray)}
    ${(plan.targetCompanies || []).length ? html`<p class="small muted top-gap">Target companies</p><div class="chips">${chips(plan.targetCompanies)}</div>` : ''}
    ${(plan.titleVariants || []).length ? html`<p class="small muted top-gap">Title variants</p><div class="chips">${chips(plan.titleVariants)}</div>` : ''}
    ${(plan.channels || []).length ? html`<p class="small muted top-gap">Where to post</p><ul class="bullets small">${plan.channels.map((item) => html`<li>${item}</li>`)}</ul>` : ''}
  </section>`;
}

function sourcingBody(role, data) {
  return html`<div class="split split-wide">
    <div class="stack">
      <div class="toolbar">
        <span class="muted small">${data ? `${data.results.length} ranked from a pool of ${data.poolSize}${data.deep ? ' · AI re-ranked' : ''}` : 'Ranking…'}</span>
        <div class="row-sm">
          <button class="btn btn-sm" data-action="jill-source" data-role-id="${role.id}" data-deep="1">${icon('sparkle')} Deep rank with AI</button>
          <button class="btn btn-sm btn-ghost" data-action="jill-source" data-role-id="${role.id}">Refresh</button>
        </div>
      </div>
      ${!data ? skeleton(4) : data.results.length ? data.results.map((item, index) => sourcingRow(item, index, role)) : emptyState({ title: 'Your pool is empty', text: 'Import résumés on the right, or wait for candidates to opt in on Jack & Jill.' })}
    </div>
    <div class="stack">
      <section class="card">
        <h3 class="card-title">Add candidates</h3>
        ${dropZone({ action: 'jill-import', label: 'Drop résumés', hint: 'Bulk PDFs · parsed and added to this role', multiple: true })}
      </section>
      ${sourcingPlanCard(role.sourcingPlan, role)}
    </div>
  </div>`;
}

async function renderSourcing(el, role, { deep = false, force = false } = {}) {
  const cached = state.sourcing[role.id];
  render(el, sourcingBody(role, force ? null : cached));
  if (cached && !force) return;
  const data = await api(`/api/hr/roles/${role.id}/source`, { method: 'POST', body: { deep } });
  state.sourcing[role.id] = data;
  if (document.body.contains(el)) render(el, sourcingBody(role, data));
}

on('jill-source', async (element) => {
  const target = document.getElementById('roleTab');
  await renderSourcing(target, state.cache.role, { deep: Boolean(element.dataset.deep), force: true });
});

on('jill-plan', async (element) => {
  element.textContent = 'Generating…';
  const plan = await api(`/api/hr/roles/${element.dataset.roleId}/sourcing-plan`, { method: 'POST', body: { refresh: Boolean(element.dataset.refresh) } });
  state.cache.role.sourcingPlan = plan;
  render('#roleTab', sourcingBody(state.cache.role, state.sourcing[state.cache.role.id]));
});

on('jill-copy', (element) => copyText(element.dataset.text));

on('jill-import', async (element) => {
  const files = filesFrom(element);
  if (!files.length) return;
  const roleId = state.route.view === 'role' ? state.cache.role?.id : undefined;
  const loaded = await Promise.all(files.map(readFile));
  openModal({ title: 'Importing candidates', body: working(`Parsing ${loaded.length} résumé${loaded.length === 1 ? '' : 's'}…`) });
  const results = [];
  try {
    for (let index = 0; index < loaded.length; index += 3) {
      const batch = await api('/api/hr/candidates/import', { method: 'POST', body: { files: loaded.slice(index, index + 3), roleId } });
      results.push(...batch.results);
      setModalBody(working(`Parsed ${results.length} of ${loaded.length}…`));
    }
  } finally {
    setModalBody(html`<div class="list">${results.map((item) => html`<div class="list-row"><span class="grow">${item.ok ? item.name : item.label}</span>${item.ok ? html`<span class="pill pill-accent">Added</span>` : html`<span class="pill pill-warn" title="${item.error}">Failed</span>`}</div>`)}</div>
      <div class="form-actions"><button class="btn btn-primary" data-modal-close data-action="jill-import-done">Done</button></div>`);
  }
});

on('jill-import-done', () => {
  closeModal();
  if (state.cache.role) delete state.sourcing[state.cache.role.id];
  rerender();
});

// ---------- pipeline ----------

function pipelineCard(entry) {
  const c = entry.candidate;
  return html`<article class="kcard" draggable="true" data-candidate-id="${entry.candidateId}" data-role-id="${entry.roleId}" data-action="jill-candidate">
    <div class="row-between"><strong>${c.name}</strong>${entry.score !== null ? html`<span class="score-tag">${entry.score}</span>` : ''}</div>
    <div class="muted small">${[c.currentTitle, c.city].filter(Boolean).join(' · ')}</div>
    <div class="row-sm top-gap-sm">
      ${entry.source === 'applied' ? html`<span class="tag">Applied</span>` : ''}
      ${entry.screening ? html`<span class="tag tag-accent">${icon('mic', 12)} Screened</span>` : ''}
      ${entry.nextInterview ? html`<span class="tag">${icon('calendar', 12)} ${dateTime(entry.nextInterview.startsAt)}</span>` : ''}
      ${entry.offer ? html`<span class="tag">Offer drafted</span>` : ''}
    </div>
  </article>`;
}

async function renderPipeline(el, role) {
  const entries = await api(`/api/hr/pipeline?roleId=${encodeURIComponent(role.id)}`);
  const closed = entries.filter((entry) => ['rejected', 'withdrawn'].includes(entry.stage));
  render(el, html`
    <div class="board">${STAGES.map((stage) => {
      const items = entries.filter((entry) => entry.stage === stage);
      return html`<section class="column" data-stage="${stage}">
        <header><span>${STAGE_LABEL[stage]}</span><span class="count">${items.length}</span></header>
        <div class="column-body">${items.map(pipelineCard)}</div>
      </section>`;
    })}</div>
    ${closed.length ? html`<details class="closed"><summary>${closed.length} rejected or withdrawn</summary><div class="list">${closed.map((entry) => html`<button class="list-row link-row" data-action="jill-candidate" data-candidate-id="${entry.candidateId}" data-role-id="${entry.roleId}"><span class="grow">${entry.candidate.name}</span><span class="pill">${STAGE_LABEL[entry.stage]}</span></button>`)}</div></details>` : ''}
    ${entries.length ? '' : emptyState({ title: 'Pipeline is empty', text: 'Add people from Sourcing, or wait for applicants.', action: html`<a class="btn btn-primary" href="#/jill/role/${role.id}/sourcing">Go to sourcing</a>` })}`);

  el.querySelectorAll('.kcard').forEach((card) => {
    card.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', JSON.stringify(card.dataset));
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });
  el.querySelectorAll('.column').forEach((column) => {
    column.addEventListener('dragover', (event) => { event.preventDefault(); column.classList.add('is-over'); });
    column.addEventListener('dragleave', () => column.classList.remove('is-over'));
    column.addEventListener('drop', async (event) => {
      event.preventDefault();
      column.classList.remove('is-over');
      const { candidateId, roleId } = JSON.parse(event.dataTransfer.getData('text/plain') || '{}');
      if (!candidateId) return;
      try {
        await api('/api/hr/pipeline/move', { method: 'POST', body: { candidateId, roleId, stage: column.dataset.stage } });
        renderPipeline(el, role);
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });
}

// ---------- interview kit ----------

async function renderKit(el, role, refresh = false) {
  render(el, role.kit && !refresh ? kitBody(role.kit) : working('Designing a structured interview kit…'));
  if (role.kit && !refresh) return;
  role.kit = await api(`/api/hr/roles/${role.id}/kit`, { method: 'POST', body: { refresh } });
  if (document.body.contains(el)) render(el, kitBody(role.kit));
}

function kitBody(kit) {
  return html`<div class="split">
    <section class="card">
      <div class="row-between"><h3 class="card-title">Screening questions</h3><button class="btn btn-ghost btn-sm" data-action="jill-kit-refresh">Regenerate</button></div>
      <ol class="qa">${(kit.screeningQuestions || []).map((item) => html`<li><strong>${item.question}</strong><p class="muted small">Look for: ${item.lookFor}</p></li>`)}</ol>
    </section>
    <div class="stack">
      <section class="card"><h3 class="card-title">Interview loop</h3>${(kit.interviewPlan || []).map((item, index) => html`<div class="loop-step"><span class="step">${index + 1}</span><div class="grow"><strong>${item.stage}</strong><p class="muted small">${item.focus}</p></div><span class="small muted">${item.durationMins} min</span></div>`)}</section>
      <section class="card"><h3 class="card-title">Scorecard</h3>${(kit.scorecard || []).map((item) => html`<div class="kv kv-stack"><strong>${item.competency}</strong><span class="muted small">${item.description}</span></div>`)}</section>
    </div>
  </div>`;
}

on('jill-kit-refresh', () => renderKit(document.getElementById('roleTab'), state.cache.role, true));

// ---------- candidate drawer & actions ----------

async function openCandidate(candidateId, roleId) {
  openModal({ title: 'Candidate', wide: true, body: skeleton(4) });
  const data = await api(`/api/hr/candidates/${candidateId}${roleId ? `?roleId=${encodeURIComponent(roleId)}` : ''}`);
  const c = data.candidate;
  const app = data.applications.find((item) => item.roleId === roleId);
  const roles = state.cache.roles || (state.cache.roles = await api('/api/hr/roles'));
  document.querySelector('#modalRoot .modal-head h2').textContent = c.name;
  setModalBody(html`
    <div class="drawer">
      <div class="stack">
        <div class="row-sm">
          <div class="avatar avatar-lg">${initials(c.name)}</div>
          <div class="grow"><strong>${c.headline || c.currentTitle}</strong><div class="muted small">${[c.currentCompany, c.city, Number.isFinite(c.experienceYears) ? `${c.experienceYears} yrs` : ''].filter(Boolean).join(' · ')}</div></div>
        </div>
        <div class="contact ${c.contactShared ? '' : 'contact-locked'}">
          ${c.contactShared ? html`${c.email ? html`<a href="mailto:${c.email}">${icon('mail', 15)} ${c.email}</a>` : ''}${c.phone ? html`<span>${c.phone}</span>` : ''}${c.linkedinUrl ? html`<a href="${/^https?:/.test(c.linkedinUrl) ? c.linkedinUrl : `https://${c.linkedinUrl}`}" target="_blank" rel="noopener">${icon('link', 15)} LinkedIn</a>` : ''}` : html`${icon('eye', 15)} Contact details are shared once they accept an intro or apply.`}
        </div>
        ${data.fit ? html`<div class="chips">${chips(data.fit.reasons, 'chip-good')}${chips(data.fit.gaps, 'chip-warn')}</div>` : ''}
        ${c.summary ? html`<p>${c.summary}</p>` : ''}
        ${app?.screening ? html`<section class="callout"><h4>${icon('mic', 15)} Voice screening · ${relativeDate(app.screening.at)}</h4><p>${app.screening.summary}</p>
          ${app.screening.answers.map((item) => html`<details><summary>${item.question}</summary><p class="small">${item.answer}</p></details>`)}
          <div class="chips top-gap">${chips(app.screening.strengths, 'chip-good')}${chips(app.screening.concerns, 'chip-warn')}</div></section>` : ''}
        <div><h4>Skills</h4><div class="chips">${chips(c.skills)}</div></div>
        ${(c.experience || []).length ? html`<div><h4>Experience</h4><ol class="timeline">${c.experience.map((job) => html`<li><div class="timeline-head"><strong>${job.title}</strong><span class="muted">${job.company}</span><span class="muted small">${[job.start, job.end].filter(Boolean).join(' – ')}</span></div>${(job.highlights || []).length ? html`<ul class="bullets small">${job.highlights.map((item) => html`<li>${item}</li>`)}</ul>` : ''}</li>`)}</ol></div>` : ''}
        ${(c.insights || []).length ? html`<div><h4>Jack's notes</h4><ul class="bullets small">${c.insights.map((item) => html`<li>${item}</li>`)}</ul></div>` : ''}
      </div>
      <aside class="stack drawer-side">
        <label class="field"><span>Role</span><select id="drawerRole">${roles.map((role) => html`<option value="${role.id}" ${role.id === roleId ? raw('selected') : ''}>${role.title}</option>`)}</select></label>
        <label class="field"><span>Stage</span><select data-change="jill-drawer-stage" data-candidate-id="${c.id}"><option value="">${app ? STAGE_LABEL[app.stage] : 'Not in pipeline'}</option>${Object.entries(STAGE_LABEL).filter(([key]) => key !== app?.stage).map(([key, label]) => html`<option value="${key}">Move to ${label}</option>`)}</select></label>
        <button class="btn" data-action="jill-schedule" data-candidate-id="${c.id}">${icon('calendar')} Schedule interview</button>
        <button class="btn" data-action="jill-outreach" data-candidate-id="${c.id}">${icon('mail')} Draft outreach</button>
        ${c.hasAccount && !c.contactShared ? html`<button class="btn" data-action="jill-intro" data-candidate-id="${c.id}" data-name="${c.name}">${icon('link')} Request intro</button>` : ''}
        ${app ? html`<button class="btn" data-action="jill-offer" data-candidate-id="${c.id}">${icon('file')} Draft offer</button>` : ''}
        ${app ? html`<form data-action="jill-note" data-candidate-id="${c.id}" class="stack-sm"><textarea name="note" rows="2" placeholder="Add a note…"></textarea><button class="btn btn-sm" type="submit">Add note</button></form>
          <div class="notes">${[...(app.notes || [])].reverse().map((note) => html`<div class="note"><p class="small">${note.text}</p><span class="muted tiny">${note.by || ''} · ${relativeDate(note.at)}</span></div>`)}</div>` : ''}
        ${data.interviews.length ? html`<div><h4>Interviews</h4>${data.interviews.map((item) => html`<div class="kv"><span>${dateTime(item.startsAt)}</span><strong>${item.mode}</strong></div>`)}</div>` : ''}
      </aside>
    </div>`);
}

const drawerRoleId = (element) => element.dataset.roleId || document.getElementById('drawerRole')?.value || state.cache.role?.id;

on('jill-candidate', (element) => openCandidate(element.dataset.candidateId, element.dataset.roleId || state.cache.role?.id));

on('jill-move', async (element) => {
  await api('/api/hr/pipeline/move', { method: 'POST', body: { candidateId: element.dataset.candidateId, roleId: drawerRoleId(element), stage: element.dataset.stage } });
  toast('Added to pipeline', 'success');
  const sourcing = state.sourcing[state.cache.role?.id];
  const row = sourcing?.results.find((item) => item.candidate.id === element.dataset.candidateId);
  if (row) row.stage = element.dataset.stage;
  rerender();
});

on('jill-drawer-stage', async (select) => {
  if (!select.value) return;
  const roleId = drawerRoleId(select);
  await api('/api/hr/pipeline/move', { method: 'POST', body: { candidateId: select.dataset.candidateId, roleId, stage: select.value } });
  toast(`Moved to ${STAGE_LABEL[select.value]}`, 'success');
  if (state.cache.role) delete state.sourcing[state.cache.role.id];
  await openCandidate(select.dataset.candidateId, roleId);
  rerender();
});

on('jill-note', async (form) => {
  const roleId = drawerRoleId(form);
  const { note } = formData(form);
  if (!note.trim()) return;
  await api('/api/hr/pipeline/note', { method: 'POST', body: { candidateId: form.dataset.candidateId, roleId, note } });
  await openCandidate(form.dataset.candidateId, roleId);
});

export function showOutreach(draft) {
  const body = html`<div class="stack">
    <label class="field"><span>Subject</span><input value="${draft.subject}" readonly></label>
    <label class="field"><span>Email</span><textarea rows="9" id="outreachEmail">${draft.email}</textarea></label>
    <div class="row-sm"><button class="btn btn-primary btn-sm" data-action="jill-copy-field" data-target="outreachEmail">${icon('copy')} Copy email</button></div>
    <label class="field"><span>LinkedIn / WhatsApp</span><textarea rows="3" id="outreachShort">${draft.shortMessage}</textarea></label>
    <div class="row-sm"><button class="btn btn-sm" data-action="jill-copy-field" data-target="outreachShort">${icon('copy')} Copy message</button></div>
  </div>`;
  openModal({ title: 'Outreach draft', subtitle: 'Personalised from their background — edit before sending.', wide: true, body });
}

on('jill-copy-field', (element) => copyText(document.getElementById(element.dataset.target).value));

on('jill-outreach', async (element) => {
  const roleId = drawerRoleId(element);
  openModal({ title: 'Outreach draft', wide: true, body: working('Writing a personal note…') });
  try {
    showOutreach(await api('/api/hr/outreach', { method: 'POST', body: { candidateId: element.dataset.candidateId, roleId } }));
  } catch (error) {
    closeModal();
    throw error;
  }
});

on('jill-intro', (element) => {
  const roleId = drawerRoleId(element);
  openModal({
    title: `Request intro to ${element.dataset.name}`,
    subtitle: 'They\'ll see the role and your note, and choose whether to share contact details.',
    body: html`<form data-action="jill-send-intro" data-candidate-id="${element.dataset.candidateId}" data-role-id="${roleId}" class="stack-sm">
      <textarea name="message" rows="4" placeholder="Why you think they'd be great for this role (optional)"></textarea>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Send request</button></div>
    </form>`
  });
});

on('jill-send-intro', async (form) => {
  await api('/api/hr/intros', { method: 'POST', body: { candidateId: form.dataset.candidateId, roleId: form.dataset.roleId, message: formData(form).message } });
  closeModal();
  toast('Intro requested', 'success');
  if (state.cache.role) delete state.sourcing[state.cache.role.id];
  rerender();
});

on('jill-schedule', (element) => {
  const roleId = drawerRoleId(element);
  const tomorrow = new Date(Date.now() + 86400000);
  tomorrow.setHours(11, 0, 0, 0);
  const local = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  openModal({
    title: 'Schedule interview',
    body: html`<form data-action="jill-save-interview" data-candidate-id="${element.dataset.candidateId}" data-role-id="${roleId}" class="form-grid">
      <label class="field"><span>When</span><input type="datetime-local" name="startsAt" value="${local}" required></label>
      <label class="field"><span>Duration (min)</span><input type="number" name="durationMins" value="45"></label>
      <label class="field"><span>Mode</span><select name="mode"><option>Video</option><option>Phone</option><option>Onsite</option></select></label>
      <label class="field"><span>Panel</span><input name="panel" placeholder="Asha, Karthik"></label>
      <label class="field field-wide"><span>Link or address</span><input name="location" placeholder="https://meet.google.com/…"></label>
      <div class="form-actions field-wide"><button class="btn btn-primary" type="submit">Book</button></div>
    </form>`
  });
});

on('jill-save-interview', async (form) => {
  const body = formData(form);
  body.startsAt = new Date(body.startsAt).toISOString();
  const interview = await api('/api/hr/interviews', { method: 'POST', body: { ...body, candidateId: form.dataset.candidateId, roleId: form.dataset.roleId } });
  openModal({
    title: 'Interview booked',
    body: html`<p>${interview.candidateName} · ${interview.roleTitle}<br><strong>${dateTime(interview.startsAt)}</strong></p>
      <div class="row-sm"><a class="btn btn-primary" href="/api/hr/interviews/${interview.id}/ics" download>${icon('download')} Add to calendar</a><button class="btn" data-modal-close data-action="jill-close-refresh">Done</button></div>`
  });
});

on('jill-close-refresh', () => { closeModal(); rerender(); });

export function showOffer(offer) {
  openModal({
    title: 'Offer letter draft',
    subtitle: 'Review with your team before sending. Not legal advice.',
    wide: true,
    body: html`<label class="field"><span>Subject</span><input value="${offer.subject}" readonly></label>
      <textarea id="offerText" rows="18" class="mono top-gap">${offer.letter}</textarea>
      <div class="row-sm top-gap"><button class="btn btn-primary" data-action="jill-copy-field" data-target="offerText">${icon('copy')} Copy</button></div>`
  });
}

on('jill-offer', (element) => {
  const roleId = drawerRoleId(element);
  const role = (state.cache.roles || []).find((item) => item.id === roleId) || state.cache.role || {};
  openModal({
    title: 'Draft offer',
    body: html`<form data-action="jill-make-offer" data-candidate-id="${element.dataset.candidateId}" data-role-id="${roleId}" class="form-grid">
      <label class="field"><span>CTC (LPA)</span><input type="number" step="0.1" name="ctc" value="${role.salaryMax || ''}"></label>
      <label class="field"><span>Joining date</span><input type="date" name="joiningDate"></label>
      <label class="field field-wide"><span>Extras</span><input name="extras" placeholder="Joining bonus, ESOPs, relocation…"></label>
      <div class="form-actions field-wide"><button class="btn btn-primary" type="submit">${icon('sparkle')} Draft</button></div>
    </form>`
  });
});

on('jill-make-offer', async (form) => {
  const body = { ...formData(form), candidateId: form.dataset.candidateId, roleId: form.dataset.roleId };
  setModalBody(working('Drafting the offer letter…'));
  try {
    showOffer(await api('/api/hr/offer', { method: 'POST', body }));
  } catch (error) {
    closeModal();
    throw error;
  }
});

// ---------- talent pool ----------

async function renderTalent(el) {
  const query = state.cache.talentQuery || '';
  const people = await api(`/api/hr/talent?q=${encodeURIComponent(query)}`);
  state.cache.roles = await api('/api/hr/roles');
  render(el, html`
    <div class="page-intro"><h1>Talent pool</h1><p class="muted">People who opted in on Jack & Jill, applied to you, or you imported.</p></div>
    <div class="split split-wide">
      <div class="stack">
        <form data-action="jill-talent-search" class="search"><span>${icon('search')}</span><input name="q" value="${query}" placeholder="Search skills, titles, cities…"></form>
        ${people.length ? html`<div class="card list">${people.map((c) => html`<button class="list-row link-row" data-action="jill-candidate" data-candidate-id="${c.id}" data-role-id="${c.applications[0]?.roleId || ''}">
          <div class="avatar">${initials(c.name)}</div>
          <div class="grow"><strong>${c.name}</strong><div class="muted small">${[c.currentTitle, c.city, Number.isFinite(c.experienceYears) ? `${c.experienceYears} yrs` : ''].filter(Boolean).join(' · ')}</div>
            <div class="chips top-gap-sm">${chips((c.skills || []).slice(0, 5))}</div></div>
          <span class="pill pill-soft">${c.hasAccount ? 'On platform' : 'Imported'}</span>
        </button>`)}</div>` : emptyState({ title: query ? 'No matches' : 'Pool is empty', text: query ? 'Try fewer keywords.' : 'Import résumés to start building your pool.' })}
      </div>
      <section class="card">
        <h3 class="card-title">Bulk import</h3>
        ${dropZone({ action: 'jill-import', label: 'Drop résumés', hint: 'PDFs, images or text · many at once', multiple: true })}
      </section>
    </div>`);
}

on('jill-talent-search', (form) => {
  state.cache.talentQuery = formData(form).q;
  rerender();
});

// ---------- interviews ----------

async function renderInterviews(el) {
  const interviews = await api('/api/hr/interviews');
  const nowIso = new Date().toISOString();
  const upcoming = interviews.filter((item) => item.startsAt >= nowIso);
  const past = interviews.filter((item) => item.startsAt < nowIso).reverse();
  const row = (item, isPast) => html`<div class="list-row">
    <div class="date-chip"><strong>${new Date(item.startsAt).getDate()}</strong><span>${new Date(item.startsAt).toLocaleString('en-IN', { month: 'short' })}</span></div>
    <div class="grow"><button class="link-btn" data-action="jill-candidate" data-candidate-id="${item.candidateId}" data-role-id="${item.roleId}"><strong>${item.candidateName}</strong></button>
      <div class="muted small">${item.roleTitle} · ${dateTime(item.startsAt)} · ${item.durationMins} min · ${item.mode}${item.panel.length ? ` · ${item.panel.join(', ')}` : ''}</div>
      ${(item.feedback || []).map((feedback) => html`<div class="small top-gap-sm"><span class="pill">${(feedback.recommendation || '').replace('_', ' ') || 'note'}</span> ${feedback.notes || ''}</div>`)}
    </div>
    <a class="icon-btn" href="/api/hr/interviews/${item.id}/ics" download title="Add to calendar">${icon('download')}</a>
    ${isPast ? html`<button class="btn btn-sm" data-action="jill-feedback" data-id="${item.id}">Feedback</button>` : ''}
  </div>`;
  render(el, html`
    <div class="page-intro"><h1>Interviews</h1><p class="muted">Book from any candidate card — or just tell Jill.</p></div>
    <h2 class="section-title">Upcoming</h2>
    ${upcoming.length ? html`<div class="card list">${upcoming.map((item) => row(item, false))}</div>` : html`<p class="muted">Nothing scheduled.</p>`}
    ${past.length ? html`<h2 class="section-title top-gap">Past</h2><div class="card list">${past.map((item) => row(item, true))}</div>` : ''}`);
}

on('jill-feedback', (element) => {
  openModal({
    title: 'Interview feedback',
    body: html`<form data-action="jill-save-feedback" data-id="${element.dataset.id}" class="stack-sm">
      <div class="seg seg-radio">${[['strong_yes', 'Strong yes'], ['yes', 'Yes'], ['no', 'No'], ['strong_no', 'Strong no']].map(([value, label]) => html`<label><input type="radio" name="recommendation" value="${value}"><span>${label}</span></label>`)}</div>
      <textarea name="notes" rows="5" placeholder="Evidence against the scorecard…"></textarea>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Save</button></div>
    </form>`
  });
});

on('jill-save-feedback', async (form) => {
  await api(`/api/hr/interviews/${form.dataset.id}/feedback`, { method: 'POST', body: formData(form) });
  closeModal();
  toast('Feedback saved', 'success');
  rerender();
});

// ---------- router entry ----------

export const JILL_NAV = [
  { view: 'overview', label: 'Overview', icon: 'grid' },
  { view: 'roles', label: 'Roles', icon: 'briefcase' },
  { view: 'talent', label: 'Talent pool', icon: 'users' },
  { view: 'interviews', label: 'Interviews', icon: 'calendar' }
];

export async function renderJill(view, el, params) {
  if (view === 'roles') return renderRoles(el);
  if (view === 'role' && params[0]) return renderRole(el, params[0], params[1]);
  if (view === 'talent') return renderTalent(el);
  if (view === 'interviews') return renderInterviews(el);
  return renderOverview(el);
}

export function applySourcing(data) {
  state.sourcing[data.roleId] = data;
}
