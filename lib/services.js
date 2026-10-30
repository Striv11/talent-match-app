const { db, save, newId, now } = require('./store');
const ai = require('./ai');
const { rankCandidatesForRole, rankRolesForCandidate, structuredScore } = require('./matching');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const STAGES = ['sourced', 'applied', 'contacted', 'screening', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'];
const ACTIVE_STAGES = ['sourced', 'applied', 'contacted', 'screening', 'interview', 'offer'];
const WORK_MODES = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'Onsite', 'on-site': 'Onsite', office: 'Onsite', 'in-office': 'Onsite' };
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_FILE_TYPES = ['application/pdf', 'text/plain', 'text/markdown', 'image/png', 'image/jpeg', 'image/webp'];

// ---------- shared helpers ----------

const str = (value, max = 500) => (value === undefined || value === null ? undefined : String(value).trim().slice(0, max) || undefined);
const num = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(String(value).replace(/[^\d.]/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
};
const list = (value, max = 40) => {
  if (value === undefined || value === null) return undefined;
  const items = Array.isArray(value) ? value : String(value).split(/[,\n;]/);
  const seen = new Set();
  return items.map((item) => String(item).trim()).filter((item) => {
    const key = item.toLowerCase();
    if (!item || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, max);
};
const workMode = (value) => {
  const key = String(value || '').toLowerCase().trim();
  return WORK_MODES[key] || Object.entries(WORK_MODES).find(([name]) => key.includes(name))?.[1] || str(value, 40);
};
const compact = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && !(Array.isArray(value) && !value.length)));

function unionList(existing = [], incoming = []) {
  return list([...(existing || []), ...(incoming || [])], 60);
}

function validateFile(file) {
  if (!file) return undefined;
  if (!file.data || !file.mimeType) throw new HttpError(400, 'The uploaded file could not be read.');
  if (!SUPPORTED_FILE_TYPES.includes(file.mimeType)) {
    throw new HttpError(415, 'Upload a PDF, image or text file. For Word documents, save as PDF first.');
  }
  if (Buffer.byteLength(file.data, 'base64') > MAX_FILE_BYTES) throw new HttpError(413, 'Files must be under 10 MB.');
  return { mimeType: file.mimeType, data: file.data };
}

// ---------- candidates ----------

function cleanProfile(input = {}) {
  return compact({
    name: str(input.name, 120),
    email: str(input.email, 200)?.toLowerCase(),
    phone: str(input.phone, 40),
    linkedinUrl: str(input.linkedinUrl, 300),
    headline: str(input.headline, 200),
    summary: str(input.summary, 2000),
    city: str(input.city, 80),
    currentTitle: str(input.currentTitle, 120),
    currentCompany: str(input.currentCompany, 120),
    experienceYears: num(input.experienceYears),
    skills: list(input.skills, 40),
    experience: Array.isArray(input.experience) ? input.experience.slice(0, 15).map((item) => compact({
      title: str(item.title, 120),
      company: str(item.company, 120),
      start: str(item.start, 40),
      end: str(item.end, 40),
      highlights: list(item.highlights, 8)
    })).filter((item) => item.title || item.company) : undefined,
    education: Array.isArray(input.education) ? input.education.slice(0, 6).map((item) => compact({
      school: str(item.school, 160),
      degree: str(item.degree, 160),
      year: str(item.year, 20)
    })).filter((item) => item.school || item.degree) : undefined,
    achievements: list(input.achievements, 15),
    targetRoles: list(input.targetRoles, 10),
    preferredCities: list(input.preferredCities, 10),
    workMode: workMode(input.workMode),
    salaryCurrent: num(input.salaryCurrent),
    salaryExpectation: num(input.salaryExpectation),
    noticePeriod: str(input.noticePeriod, 60),
    careerGoals: str(input.careerGoals, 1000),
    interviewInsights: list(input.interviewInsights, 20)
  });
}

const entryKey = (item, fields) => fields.map((field) => String(item[field] || '').toLowerCase().trim()).join('|');

function mergeEntries(existing = [], incoming = [], fields) {
  const merged = [...existing];
  incoming.forEach((item) => {
    const index = merged.findIndex((current) => entryKey(current, fields) === entryKey(item, fields));
    if (index >= 0) merged[index] = { ...merged[index], ...item, highlights: unionList(merged[index].highlights, item.highlights) };
    else merged.push(item);
  });
  return merged;
}

function applyProfilePatch(candidate, patch, { replaceLists = false } = {}) {
  const clean = cleanProfile(patch);
  Object.entries(clean).forEach(([key, value]) => {
    if (key === 'experience') candidate.experience = replaceLists ? value : mergeEntries(candidate.experience, value, ['title', 'company']);
    else if (key === 'education') candidate.education = replaceLists ? value : mergeEntries(candidate.education, value, ['school', 'degree']);
    else if (Array.isArray(value) && !replaceLists) candidate[key] = unionList(candidate[key], value);
    else candidate[key] = value;
  });
  if (patch.removeSkills) {
    const remove = new Set(list(patch.removeSkills).map((skill) => skill.toLowerCase()));
    candidate.skills = (candidate.skills || []).filter((skill) => !remove.has(skill.toLowerCase()));
  }
  candidate.updatedAt = now();
  return candidate;
}

const COMPLETENESS = [
  ['Name', (c) => c.name],
  ['Current role', (c) => c.currentTitle],
  ['City', (c) => c.city],
  ['Years of experience', (c) => Number.isFinite(c.experienceYears)],
  ['At least 5 skills', (c) => (c.skills || []).length >= 5],
  ['Work history', (c) => (c.experience || []).length > 0],
  ['Professional summary', (c) => c.summary],
  ['Measurable achievements', (c) => (c.achievements || []).length > 0],
  ['Roles you want next', (c) => (c.targetRoles || []).length > 0],
  ['Salary expectation', (c) => Number.isFinite(c.salaryExpectation)],
  ['Notice period', (c) => c.noticePeriod],
  ['Work mode preference', (c) => c.workMode],
  ['Preferred cities', (c) => (c.preferredCities || []).length > 0],
  ['Career goals', (c) => c.careerGoals]
];

function completeness(candidate) {
  if (!candidate) return { percent: 0, missing: COMPLETENESS.map(([label]) => label) };
  const missing = COMPLETENESS.filter(([, test]) => !test(candidate)).map(([label]) => label);
  return { percent: Math.round(((COMPLETENESS.length - missing.length) / COMPLETENESS.length) * 100), missing };
}

function findMyProfile(user) {
  return db.candidates.find((candidate) => candidate.ownerId === user.sub) || null;
}

function getMyProfile(user) {
  const candidate = findMyProfile(user);
  return { profile: candidate, completeness: completeness(candidate) };
}

function ensureMyProfile(user) {
  let candidate = findMyProfile(user);
  if (!candidate) {
    candidate = {
      id: newId('cand'),
      ownerId: user.sub,
      origin: 'self',
      name: user.name && user.name !== user.email ? user.name : undefined,
      email: user.email && !user.email.endsWith('.invalid') ? user.email : undefined,
      skills: [],
      discoverable: false,
      createdAt: now(),
      updatedAt: now()
    };
    db.candidates.push(candidate);
  }
  return candidate;
}

function updateMyProfile(user, patch, options) {
  const candidate = ensureMyProfile(user);
  applyProfilePatch(candidate, patch, options);
  if (typeof patch.discoverable === 'boolean') candidate.discoverable = patch.discoverable;
  save();
  return getMyProfile(user);
}

async function importMyProfile(user, { text, file, linkedinUrl }) {
  const validFile = validateFile(file);
  if (!validFile && !str(text, 50000)) throw new HttpError(400, 'Add a résumé, LinkedIn PDF or some profile text to import.');
  const extracted = await ai.extractCandidateProfile({ text, file: validFile });
  const candidate = ensureMyProfile(user);
  if (!candidate.email && extracted.email) candidate.email = extracted.email;
  delete extracted.email;
  applyProfilePatch(candidate, { ...extracted, linkedinUrl: linkedinUrl || extracted.linkedinUrl });
  candidate.origin = candidate.origin === 'self' ? 'self' : candidate.origin;
  candidate.importedAt = now();
  save();
  return getMyProfile(user);
}

function setDiscoverable(user, discoverable) {
  const candidate = findMyProfile(user);
  if (!candidate) throw new HttpError(404, 'Create your profile first.');
  candidate.discoverable = Boolean(discoverable);
  candidate.updatedAt = now();
  save();
  return { discoverable: candidate.discoverable };
}

// ---------- companies & roles ----------

const myCompanyIds = (user) => new Set(db.companies.filter((company) => company.ownerId === user.sub).map((company) => company.id));
const companyById = (id) => db.companies.find((company) => company.id === id);
const candidateById = (id) => db.candidates.find((candidate) => candidate.id === id);

function listMyCompanies(user) {
  return db.companies.filter((company) => company.ownerId === user.sub);
}

function upsertCompany(user, input) {
  const clean = compact({
    name: str(input.name, 120),
    industry: str(input.industry, 120),
    stage: str(input.stage, 60),
    city: str(input.city, 80),
    website: str(input.website, 200),
    about: str(input.about, 2000),
    size: str(input.size, 60)
  });
  let company = input.id ? db.companies.find((item) => item.id === input.id && item.ownerId === user.sub) : null;
  if (input.id && !company) throw new HttpError(404, 'Company not found.');
  if (!company) {
    if (!clean.name) throw new HttpError(400, 'Company name is required.');
    company = { id: newId('co'), ownerId: user.sub, createdAt: now() };
    db.companies.push(company);
  }
  Object.assign(company, clean, { updatedAt: now() });
  save();
  return company;
}

function ensureCompany(user, companyId, nameHint) {
  if (companyId) {
    const company = companyById(companyId);
    if (!company || company.ownerId !== user.sub) throw new HttpError(403, 'That company belongs to another account.');
    return company;
  }
  return listMyCompanies(user)[0] || upsertCompany(user, { name: nameHint || 'My company' });
}

function requireMyRole(user, roleId) {
  const role = db.roles.find((item) => item.id === roleId);
  if (!role) throw new HttpError(404, 'Role not found.');
  if (!myCompanyIds(user).has(role.companyId)) throw new HttpError(403, 'That role belongs to another company account.');
  return role;
}

function cleanRole(input = {}) {
  return compact({
    title: str(input.title, 140),
    city: str(input.city, 80),
    workMode: workMode(input.workMode),
    seniority: str(input.seniority, 40),
    experienceMin: num(input.experienceMin),
    experienceMax: num(input.experienceMax),
    salaryMin: num(input.salaryMin),
    salaryMax: num(input.salaryMax),
    mustHaveSkills: list(input.mustHaveSkills, 12),
    niceToHaveSkills: list(input.niceToHaveSkills, 12),
    responsibilities: list(input.responsibilities, 15),
    summary: str(input.summary, 600),
    jd: str(input.jd, 20000),
    status: ['Open', 'Paused', 'Closed'].includes(input.status) ? input.status : undefined
  });
}

function roleView(role) {
  const company = companyById(role.companyId);
  const applications = db.applications.filter((app) => app.roleId === role.id);
  const counts = Object.fromEntries(STAGES.map((stage) => [stage, applications.filter((app) => app.stage === stage).length]));
  return { ...role, companyName: company?.name || 'Company', counts, inPipeline: applications.filter((app) => ACTIVE_STAGES.includes(app.stage)).length };
}

function listMyRoles(user) {
  const companyIds = myCompanyIds(user);
  return db.roles.filter((role) => companyIds.has(role.companyId)).map(roleView).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function getMyRole(user, roleId) {
  const role = requireMyRole(user, roleId);
  return { ...roleView(role), company: companyById(role.companyId) };
}

function saveNewRole(user, data, companyId, origin) {
  const company = ensureCompany(user, companyId, data.companyName);
  const role = {
    id: newId('role'),
    companyId: company.id,
    ownerId: user.sub,
    origin,
    status: 'Open',
    createdAt: now(),
    ...cleanRole(data)
  };
  if (!role.title) throw new HttpError(422, 'Could not find a job title in that description.');
  role.mustHaveSkills ||= [];
  db.roles.push(role);
  save();
  return getMyRole(user, role.id);
}

async function createRoleFromBrief(user, brief) {
  const company = ensureCompany(user, brief.companyId, brief.companyName);
  if (!str(brief.title) && !str(brief.notes)) throw new HttpError(400, 'Tell me at least the role title.');
  const generated = await ai.generateJobDescription(compact({
    title: str(brief.title),
    city: str(brief.city),
    workMode: workMode(brief.workMode),
    seniority: str(brief.seniority),
    experience: str(brief.experience),
    salary: str(brief.salary) || (brief.salaryMin ? `${brief.salaryMin}-${brief.salaryMax} LPA` : undefined),
    mustHaveSkills: list(brief.mustHaveSkills),
    niceToHaveSkills: list(brief.niceToHaveSkills),
    notes: str(brief.notes, 4000)
  }), company);
  const merged = { ...generated, ...cleanRole(brief), jd: generated.jd };
  return saveNewRole(user, merged, company.id, 'generated');
}

async function ingestJobDescription(user, { text, file, companyId }) {
  const validFile = validateFile(file);
  if (!validFile && !str(text, 50000)) throw new HttpError(400, 'Paste a job description or upload one.');
  const parsed = await ai.parseJobDescription({ text, file: validFile });
  if (parsed.companyName && !companyId && !listMyCompanies(user).length) upsertCompany(user, { name: parsed.companyName });
  return saveNewRole(user, parsed, companyId, 'ingested');
}

function updateRole(user, roleId, patch) {
  const role = requireMyRole(user, roleId);
  Object.assign(role, cleanRole(patch), { updatedAt: now() });
  delete role.sourcing;
  save();
  return getMyRole(user, roleId);
}

async function getSourcingPlan(user, roleId, { refresh } = {}) {
  const role = requireMyRole(user, roleId);
  if (!role.sourcingPlan || refresh) {
    role.sourcingPlan = { ...(await ai.sourcingPlan(role, companyById(role.companyId))), at: now() };
    save();
  }
  return role.sourcingPlan;
}

async function getInterviewKit(user, roleId, { refresh } = {}) {
  const role = requireMyRole(user, roleId);
  if (!role.kit || refresh) {
    role.kit = { ...(await ai.interviewKit(role)), at: now() };
    save();
  }
  return role.kit;
}

// ---------- candidate visibility for hiring teams ----------

function companyRoleIds(companyIds) {
  return new Set(db.roles.filter((role) => companyIds.has(role.companyId)).map((role) => role.id));
}

function canSeeCandidate(candidate, companyIds, roleIds) {
  if (candidate.sourcedByCompanyId && companyIds.has(candidate.sourcedByCompanyId)) return true;
  if (candidate.ownerId && candidate.discoverable) return true;
  return db.applications.some((app) => app.candidateId === candidate.id && roleIds.has(app.roleId) && app.source === 'applied');
}

function contactShared(candidate, companyIds, roleIds) {
  if (candidate.sourcedByCompanyId && companyIds.has(candidate.sourcedByCompanyId)) return true;
  if (db.applications.some((app) => app.candidateId === candidate.id && roleIds.has(app.roleId) && app.source === 'applied')) return true;
  return db.intros.some((intro) => intro.candidateId === candidate.id && companyIds.has(intro.companyId) && intro.status === 'accepted');
}

function hrCandidateView(candidate, companyIds, roleIds) {
  const shared = contactShared(candidate, companyIds, roleIds);
  const { ownerId, passedRoleIds, interviewInsights, salaryCurrent, ...rest } = candidate;
  const view = { ...rest, contactShared: shared, hasAccount: Boolean(ownerId), insights: interviewInsights };
  if (!shared) {
    delete view.email;
    delete view.phone;
    delete view.linkedinUrl;
  }
  return view;
}

function visiblePool(user) {
  const companyIds = myCompanyIds(user);
  const roleIds = companyRoleIds(companyIds);
  return { companyIds, roleIds, candidates: db.candidates.filter((candidate) => canSeeCandidate(candidate, companyIds, roleIds)) };
}

function talentPool(user, { query } = {}) {
  const { companyIds, roleIds, candidates } = visiblePool(user);
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  return candidates
    .filter((candidate) => {
      if (!terms.length) return true;
      const haystack = [candidate.name, candidate.currentTitle, candidate.city, candidate.headline, ...(candidate.skills || [])].join(' ').toLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .map((candidate) => ({
      ...hrCandidateView(candidate, companyIds, roleIds),
      applications: db.applications.filter((app) => app.candidateId === candidate.id && roleIds.has(app.roleId)).map((app) => ({ roleId: app.roleId, stage: app.stage }))
    }))
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}

function getCandidateForHR(user, candidateId, roleId) {
  const { companyIds, roleIds, candidates } = visiblePool(user);
  const candidate = candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new HttpError(404, 'Candidate not found in your talent pool.');
  const applications = db.applications.filter((app) => app.candidateId === candidateId && roleIds.has(app.roleId)).map((app) => ({ ...app, roleTitle: db.roles.find((role) => role.id === app.roleId)?.title }));
  const interviews = db.interviews.filter((interview) => interview.candidateId === candidateId && roleIds.has(interview.roleId));
  const role = roleId ? requireMyRole(user, roleId) : null;
  return {
    candidate: hrCandidateView(candidate, companyIds, roleIds),
    applications,
    interviews,
    fit: role ? structuredScore(candidate, role) : null,
    intro: role ? db.intros.find((intro) => intro.candidateId === candidateId && intro.roleId === role.id) || null : null
  };
}

async function importCandidates(user, { files = [], texts = [], roleId }) {
  const role = roleId ? requireMyRole(user, roleId) : null;
  const company = role ? companyById(role.companyId) : ensureCompany(user);
  const sources = [
    ...files.slice(0, 20).map((file) => ({ file: validateFile(file), label: str(file.name, 120) || 'file' })),
    ...texts.slice(0, 20).filter((text) => str(text)).map((text, index) => ({ text, label: `Pasted profile ${index + 1}` }))
  ];
  if (!sources.length) throw new HttpError(400, 'Add at least one résumé.');

  const results = [];
  for (let index = 0; index < sources.length; index += 3) {
    const batch = sources.slice(index, index + 3);
    const settled = await Promise.allSettled(batch.map((source) => ai.extractCandidateProfile(source)));
    settled.forEach((outcome, offset) => {
      const label = batch[offset].label;
      if (outcome.status === 'rejected' || !outcome.value?.name) {
        results.push({ label, ok: false, error: outcome.reason?.message || 'No name found in this document.' });
        return;
      }
      const profile = cleanProfile(outcome.value);
      let candidate = profile.email && db.candidates.find((item) => item.sourcedByCompanyId === company.id && item.email === profile.email);
      if (candidate) {
        applyProfilePatch(candidate, profile);
      } else {
        candidate = { id: newId('cand'), ownerId: null, sourcedByCompanyId: company.id, origin: 'hr_import', discoverable: false, skills: [], createdAt: now(), ...profile, updatedAt: now() };
        db.candidates.push(candidate);
      }
      if (role) upsertApplication(role, candidate.id, { source: 'sourced', stage: 'sourced', by: user.name });
      results.push({ label, ok: true, candidateId: candidate.id, name: candidate.name });
    });
  }
  save();
  return { imported: results.filter((item) => item.ok).length, results };
}

// ---------- sourcing ----------

async function sourceForRole(user, roleId, { deep = false } = {}) {
  const role = requireMyRole(user, roleId);
  const { companyIds, roleIds, candidates } = visiblePool(user);
  const pool = candidates.filter((candidate) => !(candidate.passedRoleIds || []).includes(role.id));
  const ranked = (await rankCandidatesForRole(role, pool)).slice(0, 40);

  let aiNotes = new Map();
  if (deep && ranked.length) {
    const top = ranked.slice(0, 12);
    const rankings = await ai.rerankCandidates(role, top.map((item) => item.candidate));
    aiNotes = new Map(rankings.map((item) => [item.candidateId, item]));
    ranked.forEach((item) => {
      const note = aiNotes.get(item.candidate.id);
      if (note) item.score = Math.round(item.score * 0.4 + Math.max(0, Math.min(100, note.fitScore)) * 0.6);
    });
    ranked.sort((a, b) => b.score - a.score);
  }

  const results = ranked.map((item) => {
    const note = aiNotes.get(item.candidate.id);
    const app = db.applications.find((entry) => entry.roleId === role.id && entry.candidateId === item.candidate.id);
    return {
      candidate: hrCandidateView(item.candidate, companyIds, roleIds),
      score: item.score,
      reasons: item.reasons,
      gaps: note?.gaps?.length ? note.gaps : item.gaps,
      aiSummary: note?.why,
      stage: app?.stage || null,
      intro: db.intros.find((intro) => intro.roleId === role.id && intro.candidateId === item.candidate.id)?.status || null
    };
  });
  role.lastSourcedAt = now();
  save();
  return { roleId: role.id, deep, poolSize: pool.length, results };
}

// ---------- pipeline ----------

// advanceOnly is for automatic transitions (intros, interviews): they move a
// candidate forward but never pull them back from a later stage.
function upsertApplication(role, candidateId, { source, stage, note, by, advanceOnly = false }) {
  let app = db.applications.find((item) => item.roleId === role.id && item.candidateId === candidateId);
  const at = now();
  if (app && advanceOnly && STAGES.indexOf(stage) <= STAGES.indexOf(app.stage)) stage = undefined;
  if (!app) {
    app = { id: newId('app'), roleId: role.id, companyId: role.companyId, candidateId, source, stage, notes: [], history: [{ stage, at }], createdAt: at, updatedAt: at };
    db.applications.push(app);
  } else if (stage && app.stage !== stage) {
    app.stage = stage;
    app.history.push({ stage, at });
  }
  if (source === 'applied') app.source = 'applied';
  if (note) app.notes.push({ text: String(note).slice(0, 2000), at, by });
  app.updatedAt = at;
  return app;
}

function pipelineEntry(app, companyIds, roleIds) {
  const candidate = candidateById(app.candidateId);
  const role = db.roles.find((item) => item.id === app.roleId);
  return {
    ...app,
    roleTitle: role?.title,
    candidate: candidate ? hrCandidateView(candidate, companyIds, roleIds) : null,
    score: candidate && role ? structuredScore(candidate, role).score : null,
    nextInterview: db.interviews
      .filter((interview) => interview.applicationId === app.id && interview.startsAt >= now())
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0] || null
  };
}

function getPipeline(user, roleId) {
  const companyIds = myCompanyIds(user);
  const roleIds = companyRoleIds(companyIds);
  if (roleId) requireMyRole(user, roleId);
  return db.applications
    .filter((app) => roleIds.has(app.roleId) && (!roleId || app.roleId === roleId))
    .map((app) => pipelineEntry(app, companyIds, roleIds))
    .filter((entry) => entry.candidate)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function moveCandidate(user, { roleId, candidateId, stage, note }) {
  const role = requireMyRole(user, roleId);
  if (!STAGES.includes(stage)) throw new HttpError(400, `Stage must be one of: ${STAGES.join(', ')}.`);
  const { candidates, companyIds, roleIds } = visiblePool(user);
  if (!candidates.some((candidate) => candidate.id === candidateId)) throw new HttpError(404, 'Candidate not found in your talent pool.');
  const app = upsertApplication(role, candidateId, { source: 'sourced', stage, note, by: user.name });
  save();
  return pipelineEntry(app, companyIds, roleIds);
}

function addNote(user, { roleId, candidateId, note }) {
  const role = requireMyRole(user, roleId);
  const app = db.applications.find((item) => item.roleId === role.id && item.candidateId === candidateId);
  if (!app) throw new HttpError(404, 'Add the candidate to this role\'s pipeline first.');
  upsertApplication(role, candidateId, { note, by: user.name });
  save();
  return app;
}

async function draftOutreach(user, { roleId, candidateId }) {
  const role = requireMyRole(user, roleId);
  const { candidates } = visiblePool(user);
  const candidate = candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new HttpError(404, 'Candidate not found in your talent pool.');
  const draft = await ai.outreachDraft(role, companyById(role.companyId), candidate, user.name);
  const app = upsertApplication(role, candidateId, { source: 'sourced', stage: db.applications.some((item) => item.roleId === role.id && item.candidateId === candidateId) ? undefined : 'sourced' });
  app.outreach = { ...draft, at: now() };
  save();
  return app.outreach;
}

function requestIntro(user, { roleId, candidateId, message }) {
  const role = requireMyRole(user, roleId);
  const candidate = candidateById(candidateId);
  if (!candidate || !candidate.ownerId || !candidate.discoverable) {
    throw new HttpError(409, 'Introductions are for candidates on Jack & Jill who are open to intros. Use outreach for imported candidates.');
  }
  let intro = db.intros.find((item) => item.candidateId === candidateId && item.roleId === roleId);
  if (!intro) {
    intro = { id: newId('intro'), candidateId, roleId, companyId: role.companyId, status: 'pending', message: str(message, 1000), requestedBy: user.name, createdAt: now() };
    db.intros.push(intro);
    upsertApplication(role, candidateId, { source: 'sourced', stage: 'contacted', note: 'Introduction requested.', by: user.name, advanceOnly: true });
    save();
  }
  return intro;
}

function toICSDate(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function scheduleInterview(user, { roleId, candidateId, startsAt, durationMins, mode, panel, location, notes }) {
  const role = requireMyRole(user, roleId);
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) throw new HttpError(400, 'Give the interview a valid date and time.');
  const { candidates, companyIds, roleIds } = visiblePool(user);
  const candidate = candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new HttpError(404, 'Candidate not found in your talent pool.');
  const app = upsertApplication(role, candidateId, { source: 'sourced', stage: 'interview', advanceOnly: true, note: `Interview scheduled for ${start.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST.`, by: user.name });
  const interview = {
    id: newId('int'),
    applicationId: app.id,
    roleId,
    candidateId,
    companyId: role.companyId,
    startsAt: start.toISOString(),
    durationMins: Math.min(Math.max(num(durationMins) || 45, 15), 480),
    mode: str(mode, 40) || 'Video',
    panel: list(panel, 10) || [],
    location: str(location, 300),
    notes: str(notes, 2000),
    createdAt: now()
  };
  db.interviews.push(interview);
  save();
  return { ...interview, candidateName: candidate.name, roleTitle: role.title, contactShared: contactShared(candidate, companyIds, roleIds) };
}

function listInterviews(user) {
  const companyIds = myCompanyIds(user);
  return db.interviews
    .filter((interview) => companyIds.has(interview.companyId))
    .map((interview) => ({
      ...interview,
      candidateName: candidateById(interview.candidateId)?.name || 'Candidate',
      roleTitle: db.roles.find((role) => role.id === interview.roleId)?.title || 'Role'
    }))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

function interviewICS(user, interviewId) {
  const interview = listInterviews(user).find((item) => item.id === interviewId);
  if (!interview) throw new HttpError(404, 'Interview not found.');
  const end = new Date(new Date(interview.startsAt).getTime() + interview.durationMins * 60000).toISOString();
  const escape = (value) => String(value || '').replace(/[\\;,]/g, (char) => `\\${char}`).replace(/\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Jack & Jill India//EN', 'BEGIN:VEVENT',
    `UID:${interview.id}@jackandjill.local`,
    `DTSTAMP:${toICSDate(new Date().toISOString())}`,
    `DTSTART:${toICSDate(interview.startsAt)}`,
    `DTEND:${toICSDate(end)}`,
    `SUMMARY:${escape(`Interview: ${interview.candidateName} · ${interview.roleTitle}`)}`,
    `DESCRIPTION:${escape([`Mode: ${interview.mode}`, interview.panel.length ? `Panel: ${interview.panel.join(', ')}` : '', interview.notes].filter(Boolean).join('\n'))}`,
    interview.location ? `LOCATION:${escape(interview.location)}` : '',
    'END:VEVENT', 'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');
}

function addInterviewFeedback(user, interviewId, { rating, recommendation, notes }) {
  const companyIds = myCompanyIds(user);
  const interview = db.interviews.find((item) => item.id === interviewId && companyIds.has(item.companyId));
  if (!interview) throw new HttpError(404, 'Interview not found.');
  interview.feedback ||= [];
  interview.feedback.push(compact({
    by: user.name,
    rating: Math.min(Math.max(num(rating) || 0, 0), 5) || undefined,
    recommendation: ['strong_yes', 'yes', 'no', 'strong_no'].includes(recommendation) ? recommendation : undefined,
    notes: str(notes, 4000),
    at: now()
  }));
  save();
  return interview;
}

async function draftOffer(user, { roleId, candidateId, ctc, joiningDate, extras }) {
  const role = requireMyRole(user, roleId);
  const app = db.applications.find((item) => item.roleId === role.id && item.candidateId === candidateId);
  if (!app) throw new HttpError(404, 'Add the candidate to this role\'s pipeline first.');
  const candidate = candidateById(candidateId);
  const terms = compact({ ctcLPA: num(ctc), joiningDate: str(joiningDate, 40), extras: str(extras, 1000) });
  app.offer = { ...(await ai.offerDraft(role, companyById(role.companyId), candidate, terms)), terms, at: now() };
  save();
  return app.offer;
}

function hiringSummary(user) {
  const roles = listMyRoles(user);
  const pipeline = getPipeline(user);
  const weekAhead = new Date(Date.now() + 7 * 86400000).toISOString();
  const interviews = listInterviews(user);
  return {
    company: listMyCompanies(user)[0] || null,
    openRoles: roles.filter((role) => role.status === 'Open').length,
    inPipeline: pipeline.filter((entry) => ACTIVE_STAGES.includes(entry.stage)).length,
    offers: pipeline.filter((entry) => entry.stage === 'offer').length,
    hired: pipeline.filter((entry) => entry.stage === 'hired').length,
    funnel: ['sourced', 'applied', 'contacted', 'screening', 'interview', 'offer', 'hired'].map((stage) => ({ stage, count: pipeline.filter((entry) => entry.stage === stage).length })),
    roles: roles.map(({ id, title, city, status, counts, inPipeline, companyName }) => ({ id, title, city, status, counts, inPipeline, companyName })),
    upcomingInterviews: interviews.filter((item) => item.startsAt >= now() && item.startsAt <= weekAhead),
    needsAttention: pipeline.filter((entry) => entry.stage === 'applied' || (entry.screening && entry.stage === 'screening' && !entry.screeningReviewed)).slice(0, 8)
  };
}

// ---------- candidate-side opportunities ----------

function requireMyProfile(user) {
  const candidate = findMyProfile(user);
  if (!candidate || !candidate.name) throw new HttpError(404, 'Build your profile first — import a résumé or talk to Jack.');
  return candidate;
}

const STAGE_FOR_CANDIDATE = {
  sourced: null,
  applied: 'Applied',
  contacted: 'In conversation',
  screening: 'Screening',
  interview: 'Interviewing',
  offer: 'Offer',
  hired: 'Hired',
  rejected: 'Not moving forward',
  withdrawn: 'Withdrawn'
};

async function myOpportunities(user) {
  const candidate = requireMyProfile(user);
  const open = db.roles.filter((role) => role.status === 'Open' && !(candidate.passedRoleIds || []).includes(role.id));
  const ranked = await rankRolesForCandidate(candidate, open);
  return ranked.slice(0, 30).map((item) => {
    const company = companyById(item.role.companyId);
    const app = db.applications.find((entry) => entry.roleId === item.role.id && entry.candidateId === candidate.id);
    const { jd, kit, sourcingPlan, ownerId, ...role } = item.role;
    return {
      role: { ...role, companyName: company?.name, companyIndustry: company?.industry, companyStage: company?.stage },
      score: item.score,
      reasons: item.reasons,
      gaps: item.gaps,
      status: app?.source === 'applied' ? STAGE_FOR_CANDIDATE[app.stage] || 'Applied' : null,
      screeningDone: Boolean(app?.screening)
    };
  });
}

function publicRole(user, roleId) {
  const role = db.roles.find((item) => item.id === roleId && (item.status === 'Open' || myCompanyIds(user).has(item.companyId)));
  if (!role) throw new HttpError(404, 'That role is no longer open.');
  const company = companyById(role.companyId);
  const { kit, sourcingPlan, ownerId, ...rest } = role;
  return { ...rest, companyName: company?.name, company: company && { name: company.name, industry: company.industry, stage: company.stage, about: company.about, city: company.city } };
}

function respondToRole(user, { roleId, response }) {
  const candidate = requireMyProfile(user);
  const role = db.roles.find((item) => item.id === roleId);
  if (!role) throw new HttpError(404, 'Role not found.');
  if (!['interested', 'passed'].includes(response)) throw new HttpError(400, 'Response must be interested or passed.');
  const existing = db.applications.find((item) => item.roleId === role.id && item.candidateId === candidate.id);
  if (response === 'interested') {
    if (role.status !== 'Open') throw new HttpError(409, 'That role is no longer open.');
    const stage = !existing || existing.stage === 'sourced' ? 'applied' : existing.stage;
    upsertApplication(role, candidate.id, { source: 'applied', stage, note: 'Candidate applied via Jack.', by: candidate.name });
    candidate.passedRoleIds = (candidate.passedRoleIds || []).filter((id) => id !== role.id);
  } else {
    candidate.passedRoleIds = unionList(candidate.passedRoleIds, [role.id]);
    if (existing && ACTIVE_STAGES.includes(existing.stage)) upsertApplication(role, candidate.id, { stage: 'withdrawn', note: 'Candidate passed on this role.' });
  }
  save();
  return { roleId, response };
}

function myApplications(user) {
  const candidate = findMyProfile(user);
  if (!candidate) return { applications: [], introductions: [] };
  const applications = db.applications
    .filter((app) => app.candidateId === candidate.id && (app.source === 'applied' || db.intros.some((intro) => intro.roleId === app.roleId && intro.candidateId === candidate.id && intro.status === 'accepted')))
    .map((app) => {
      const role = db.roles.find((item) => item.id === app.roleId);
      return {
        id: app.id,
        roleId: app.roleId,
        roleTitle: role?.title,
        companyName: companyById(app.companyId)?.name,
        city: role?.city,
        status: STAGE_FOR_CANDIDATE[app.stage] || 'Applied',
        stage: app.stage,
        screeningDone: Boolean(app.screening),
        updatedAt: app.updatedAt,
        interviews: db.interviews.filter((interview) => interview.applicationId === app.id).map(({ startsAt, durationMins, mode, location }) => ({ startsAt, durationMins, mode, location }))
      };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const introductions = db.intros
    .filter((intro) => intro.candidateId === candidate.id)
    .map((intro) => {
      const role = db.roles.find((item) => item.id === intro.roleId);
      const company = companyById(intro.companyId);
      return { id: intro.id, status: intro.status, message: intro.message, requestedBy: intro.requestedBy, createdAt: intro.createdAt, roleId: intro.roleId, roleTitle: role?.title, city: role?.city, workMode: role?.workMode, salaryMin: role?.salaryMin, salaryMax: role?.salaryMax, companyName: company?.name };
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { applications, introductions };
}

function respondToIntro(user, { introId, response }) {
  const candidate = requireMyProfile(user);
  const intro = db.intros.find((item) => item.id === introId && item.candidateId === candidate.id);
  if (!intro) throw new HttpError(404, 'That introduction was not found.');
  if (!['accepted', 'declined'].includes(response)) throw new HttpError(400, 'Response must be accepted or declined.');
  if (intro.status !== 'pending') throw new HttpError(409, 'You have already answered this introduction.');
  intro.status = response;
  intro.respondedAt = now();
  const role = db.roles.find((item) => item.id === intro.roleId);
  if (role) upsertApplication(role, candidate.id, { stage: response === 'accepted' ? 'contacted' : 'withdrawn', advanceOnly: response === 'accepted', note: `Candidate ${response} the introduction.`, by: candidate.name });
  save();
  return intro;
}

async function prepForRole(user, roleId) {
  const candidate = requireMyProfile(user);
  const role = db.roles.find((item) => item.id === roleId);
  if (!role) throw new HttpError(404, 'Role not found.');
  return ai.interviewPrep(role, companyById(role.companyId), candidate);
}

function submitScreening(user, { roleId, answers, strengths, concerns, summary }) {
  const candidate = requireMyProfile(user);
  const role = db.roles.find((item) => item.id === roleId && item.status === 'Open');
  if (!role) throw new HttpError(404, 'That role is no longer open.');
  const existing = db.applications.find((item) => item.roleId === role.id && item.candidateId === candidate.id);
  const earlier = !existing || ['sourced', 'applied', 'contacted'].includes(existing.stage);
  const app = upsertApplication(role, candidate.id, { source: 'applied', stage: earlier ? 'screening' : undefined, note: 'Completed AI voice screening with Jack.', by: candidate.name });
  app.screening = {
    answers: (Array.isArray(answers) ? answers : []).slice(0, 12).map((item) => ({ question: str(item.question, 400), answer: str(item.answer || item.summary, 1500) })),
    strengths: list(strengths, 8) || [],
    concerns: list(concerns, 8) || [],
    summary: str(summary, 1500),
    at: now()
  };
  save();
  return { saved: true, stage: app.stage };
}

function candidateHome(user) {
  const { profile, completeness: score } = getMyProfile(user);
  const { applications, introductions } = myApplications(user);
  return {
    hasProfile: Boolean(profile?.name),
    completeness: score,
    discoverable: Boolean(profile?.discoverable),
    applications: applications.length,
    pendingIntros: introductions.filter((intro) => intro.status === 'pending').length,
    openRoles: db.roles.filter((role) => role.status === 'Open').length
  };
}

// ---------- demo data (development only) ----------

function seedDemo() {
  if (db.candidates.some((candidate) => candidate.origin === 'demo')) return { seeded: false };
  const at = now();
  const people = [
    ['Aarav Mehta', 'Senior Backend Engineer', 'Razorpay', 'Bengaluru', 7, ['Go', 'Kafka', 'PostgreSQL', 'Kubernetes', 'AWS', 'Distributed Systems', 'gRPC'], 48, 'Hybrid', 'Scaled payouts ledger to 40M txns/day; led migration from monolith to Go services'],
    ['Diya Iyer', 'Frontend Engineer', 'Swiggy', 'Bengaluru', 4, ['React', 'TypeScript', 'Next.js', 'GraphQL', 'Web Performance', 'Design Systems'], 32, 'Hybrid', 'Cut checkout LCP by 38%; built the shared React component library used by 9 teams'],
    ['Kabir Singh', 'Full-stack Engineer', 'Zomato', 'Delhi NCR', 5, ['Node.js', 'React', 'TypeScript', 'MongoDB', 'Redis', 'AWS'], 36, 'Remote', 'Shipped restaurant analytics dashboard used by 120k partners'],
    ['Ananya Rao', 'ML Engineer', 'Flipkart', 'Bengaluru', 6, ['Python', 'PyTorch', 'LLMs', 'MLOps', 'Recommendation Systems', 'Spark'], 55, 'Hybrid', 'Improved search relevance NDCG by 11% with transformer re-ranker'],
    ['Rohan Kulkarni', 'Product Manager', 'CRED', 'Pune', 6, ['Product Management', 'Fintech', 'SQL', 'Experimentation', 'User Research', 'Roadmapping'], 45, 'Hybrid', 'Launched rent payments, growing to ₹800 Cr monthly TPV'],
    ['Meera Nair', 'Product Designer', 'Freshworks', 'Chennai', 5, ['Figma', 'UX Design', 'Design Systems', 'Prototyping', 'User Research'], 30, 'Remote', 'Redesigned onboarding, lifting activation from 22% to 34%'],
    ['Vikram Reddy', 'DevOps Engineer', 'PhonePe', 'Hyderabad', 8, ['Kubernetes', 'Terraform', 'AWS', 'CI CD', 'Prometheus', 'Linux', 'Go'], 50, 'Onsite', 'Reduced infra cost 27% via autoscaling and spot fleets'],
    ['Sneha Joshi', 'Data Analyst', 'Meesho', 'Bengaluru', 3, ['SQL', 'Python', 'Tableau', 'Experimentation', 'Statistics'], 20, 'Hybrid', 'Built seller-cohort dashboards adopted by category leadership'],
    ['Arjun Das', 'Android Engineer', 'Ola', 'Bengaluru', 5, ['Kotlin', 'Android', 'Jetpack Compose', 'Coroutines', 'Firebase'], 34, 'Hybrid', 'Cut app cold-start time by 45% on low-end devices'],
    ['Ishita Gupta', 'Engineering Manager', 'Zerodha', 'Mumbai', 11, ['Engineering Management', 'Python', 'Go', 'System Design', 'Hiring', 'Distributed Systems'], 85, 'Onsite', 'Grew trading-platform team from 6 to 18 engineers with zero regretted attrition'],
    ['Farhan Qureshi', 'Backend Engineer', 'Groww', 'Bengaluru', 3, ['Java', 'Spring', 'MySQL', 'Kafka', 'Microservices'], 26, 'Hybrid', 'Built SIP scheduling service handling 2M daily orders'],
    ['Priya Menon', 'Growth Marketer', 'Unacademy', 'Bengaluru', 6, ['Performance Marketing', 'SEO', 'Lifecycle Marketing', 'Analytics', 'Content Strategy'], 32, 'Remote', 'Scaled organic signups 3x in 12 months']
  ];
  people.forEach(([name, title, company, city, years, skills, salary, mode, achievement], index) => {
    db.candidates.push({
      id: newId('cand'), ownerId: `demo-candidate-${index}`, origin: 'demo', discoverable: true,
      name, currentTitle: title, currentCompany: company, city, experienceYears: years, skills,
      headline: `${title} · ${skills.slice(0, 3).join(', ')}`,
      summary: `${title} with ${years} years of experience, currently at ${company}. ${achievement}.`,
      experience: [{ title, company, start: String(2025 - Math.min(years, 4)), end: 'Present', highlights: [achievement] }],
      achievements: [achievement], targetRoles: [title.replace(/^(Senior|Junior) /, '')], preferredCities: [city],
      workMode: mode, salaryExpectation: salary, noticePeriod: ['30 days', '60 days', '90 days', 'Immediate'][index % 4],
      email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`, createdAt: at, updatedAt: at
    });
  });

  const companies = [
    { name: 'Kite Labs', industry: 'Fintech', stage: 'Series B', city: 'Bengaluru', about: 'Kite Labs builds treasury software for Indian SMBs.' },
    { name: 'Saffron Health', industry: 'Healthtech', stage: 'Series A', city: 'Pune', about: 'Saffron Health runs AI-assisted diagnostics for tier-2 clinics.' }
  ].map((company) => ({ id: newId('co'), ownerId: 'demo-hr', demo: true, createdAt: at, ...company }));
  db.companies.push(...companies);
  [
    [companies[0], 'Senior Backend Engineer', 'Bengaluru', 'Hybrid', 'Senior', 5, 9, 40, 60, ['Go', 'PostgreSQL', 'Distributed Systems', 'Kafka'], ['Kubernetes', 'Fintech']],
    [companies[0], 'Frontend Engineer', 'Bengaluru', 'Hybrid', 'Mid', 3, 6, 25, 38, ['React', 'TypeScript'], ['Next.js', 'Design Systems']],
    [companies[1], 'ML Engineer – Diagnostics', 'Pune', 'Remote', 'Senior', 4, 8, 40, 60, ['Python', 'PyTorch', 'MLOps'], ['LLMs', 'Healthcare']],
    [companies[1], 'Product Designer', 'Pune', 'Hybrid', 'Mid', 3, 7, 22, 32, ['Figma', 'UX Design', 'User Research'], ['Healthcare']]
  ].forEach(([company, title, city, mode, seniority, min, max, salaryMin, salaryMax, must, nice]) => {
    db.roles.push({
      id: newId('role'), companyId: company.id, ownerId: 'demo-hr', origin: 'demo', status: 'Open', createdAt: at,
      title, city, workMode: mode, seniority, experienceMin: min, experienceMax: max, salaryMin, salaryMax,
      mustHaveSkills: must, niceToHaveSkills: nice,
      responsibilities: [`Own core ${title.toLowerCase()} work end to end`, 'Collaborate closely with product and design', 'Raise the quality bar through reviews and mentoring'],
      summary: `${company.name} is hiring a ${title} to help scale its ${company.industry.toLowerCase()} platform.`,
      jd: `## About ${company.name}\n${company.about}\n\n## The role\nWe are hiring a ${title} in ${city} (${mode}).\n\n## What you bring\n${must.map((skill) => `- Strong ${skill}`).join('\n')}\n\n## Compensation\n₹${salaryMin}–${salaryMax} LPA`
    });
  });
  save();
  return { seeded: true, candidates: people.length, roles: 4 };
}

module.exports = {
  HttpError,
  STAGES,
  getMyProfile,
  updateMyProfile,
  importMyProfile,
  setDiscoverable,
  candidateHome,
  myOpportunities,
  publicRole,
  respondToRole,
  myApplications,
  respondToIntro,
  prepForRole,
  submitScreening,
  listMyCompanies,
  upsertCompany,
  listMyRoles,
  getMyRole,
  createRoleFromBrief,
  ingestJobDescription,
  updateRole,
  getSourcingPlan,
  getInterviewKit,
  talentPool,
  getCandidateForHR,
  importCandidates,
  sourceForRole,
  getPipeline,
  moveCandidate,
  addNote,
  draftOutreach,
  requestIntro,
  scheduleInterview,
  listInterviews,
  interviewICS,
  addInterviewFeedback,
  draftOffer,
  hiringSummary,
  seedDemo
};
