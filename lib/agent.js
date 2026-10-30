const services = require('./services');
const { generateContent } = require('./ai');

const S = (description, extra = {}) => ({ type: 'STRING', description, ...extra });
const N = (description) => ({ type: 'NUMBER', description });
const B = (description) => ({ type: 'BOOLEAN', description });
const A = (items, description) => ({ type: 'ARRAY', items, description });
const O = (properties, required = []) => ({ type: 'OBJECT', properties, required });
const SA = (description) => A({ type: 'STRING' }, description);

const CANDIDATE_VIEWS = ['profile', 'opportunities', 'applications'];
const HR_VIEWS = ['overview', 'roles', 'role', 'talent', 'interviews'];
const ROLE_TABS = ['jd', 'sourcing', 'pipeline', 'kit'];

const profileFields = {
  name: S('Full name'),
  headline: S('One-line professional headline'),
  summary: S('3-4 sentence professional summary written from what they told you'),
  city: S(),
  currentTitle: S(),
  currentCompany: S(),
  experienceYears: N(),
  skills: SA('Skills to ADD to the profile'),
  removeSkills: SA('Skills to remove'),
  experience: A(O({ title: S(), company: S(), start: S(), end: S(), highlights: SA('Concrete, ideally quantified, accomplishments') }), 'Jobs to add or update (matched on title + company)'),
  education: A(O({ school: S(), degree: S(), year: S() })),
  achievements: SA('Quantified achievements to add'),
  targetRoles: SA('Roles they want next'),
  preferredCities: SA(),
  workMode: S('Remote, Hybrid or Onsite'),
  salaryCurrent: N('Current CTC, lakh rupees per annum'),
  salaryExpectation: N('Expected CTC, lakh rupees per annum'),
  noticePeriod: S(),
  careerGoals: S(),
  interviewInsights: SA('Short recruiter-style observations about motivations, strengths, deal-breakers and working style')
};

const compactProfile = (profile) => profile && Object.fromEntries(Object.entries({
  name: profile.name,
  currentTitle: profile.currentTitle,
  currentCompany: profile.currentCompany,
  city: profile.city,
  experienceYears: profile.experienceYears,
  skills: profile.skills,
  experience: (profile.experience || []).map(({ title, company, start, end, highlights }) => ({ title, company, start, end, highlights: (highlights || []).length })),
  achievements: profile.achievements,
  targetRoles: profile.targetRoles,
  preferredCities: profile.preferredCities,
  workMode: profile.workMode,
  salaryExpectation: profile.salaryExpectation,
  noticePeriod: profile.noticePeriod,
  careerGoals: profile.careerGoals,
  discoverable: profile.discoverable
}).filter(([, value]) => value !== undefined && !(Array.isArray(value) && !value.length)));

const shortCandidate = (candidate) => ({
  candidateId: candidate.id,
  name: candidate.name,
  title: candidate.currentTitle,
  company: candidate.currentCompany,
  city: candidate.city,
  experienceYears: candidate.experienceYears,
  topSkills: (candidate.skills || []).slice(0, 6),
  canRequestIntro: Boolean(candidate.hasAccount && !candidate.contactShared)
});

const tools = [
  // ---------- Jack: candidates ----------
  {
    name: 'get_my_profile', persona: 'candidate',
    description: 'Read the signed-in candidate\'s current profile and which parts are still missing.',
    parameters: O({}),
    run: (user) => {
      const { profile, completeness } = services.getMyProfile(user);
      return { result: { profile: compactProfile(profile), completeness } };
    }
  },
  {
    name: 'update_my_profile', persona: 'candidate',
    description: 'Save facts the candidate has told you to their profile. Call this as you go (after each topic), not only at the end. Lists are merged with what is already there. Never invent facts.',
    parameters: O(profileFields),
    run: (user, args) => {
      const { completeness } = services.updateMyProfile(user, args);
      return { result: { saved: true, completeness }, actions: [{ type: 'refresh', what: 'profile' }] };
    }
  },
  {
    name: 'set_discoverable', persona: 'candidate', consent: true,
    description: 'Make the profile visible (or invisible) to hiring teams on the platform. Only after the candidate explicitly agrees.',
    parameters: O({ discoverable: B() }, ['discoverable']),
    run: (user, args) => ({ result: services.setDiscoverable(user, args.discoverable), actions: [{ type: 'refresh', what: 'profile' }] })
  },
  {
    name: 'find_opportunities', persona: 'candidate',
    description: 'Find open roles ranked for the signed-in candidate, with reasons and gaps.',
    parameters: O({}),
    run: async (user) => {
      const items = await services.myOpportunities(user);
      return {
        result: {
          opportunities: items.slice(0, 6).map((item) => ({
            roleId: item.role.id, title: item.role.title, company: item.role.companyName, city: item.role.city, workMode: item.role.workMode,
            salary: item.role.salaryMax ? `${item.role.salaryMin}-${item.role.salaryMax} LPA` : undefined, score: item.score, reasons: item.reasons, gaps: item.gaps, status: item.status
          }))
        },
        actions: [{ type: 'navigate', view: 'opportunities' }]
      };
    }
  },
  {
    name: 'respond_to_opportunity', persona: 'candidate', consent: true,
    description: 'Apply to (interested) or pass on a role for the candidate, after they explicitly confirm the specific role.',
    parameters: O({ roleId: S(), response: S('', { enum: ['interested', 'passed'] }) }, ['roleId', 'response']),
    run: (user, args) => ({ result: services.respondToRole(user, args), actions: [{ type: 'refresh', what: 'opportunities' }] })
  },
  {
    name: 'get_my_applications', persona: 'candidate',
    description: 'List the candidate\'s applications and introduction requests from companies.',
    parameters: O({}),
    run: (user) => {
      const { applications, introductions } = services.myApplications(user);
      return {
        result: {
          applications: applications.map(({ roleId, roleTitle, companyName, status, interviews }) => ({ roleId, roleTitle, companyName, status, interviews })),
          introductions: introductions.map(({ id, status, roleTitle, companyName, message }) => ({ introId: id, status, roleTitle, companyName, message }))
        },
        actions: [{ type: 'navigate', view: 'applications' }]
      };
    }
  },
  {
    name: 'respond_to_introduction', persona: 'candidate', consent: true,
    description: 'Accept or decline a company\'s introduction request, after the candidate clearly says which.',
    parameters: O({ introId: S(), response: S('', { enum: ['accepted', 'declined'] }) }, ['introId', 'response']),
    run: (user, args) => ({ result: { status: services.respondToIntro(user, args).status }, actions: [{ type: 'refresh', what: 'applications' }] })
  },
  {
    name: 'get_interview_prep', persona: 'candidate',
    description: 'Generate interview preparation for a specific role and show it on screen.',
    parameters: O({ roleId: S() }, ['roleId']),
    run: async (user, args) => {
      const prep = await services.prepForRole(user, args.roleId);
      return { result: { pitch: prep.pitch, likelyQuestions: (prep.likelyQuestions || []).slice(0, 4).map((item) => item.question), salaryNote: prep.salaryNote }, actions: [{ type: 'prep', roleId: args.roleId, prep }] };
    }
  },
  {
    name: 'submit_screening', persona: 'candidate', consent: true,
    description: 'At the end of a voice screening, after the candidate agrees to share it, submit a faithful summary of their answers to the hiring team.',
    parameters: O({
      roleId: S(),
      answers: A(O({ question: S(), answer: S('Faithful summary of what they said') })),
      strengths: SA(),
      concerns: SA('Job-related gaps only'),
      summary: S('Neutral 2-3 sentence summary for the recruiter')
    }, ['roleId', 'answers', 'summary']),
    run: (user, args) => ({ result: services.submitScreening(user, args), actions: [{ type: 'refresh', what: 'applications' }, { type: 'toast', text: 'Screening shared with the hiring team' }] })
  },

  // ---------- Jill: hiring teams ----------
  {
    name: 'get_hiring_overview', persona: 'hr',
    description: 'Summary of open roles, pipeline funnel, upcoming interviews and candidates needing attention.',
    parameters: O({}),
    run: (user) => {
      const summary = services.hiringSummary(user);
      return {
        result: {
          company: summary.company?.name, openRoles: summary.openRoles, inPipeline: summary.inPipeline, offers: summary.offers, hired: summary.hired,
          roles: summary.roles.map(({ id, title, status, inPipeline }) => ({ roleId: id, title, status, inPipeline })),
          upcomingInterviews: summary.upcomingInterviews.map(({ candidateName, roleTitle, startsAt }) => ({ candidateName, roleTitle, startsAt })),
          needsAttention: summary.needsAttention.map((entry) => ({ candidateId: entry.candidateId, name: entry.candidate?.name, roleId: entry.roleId, roleTitle: entry.roleTitle, stage: entry.stage }))
        },
        actions: [{ type: 'navigate', view: 'overview' }]
      };
    }
  },
  {
    name: 'list_roles', persona: 'hr',
    description: 'List the hiring team\'s roles with ids.',
    parameters: O({}),
    run: (user) => ({ result: { roles: services.listMyRoles(user).map(({ id, title, city, status, inPipeline }) => ({ roleId: id, title, city, status, inPipeline })) } })
  },
  {
    name: 'save_company', persona: 'hr',
    description: 'Create or update the hiring team\'s company profile.',
    parameters: O({ name: S(), industry: S(), stage: S(), city: S(), about: S(), website: S() }),
    run: (user, args) => {
      const existing = services.listMyCompanies(user)[0];
      const company = services.upsertCompany(user, { ...args, id: existing?.id });
      return { result: { saved: true, companyId: company.id }, actions: [{ type: 'refresh', what: 'overview' }] };
    }
  },
  {
    name: 'create_role', persona: 'hr', consent: true,
    description: 'Create a role. AI writes the full job description from the brief. Call only after reading the brief back and getting an explicit yes.',
    parameters: O({
      title: S(), companyName: S('Only if the team has no company yet'), city: S(), workMode: S('Remote, Hybrid or Onsite'), seniority: S(),
      experience: S('e.g. "4-7 years"'), salary: S('e.g. "30-45 LPA"'), mustHaveSkills: SA(), niceToHaveSkills: SA(),
      notes: S('Everything else they said: team, responsibilities, why the role exists, process')
    }, ['title']),
    run: async (user, args) => {
      const role = await services.createRoleFromBrief(user, args);
      return { result: { roleId: role.id, title: role.title, mustHaveSkills: role.mustHaveSkills }, actions: [{ type: 'navigate', view: 'role', roleId: role.id, tab: 'jd' }] };
    }
  },
  {
    name: 'update_role', persona: 'hr', consent: true,
    description: 'Change fields of an existing role after the user confirms the change.',
    parameters: O({
      roleId: S(), title: S(), city: S(), workMode: S(), seniority: S(), experienceMin: N(), experienceMax: N(), salaryMin: N(), salaryMax: N(),
      mustHaveSkills: SA('Replaces the list'), niceToHaveSkills: SA('Replaces the list'), status: S('', { enum: ['Open', 'Paused', 'Closed'] })
    }, ['roleId']),
    run: (user, { roleId, ...patch }) => ({ result: { updated: true, title: services.updateRole(user, roleId, patch).title }, actions: [{ type: 'refresh', what: 'role' }] })
  },
  {
    name: 'source_candidates', persona: 'hr',
    description: 'Rank the talent pool for a role and show it on the Sourcing tab. Set deep=true for an AI re-rank with written reasoning (slower).',
    parameters: O({ roleId: S(), deep: B() }, ['roleId']),
    run: async (user, args) => {
      const sourcing = await services.sourceForRole(user, args.roleId, { deep: Boolean(args.deep) });
      return {
        result: { poolSize: sourcing.poolSize, top: sourcing.results.slice(0, 8).map((item) => ({ ...shortCandidate(item.candidate), score: item.score, why: item.aiSummary || item.reasons.join('; '), gaps: item.gaps, stage: item.stage })) },
        actions: [{ type: 'navigate', view: 'role', roleId: args.roleId, tab: 'sourcing' }, { type: 'sourcing', data: sourcing }]
      };
    }
  },
  {
    name: 'search_talent_pool', persona: 'hr',
    description: 'Search everyone in the talent pool by keywords (skills, title, city, name).',
    parameters: O({ query: S() }, ['query']),
    run: (user, args) => ({ result: { candidates: services.talentPool(user, { query: args.query }).slice(0, 10).map(shortCandidate) } })
  },
  {
    name: 'get_pipeline', persona: 'hr',
    description: 'Read the pipeline, optionally for one role.',
    parameters: O({ roleId: S() }),
    run: (user, args) => ({
      result: { pipeline: services.getPipeline(user, args.roleId).slice(0, 30).map((entry) => ({ candidateId: entry.candidateId, name: entry.candidate?.name, roleId: entry.roleId, roleTitle: entry.roleTitle, stage: entry.stage, screening: entry.screening?.summary })) },
      actions: args.roleId ? [{ type: 'navigate', view: 'role', roleId: args.roleId, tab: 'pipeline' }] : []
    })
  },
  {
    name: 'move_candidate', persona: 'hr',
    description: 'Add a candidate to a role\'s pipeline or move them to a stage. Only when the user directly asks for this named candidate and role.',
    parameters: O({ roleId: S(), candidateId: S(), stage: S('', { enum: services.STAGES }), note: S() }, ['roleId', 'candidateId', 'stage']),
    run: (user, args) => {
      const entry = services.moveCandidate(user, args);
      return { result: { name: entry.candidate?.name, stage: entry.stage }, actions: [{ type: 'refresh', what: 'role' }] };
    }
  },
  {
    name: 'add_note', persona: 'hr',
    description: 'Add a note to a candidate\'s application for a role.',
    parameters: O({ roleId: S(), candidateId: S(), note: S() }, ['roleId', 'candidateId', 'note']),
    run: (user, args) => {
      services.addNote(user, args);
      return { result: { saved: true }, actions: [{ type: 'refresh', what: 'role' }] };
    }
  },
  {
    name: 'draft_outreach', persona: 'hr',
    description: 'Write a personalised outreach email and short message to a candidate for a role, and show it on screen.',
    parameters: O({ roleId: S(), candidateId: S() }, ['roleId', 'candidateId']),
    run: async (user, args) => {
      const draft = await services.draftOutreach(user, args);
      return { result: { subject: draft.subject, shortMessage: draft.shortMessage }, actions: [{ type: 'outreach', ...args, draft }] };
    }
  },
  {
    name: 'request_introduction', persona: 'hr', consent: true,
    description: 'Ask a platform candidate (canRequestIntro=true) if they want an introduction for a role. Only after explicit confirmation of the candidate and role.',
    parameters: O({ roleId: S(), candidateId: S(), message: S('Short personal note to the candidate') }, ['roleId', 'candidateId']),
    run: (user, args) => ({ result: { status: services.requestIntro(user, args).status }, actions: [{ type: 'refresh', what: 'role' }] })
  },
  {
    name: 'schedule_interview', persona: 'hr', consent: true,
    description: 'Schedule an interview and move the candidate to the interview stage, after confirming candidate, role, date and time.',
    parameters: O({
      roleId: S(), candidateId: S(), startsAt: S('ISO 8601 with offset, e.g. 2026-10-21T15:00:00+05:30'), durationMins: N(),
      mode: S('Video, Phone or Onsite'), panel: SA('Interviewer names'), location: S('Meeting link or address'), notes: S()
    }, ['roleId', 'candidateId', 'startsAt']),
    run: (user, args) => {
      const interview = services.scheduleInterview(user, args);
      return { result: { scheduled: true, interviewId: interview.id, startsAt: interview.startsAt }, actions: [{ type: 'refresh', what: 'interviews' }, { type: 'toast', text: `Interview booked with ${interview.candidateName}` }] };
    }
  },
  {
    name: 'list_interviews', persona: 'hr',
    description: 'List scheduled interviews.',
    parameters: O({}),
    run: (user) => ({ result: { interviews: services.listInterviews(user).slice(-20).map(({ id, candidateName, roleTitle, startsAt, mode }) => ({ interviewId: id, candidateName, roleTitle, startsAt, mode })) }, actions: [{ type: 'navigate', view: 'interviews' }] })
  },
  {
    name: 'get_interview_kit', persona: 'hr',
    description: 'Generate or show the screening questions, scorecard and interview plan for a role.',
    parameters: O({ roleId: S() }, ['roleId']),
    run: async (user, args) => {
      const kit = await services.getInterviewKit(user, args.roleId);
      return { result: { screeningQuestions: (kit.screeningQuestions || []).map((item) => item.question), plan: kit.interviewPlan }, actions: [{ type: 'navigate', view: 'role', roleId: args.roleId, tab: 'kit' }] };
    }
  },
  {
    name: 'get_sourcing_strings', persona: 'hr',
    description: 'Generate Boolean search strings for LinkedIn, Naukri, GitHub and Google X-ray, plus target companies.',
    parameters: O({ roleId: S() }, ['roleId']),
    run: async (user, args) => {
      const plan = await services.getSourcingPlan(user, args.roleId);
      return { result: { idealProfile: plan.idealProfile, targetCompanies: plan.targetCompanies }, actions: [{ type: 'navigate', view: 'role', roleId: args.roleId, tab: 'sourcing' }] };
    }
  },
  {
    name: 'draft_offer', persona: 'hr',
    description: 'Draft an offer letter for a candidate in the pipeline and show it on screen.',
    parameters: O({ roleId: S(), candidateId: S(), ctc: N('Annual CTC in lakh rupees'), joiningDate: S(), extras: S('Joining bonus, ESOPs, etc.') }, ['roleId', 'candidateId']),
    run: async (user, args) => {
      const offer = await services.draftOffer(user, args);
      return { result: { drafted: true, subject: offer.subject }, actions: [{ type: 'offer', ...args, offer }] };
    }
  },

  // ---------- shared ----------
  {
    name: 'navigate', persona: 'both',
    description: 'Show a screen in the app. Candidate views: profile, opportunities, applications. Hiring views: overview, roles, role (needs roleId; tab = jd, sourcing, pipeline or kit), talent, interviews.',
    parameters: O({ view: S('', { enum: [...new Set([...CANDIDATE_VIEWS, ...HR_VIEWS])] }), roleId: S(), tab: S('', { enum: ROLE_TABS }) }, ['view']),
    run: (user, args) => ({ result: { shown: args.view }, actions: [{ type: 'navigate', ...args }] })
  },
  {
    name: 'end_voice_session', persona: 'both', voiceOnly: true,
    description: 'End the voice conversation after saying goodbye, when the user asks to stop.',
    parameters: O({}),
    run: () => ({ result: { ended: true }, actions: [{ type: 'endSession' }] })
  }
];

const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

function toolsFor(persona, { voice = false } = {}) {
  return tools.filter((tool) => (tool.persona === persona || tool.persona === 'both') && (voice || !tool.voiceOnly));
}

function declarationsFor(persona, options) {
  return toolsFor(persona, options).map(({ name, description, parameters }) => ({ name, description, parameters }));
}

function hasExplicitConsent(text) {
  return /\b(yes|yeah|yep|yup|sure|correct|confirm(ed)?|go ahead|proceed|do it|please do|save it|sounds good|ok(ay)?|haan|ha|theek hai|bilkul|send it|book it|apply|approved?)\b/i.test(String(text || ''));
}

async function runTool(user, persona, name, args = {}, utterance = '') {
  const tool = toolsByName.get(name);
  if (!tool || (tool.persona !== persona && tool.persona !== 'both')) throw new services.HttpError(404, `Unknown action: ${name}`);
  if (tool.consent && !hasExplicitConsent(utterance)) {
    return { result: { error: 'Not done yet. Read back exactly what you are about to do and wait for the user to explicitly say yes before calling this again.' }, actions: [] };
  }
  const output = await tool.run(user, args);
  return { result: output.result, actions: output.actions || [] };
}

// ---------- prompts ----------

function istNow() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const SHARED_RULES = `Speak naturally, warmly and briefly — one question at a time, like a sharp human recruiter on a call. Acknowledge what you heard before moving on, and never re-ask something already answered. Indian context: salaries are in lakh rupees per annum (LPA); people may mix Hindi and English, and you can do the same if they do. Use tools to look things up instead of guessing ids. When a tool returns an error, explain it plainly and recover. Tools marked as needing confirmation must be preceded by a one-sentence read-back and an explicit yes. Never make or recommend decisions based on gender, age, religion, caste, marital status, disability or other protected characteristics. If the user wants to stop, say goodbye and call end_voice_session (voice only). It is now ${istNow()} IST.`;

function candidateContext(user) {
  const { profile, completeness } = services.getMyProfile(user);
  return `The user is ${profile?.name || user.name || 'a candidate'}. Current profile: ${JSON.stringify(compactProfile(profile) || {})}. Completeness ${completeness.percent}%. Missing: ${completeness.missing.join(', ') || 'nothing'}.`;
}

function hrContext(user) {
  const roles = services.listMyRoles(user).slice(0, 15).map(({ id, title, city, status, inPipeline }) => ({ roleId: id, title, city, status, inPipeline }));
  const company = services.listMyCompanies(user)[0];
  return `The user is ${user.name || 'a recruiter'}${company ? ` at ${company.name} (${[company.industry, company.stage, company.city].filter(Boolean).join(', ')})` : ' and has not set up a company yet'}. Their roles: ${JSON.stringify(roles)}.`;
}

function instructions(user, mode, extra = {}) {
  if (mode === 'jack-interview') {
    return `You are Jack, an AI career agent for professionals in India, running a 10-minute get-to-know-you interview to build the candidate's profile. ${SHARED_RULES}
${candidateContext(user)}
Plan: briefly say what you'll cover, then focus on what's missing or thin. Go through, in a natural order: what they do now and the scope of it; their 2-3 most recent roles with one concrete, quantified win each; their strongest skills (probe depth: "how have you used X?"); what they want next (roles, company stage, domain); location, work mode, salary expectation and notice period; deal-breakers. Dig with one good follow-up when an answer is vague. Call update_my_profile after each topic with what you learnt (including interviewInsights), so nothing is lost. Do not read the whole profile back. At the end, give a two-sentence summary of how you'd pitch them, ask if they want to be discoverable to hiring teams (call set_discoverable only on an explicit yes), and offer to find matching roles.`;
  }
  if (mode === 'jack-screening') {
    let role;
    try {
      role = services.publicRole(user, extra.roleId);
    } catch (error) {
      role = null;
    }
    return `You are Jack, running a short voice screening for a specific role on behalf of the candidate. ${SHARED_RULES}
${candidateContext(user)}
ROLE: ${JSON.stringify(role && { roleId: role.id, title: role.title, company: role.companyName, mustHaveSkills: role.mustHaveSkills, responsibilities: role.responsibilities, experience: [role.experienceMin, role.experienceMax], salary: [role.salaryMin, role.salaryMax], workMode: role.workMode, city: role.city })}
Explain that this is a 5-minute screening whose summary will be shared with the hiring team only if they agree. Ask 4-5 job-related questions, one at a time: their most relevant experience for the must-have skills (ask for a specific example), one deeper technical/functional question, why this role, and practicalities (notice period, location/work mode fit, salary alignment). Be encouraging, never evaluative out loud. At the end, ask "Shall I share this summary with ${role?.companyName || 'the team'}?" and only on an explicit yes call submit_screening with faithful summaries (no embellishment).`;
  }
  if (mode === 'jill') {
    return `You are Jill, an AI hiring partner for recruiters and founders in India. You can run their whole hiring loop by voice: set up the company, write or change job descriptions, source and rank candidates, manage the pipeline, draft outreach and offers, request intros and book interviews. ${SHARED_RULES}
${hrContext(user)}${extra.roleId ? ` They are currently looking at roleId ${extra.roleId}.` : ''}
To create a role, gather: title, seniority & years, city & work mode, salary band, 3-6 must-have skills, nice-to-haves, and what the person will actually do and why the role exists. Ask only for what's missing, then read a one-sentence summary back and call create_role on a yes. Proactively suggest the next useful step (e.g. after creating a role, offer to source candidates; after sourcing, offer outreach or intros to the top people). When referring to candidates, use names and one key reason. Use navigate to show the user what you're talking about.`;
  }
  return `You are Jack, an AI career agent for professionals in India. You help them build a strong profile, find roles that genuinely fit, apply, prep for interviews and handle introductions from companies. ${SHARED_RULES}
${candidateContext(user)}
If the profile is thin, suggest the get-to-know-you interview or ask the most valuable missing questions yourself and save answers with update_my_profile. Use find_opportunities to discuss matches honestly, including gaps. Use navigate to show the user what you're talking about.`;
}

function personaForMode(mode) {
  return mode === 'jill' ? 'hr' : 'candidate';
}

// ---------- typed command bar ----------

async function runTextAgent(user, { persona, message, history = [], context = {} }) {
  const mode = persona === 'hr' ? 'jill' : 'jack';
  const contents = history.slice(-12).map((turn) => ({ role: turn.role === 'model' ? 'model' : 'user', parts: [{ text: String(turn.text || '').slice(0, 4000) }] }));
  contents.push({ role: 'user', parts: [{ text: String(message || '').slice(0, 4000) }] });
  const config = {
    systemInstruction: `${instructions(user, mode, context)}\nThis is a typed command bar, not voice: keep replies to 1-3 short sentences and act immediately when the request is clear. A direct typed instruction such as "move Priya to interview" counts as the request; tools that need confirmation still need a typed yes.`,
    tools: [{ functionDeclarations: declarationsFor(persona) }],
    temperature: 0.4
  };
  const actions = [];
  for (let step = 0; step < 6; step += 1) {
    const response = await generateContent({ contents, config });
    const calls = response.functionCalls || [];
    if (!calls.length) return { reply: response.text || 'Done.', actions };
    contents.push(response.candidates[0].content);
    const parts = [];
    for (const call of calls) {
      try {
        const output = await runTool(user, persona, call.name, call.args || {}, message);
        actions.push(...output.actions);
        parts.push({ functionResponse: { id: call.id, name: call.name, response: { result: output.result } } });
      } catch (error) {
        parts.push({ functionResponse: { id: call.id, name: call.name, response: { error: error.message } } });
      }
    }
    contents.push({ role: 'user', parts });
  }
  return { reply: 'I took several steps on that — check the screen for results.', actions };
}

module.exports = { declarationsFor, runTool, instructions, personaForMode, runTextAgent };
