const crypto = require('crypto');
const { GoogleGenAI } = require('@google/genai');
const { embeddings, saveEmbeddings } = require('./store');

const TEXT_MODELS = [...new Set([
  process.env.GEMINI_TEXT_MODEL || 'gemini-3.8-flash',
  'gemini-3.5-flash',
  'gemini-flash-latest',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite'
])];
const EMBEDDING_MODELS = ['gemini-embedding-2', 'gemini-embedding-001'];
const RETRYABLE = new Set([404, 429, 500, 502, 503, 504]);
const coolingUntil = new Map();

class AIError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

let client = null;
function getClient() {
  if (!process.env.GEMINI_API_KEY) throw new AIError('AI is not configured. Set GEMINI_API_KEY on the server.', 503);
  client ||= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

function statusOf(error) {
  return error.status || Number(String(error.message).match(/"code":\s*(\d+)/)?.[1]) || 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Tries each model in turn, and parks a model for a minute after it reports
// overload so later calls go straight to one that is answering.
async function withModelFallback(models, call) {
  const available = models.filter((model) => (coolingUntil.get(model) || 0) < Date.now());
  const order = available.length ? available : models;
  let lastError;
  for (const model of order) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await call(model);
      } catch (error) {
        lastError = error;
        if (error instanceof AIError || !RETRYABLE.has(statusOf(error))) throw error;
        if (attempt === 0 && statusOf(error) !== 404) await sleep(500);
      }
    }
    coolingUntil.set(model, Date.now() + 60 * 1000);
  }
  console.error('All AI models failed:', lastError?.message);
  throw new AIError('The AI service is busy right now. Please try again in a moment.');
}

function fileParts(files = []) {
  return files.map((file) => ({ inlineData: { mimeType: file.mimeType, data: file.data } }));
}

async function generateContent(request) {
  return withModelFallback(TEXT_MODELS, (model) => getClient().models.generateContent({ model, ...request }));
}

async function generateJSON({ system, prompt, schema, files, temperature = 0.4 }) {
  const response = await generateContent({
    contents: [{ role: 'user', parts: [...fileParts(files), { text: prompt }] }],
    config: {
      systemInstruction: system,
      responseMimeType: 'application/json',
      responseSchema: schema,
      temperature
    }
  });
  try {
    return JSON.parse(response.text);
  } catch (error) {
    throw new AIError('The AI returned an unreadable answer. Please try again.');
  }
}

function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

async function embed(text, taskType = 'SEMANTIC_SIMILARITY') {
  const key = crypto.createHash('sha1').update(`${taskType}:${text}`).digest('hex');
  if (embeddings[key]) return embeddings[key];
  const vector = await withModelFallback(EMBEDDING_MODELS, async (model) => {
    const result = await getClient().models.embedContent({
      model,
      contents: text.slice(0, 8000),
      config: { taskType, outputDimensionality: 768 }
    });
    return result.embeddings[0].values;
  });
  embeddings[key] = vector.map((value) => Number(value.toFixed(5)));
  saveEmbeddings();
  return embeddings[key];
}

const S = (description) => ({ type: 'STRING', ...(description ? { description } : {}) });
const N = (description) => ({ type: 'NUMBER', ...(description ? { description } : {}) });
const A = (items, description) => ({ type: 'ARRAY', items, ...(description ? { description } : {}) });
const O = (properties, required) => ({ type: 'OBJECT', properties, ...(required ? { required } : {}) });

const candidateProfileSchema = O({
  name: S(),
  email: S(),
  phone: S(),
  linkedinUrl: S(),
  headline: S('One-line professional headline, e.g. "Backend engineer · payments & distributed systems"'),
  summary: S('3-4 sentence third-person professional summary'),
  city: S(),
  currentTitle: S(),
  currentCompany: S(),
  experienceYears: N('Total years of professional experience'),
  skills: A(S(), 'Concrete skills, tools and domains, most important first, max 25'),
  experience: A(O({ title: S(), company: S(), start: S(), end: S('"Present" if current'), highlights: A(S()) })),
  education: A(O({ school: S(), degree: S(), year: S() })),
  achievements: A(S(), 'Quantified accomplishments'),
  targetRoles: A(S()),
  preferredCities: A(S()),
  workMode: S('Remote, Hybrid or Onsite'),
  salaryCurrent: N('Current CTC in lakh rupees per annum'),
  salaryExpectation: N('Expected CTC in lakh rupees per annum'),
  noticePeriod: S(),
  careerGoals: S()
}, ['name', 'skills', 'experience', 'education', 'achievements']);

const roleSchema = O({
  companyName: S(),
  title: S(),
  city: S(),
  workMode: S('Remote, Hybrid or Onsite'),
  seniority: S('Junior, Mid, Senior, Lead, Principal, Manager, Director'),
  experienceMin: N(),
  experienceMax: N(),
  salaryMin: N('Lakh rupees per annum'),
  salaryMax: N('Lakh rupees per annum'),
  mustHaveSkills: A(S()),
  niceToHaveSkills: A(S()),
  responsibilities: A(S()),
  summary: S('Two sentence pitch of the role'),
  jd: S('The full job description in Markdown')
}, ['title', 'mustHaveSkills', 'jd']);

const FACTS_ONLY = 'Use only facts present in the input. Omit any field you cannot find; never guess salaries, notice periods, contact details or demographic information.';

async function extractCandidateProfile({ text, file, hint }) {
  return generateJSON({
    system: `You are an expert Indian tech recruiter turning résumés and LinkedIn exports into structured profiles. ${FACTS_ONLY} Normalise skill names (e.g. "ReactJS" → "React"). Amounts in INR lakh per annum.`,
    prompt: `${hint || 'Extract the candidate profile.'}\n\n${text ? `SOURCE TEXT:\n${text.slice(0, 30000)}` : 'The source is the attached document.'}`,
    files: file ? [file] : [],
    schema: candidateProfileSchema,
    temperature: 0.1
  });
}

async function parseJobDescription({ text, file }) {
  return generateJSON({
    system: `You parse job descriptions for an Indian hiring platform into structured data. ${FACTS_ONLY} For "jd", return the original description cleaned into tidy Markdown without changing its meaning.`,
    prompt: text ? `JOB DESCRIPTION:\n${text.slice(0, 30000)}` : 'The job description is the attached document.',
    files: file ? [file] : [],
    schema: roleSchema,
    temperature: 0.1
  });
}

async function generateJobDescription(brief, company) {
  return generateJSON({
    system: 'You are a senior talent partner who writes crisp, inclusive, candidate-friendly job descriptions for Indian startups. Avoid gendered language, age limits, "rockstar/ninja" clichés and inflated requirements. Keep must-have skills to the genuine essentials (max 6).',
    prompt: `Write a complete job description and structured role from this hiring brief. Sections: About the company, The role, What you will do, What you bring, Nice to have, Compensation & benefits, Hiring process.\n\nCOMPANY: ${JSON.stringify(company || {})}\nBRIEF: ${JSON.stringify(brief)}`,
    schema: roleSchema,
    temperature: 0.6
  });
}

function anonymised(candidate) {
  return {
    candidateId: candidate.id,
    title: candidate.currentTitle,
    experienceYears: candidate.experienceYears,
    city: candidate.city,
    skills: candidate.skills,
    experience: (candidate.experience || []).slice(0, 4).map(({ title, start, end, highlights }) => ({ title, start, end, highlights: (highlights || []).slice(0, 3) })),
    achievements: (candidate.achievements || []).slice(0, 4),
    salaryExpectation: candidate.salaryExpectation,
    noticePeriod: candidate.noticePeriod,
    workMode: candidate.workMode
  };
}

async function rerankCandidates(role, candidates) {
  const result = await generateJSON({
    system: 'You are a rigorous, fair technical recruiter. Assess job-related fit only. Profiles are anonymised; never infer or consider gender, age, religion, caste, marital status or other protected characteristics. Be specific and evidence-based, and name real gaps.',
    prompt: `ROLE:\n${JSON.stringify({ title: role.title, seniority: role.seniority, experience: [role.experienceMin, role.experienceMax], mustHaveSkills: role.mustHaveSkills, niceToHaveSkills: role.niceToHaveSkills, responsibilities: role.responsibilities, city: role.city, workMode: role.workMode, salary: [role.salaryMin, role.salaryMax] })}\n\nCANDIDATES:\n${JSON.stringify(candidates.map(anonymised))}\n\nScore each candidate 0-100 for this role.`,
    schema: O({ rankings: A(O({ candidateId: S(), fitScore: N(), why: S('One sentence, evidence-based'), gaps: A(S()) }, ['candidateId', 'fitScore', 'why'])) }, ['rankings']),
    temperature: 0.2
  });
  return result.rankings || [];
}

async function sourcingPlan(role, company) {
  return generateJSON({
    system: 'You are an expert sourcer for the Indian tech market. Produce Boolean strings that actually work on each platform (LinkedIn Recruiter/basic search, Naukri Resdex keyword search, GitHub user search, Google X-ray). Include sensible synonyms and title variants.',
    prompt: `ROLE: ${JSON.stringify({ title: role.title, seniority: role.seniority, city: role.city, workMode: role.workMode, mustHaveSkills: role.mustHaveSkills, niceToHaveSkills: role.niceToHaveSkills })}\nCOMPANY: ${JSON.stringify({ name: company?.name, industry: company?.industry })}`,
    schema: O({
      idealProfile: S('Two sentence description of the ideal candidate'),
      linkedin: S(),
      naukri: S(),
      github: S(),
      googleXray: S(),
      targetCompanies: A(S(), 'Indian companies whose talent fits well'),
      titleVariants: A(S()),
      channels: A(S(), 'Communities, job boards and events worth posting in')
    }),
    temperature: 0.5
  });
}

async function interviewKit(role) {
  return generateJSON({
    system: 'You design structured, bias-resistant interview processes. Questions must be job-related and assess skills, not culture "fit" or personal life.',
    prompt: `Create an interview kit for: ${JSON.stringify({ title: role.title, seniority: role.seniority, mustHaveSkills: role.mustHaveSkills, responsibilities: role.responsibilities })}`,
    schema: O({
      screeningQuestions: A(O({ question: S(), lookFor: S('What a strong answer contains') })),
      scorecard: A(O({ competency: S(), description: S() })),
      interviewPlan: A(O({ stage: S(), focus: S(), durationMins: N() }))
    }),
    temperature: 0.5
  });
}

async function outreachDraft(role, company, candidate, senderName) {
  return generateJSON({
    system: 'You write short, specific, respectful recruiting outreach for Indian professionals. Reference 1-2 concrete things from their background, explain why this role, mention compensation range if known, and end with a low-friction ask. No hype, no emojis.',
    prompt: `ROLE: ${JSON.stringify({ title: role.title, city: role.city, workMode: role.workMode, salary: role.salaryMin && role.salaryMax ? `${role.salaryMin}-${role.salaryMax} LPA` : undefined, summary: role.summary })}\nCOMPANY: ${JSON.stringify({ name: company?.name, industry: company?.industry, stage: company?.stage })}\nCANDIDATE: ${JSON.stringify({ firstName: String(candidate.name || '').split(' ')[0], title: candidate.currentTitle, company: candidate.currentCompany, skills: (candidate.skills || []).slice(0, 8), achievements: (candidate.achievements || []).slice(0, 2) })}\nSENDER: ${senderName}`,
    schema: O({ subject: S(), email: S('Under 120 words'), shortMessage: S('LinkedIn/WhatsApp version under 300 characters') }, ['subject', 'email', 'shortMessage']),
    temperature: 0.7
  });
}

async function offerDraft(role, company, candidate, terms) {
  return generateJSON({
    system: 'You draft clear, warm offer letters for Indian companies. Use the provided terms exactly; put [placeholders] in square brackets for anything not provided. Not legal advice.',
    prompt: `COMPANY: ${JSON.stringify({ name: company?.name, city: company?.city })}\nROLE: ${JSON.stringify({ title: role.title, city: role.city, workMode: role.workMode })}\nCANDIDATE: ${candidate.name}\nTERMS: ${JSON.stringify(terms)}`,
    schema: O({ subject: S(), letter: S('Markdown offer letter') }, ['subject', 'letter']),
    temperature: 0.4
  });
}

async function interviewPrep(role, company, candidate) {
  return generateJSON({
    system: 'You are Jack, a candid career coach for Indian tech professionals. Give practical, specific preparation advice tied to the candidate\'s real experience.',
    prompt: `ROLE: ${JSON.stringify({ title: role.title, seniority: role.seniority, mustHaveSkills: role.mustHaveSkills, responsibilities: role.responsibilities, salary: [role.salaryMin, role.salaryMax] })}\nCOMPANY: ${JSON.stringify({ name: company?.name, industry: company?.industry, stage: company?.stage, about: company?.about })}\nCANDIDATE: ${JSON.stringify(anonymised(candidate))}`,
    schema: O({
      pitch: S('How the candidate should position themselves in 2-3 sentences'),
      likelyQuestions: A(O({ question: S(), tip: S() })),
      storiesToPrepare: A(S(), 'Specific stories from their background to prepare'),
      gapsToAddress: A(S()),
      questionsToAsk: A(S()),
      salaryNote: S('Negotiation guidance relative to the band')
    }),
    temperature: 0.6
  });
}

module.exports = {
  AIError,
  generateContent,
  generateJSON,
  embed,
  cosine,
  extractCandidateProfile,
  parseJobDescription,
  generateJobDescription,
  rerankCandidates,
  sourcingPlan,
  interviewKit,
  outreachDraft,
  offerDraft,
  interviewPrep
};
