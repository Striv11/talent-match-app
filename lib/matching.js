const { embed, cosine } = require('./ai');

const ALIASES = {
  js: 'javascript', 'java script': 'javascript', es6: 'javascript',
  ts: 'typescript',
  reactjs: 'react', 'react.js': 'react',
  nextjs: 'next.js', next: 'next.js',
  vuejs: 'vue', 'vue.js': 'vue',
  angularjs: 'angular',
  node: 'node.js', nodejs: 'node.js',
  expressjs: 'express', 'express.js': 'express',
  golang: 'go',
  py: 'python',
  postgres: 'postgresql', psql: 'postgresql',
  mongo: 'mongodb',
  k8s: 'kubernetes',
  gcp: 'google cloud', 'google cloud platform': 'google cloud',
  'amazon web services': 'aws',
  ml: 'machine learning',
  dl: 'deep learning',
  nlp: 'natural language processing',
  llm: 'llms', 'large language models': 'llms',
  genai: 'generative ai', 'gen ai': 'generative ai',
  'ci/cd': 'ci cd', cicd: 'ci cd',
  rn: 'react native',
  'ui/ux': 'ux design', ux: 'ux design',
  pm: 'product management',
  sql: 'sql',
  'spring boot': 'spring', springboot: 'spring'
};

function normalizeSkill(skill) {
  const cleaned = String(skill || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[.,;:]+$/, '');
  return ALIASES[cleaned] || cleaned;
}

function skillCoverage(candidateSkills, wanted) {
  const have = (candidateSkills || []).map(normalizeSkill).filter(Boolean);
  const matched = [];
  const missing = [];
  let credit = 0;
  (wanted || []).forEach((skill) => {
    const target = normalizeSkill(skill);
    if (!target) return;
    if (have.includes(target)) {
      credit += 1;
      matched.push(skill);
    } else if (have.some((item) => item.length > 2 && target.length > 2 && (item.includes(target) || target.includes(item)))) {
      credit += 0.6;
      matched.push(skill);
    } else {
      missing.push(skill);
    }
  });
  return { ratio: wanted?.length ? credit / wanted.length : null, matched, missing };
}

const lower = (value) => String(value || '').toLowerCase().trim();

function structuredScore(candidate, role) {
  const reasons = [];
  const gaps = [];
  let score = 0;

  const must = skillCoverage(candidate.skills, role.mustHaveSkills);
  const nice = skillCoverage(candidate.skills, role.niceToHaveSkills);
  score += (must.ratio ?? 0.5) * 40;
  score += (nice.ratio ?? 0.5) * 10;
  if (must.matched.length) reasons.push(`Has ${must.matched.slice(0, 4).join(', ')}`);
  if (must.missing.length) gaps.push(`No evidence of ${must.missing.slice(0, 3).join(', ')}`);

  const years = Number(candidate.experienceYears);
  const minYears = Number.isFinite(role.experienceMin) ? role.experienceMin : null;
  const maxYears = Number.isFinite(role.experienceMax) ? role.experienceMax : null;
  if (!Number.isFinite(years) || (minYears === null && maxYears === null)) {
    score += 9;
  } else if ((minYears === null || years >= minYears) && (maxYears === null || years <= maxYears + 1)) {
    score += 15;
    reasons.push(`${years} yrs fits the level`);
  } else {
    const distance = minYears !== null && years < minYears ? minYears - years : years - (maxYears ?? years);
    score += Math.max(0, 15 - distance * 4);
    gaps.push(years < (minYears ?? 0) ? `${years} yrs vs ${minYears}+ wanted` : `${years} yrs may be senior for the band`);
  }

  const expectation = Number(candidate.salaryExpectation);
  if (!Number.isFinite(expectation) || !role.salaryMax) {
    score += 6;
  } else if (expectation <= role.salaryMax) {
    score += 10;
    reasons.push('Salary expectation within band');
  } else if (expectation <= role.salaryMax * 1.15) {
    score += 5;
    gaps.push('Salary expectation slightly above band');
  } else {
    gaps.push('Salary expectation above band');
  }

  const roleCity = lower(role.city);
  const roleMode = lower(role.workMode);
  const candidateMode = lower(candidate.workMode);
  const cities = [candidate.city, ...(candidate.preferredCities || [])].map(lower);
  if (roleMode === 'remote' && (!candidateMode || candidateMode === 'remote' || candidateMode === 'hybrid')) {
    score += 10;
    reasons.push('Remote role suits them');
  } else if (roleCity && cities.some((city) => city && (city.includes(roleCity) || roleCity.includes(city)))) {
    score += candidateMode === 'remote' && roleMode !== 'remote' ? 6 : 10;
    reasons.push(lower(candidate.city) === roleCity ? `Based in ${role.city}` : `Open to ${role.city}`);
  } else if (cities.some((city) => /anywhere|any|open|relocat/.test(city))) {
    score += 7;
  } else {
    score += 2;
    gaps.push(`Location: ${candidate.city || 'unknown'} vs ${role.city}`);
  }

  return { score, reasons, gaps, matchedSkills: must.matched, missingSkills: must.missing };
}

function candidateText(candidate) {
  return [
    candidate.headline,
    candidate.currentTitle,
    `Skills: ${(candidate.skills || []).join(', ')}`,
    candidate.summary,
    ...(candidate.experience || []).slice(0, 4).map((item) => `${item.title} at ${item.company}: ${(item.highlights || []).join('; ')}`),
    (candidate.targetRoles || []).length ? `Wants: ${candidate.targetRoles.join(', ')}` : ''
  ].filter(Boolean).join('\n');
}

function roleText(role) {
  return [
    role.title,
    role.seniority,
    `Must have: ${(role.mustHaveSkills || []).join(', ')}`,
    `Nice to have: ${(role.niceToHaveSkills || []).join(', ')}`,
    ...(role.responsibilities || []).slice(0, 8),
    role.summary
  ].filter(Boolean).join('\n');
}

async function safeEmbed(text) {
  try {
    return await embed(text);
  } catch (error) {
    return null;
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
}

// Structured fit is worth 85 points; semantic similarity of the full profile
// against the role adds up to 15 more. When embeddings are unavailable the
// structured score is scaled to 100 so rankings stay comparable.
function combine(structured, similarity) {
  if (similarity === null) return Math.round(Math.min(100, structured.score * (100 / 85)));
  const semantic = Math.max(0, Math.min(1, (similarity - 0.55) / 0.3));
  return Math.round(Math.min(100, structured.score + semantic * 15));
}

async function rankCandidatesForRole(role, candidates) {
  const roleVector = await safeEmbed(roleText(role));
  const scored = await mapLimit(candidates, 6, async (candidate) => {
    const structured = structuredScore(candidate, role);
    const vector = roleVector ? await safeEmbed(candidateText(candidate)) : null;
    const similarity = roleVector && vector ? cosine(roleVector, vector) : null;
    return { candidate, ...structured, score: combine(structured, similarity) };
  });
  return scored.sort((a, b) => b.score - a.score);
}

async function rankRolesForCandidate(candidate, roles) {
  const candidateVector = await safeEmbed(candidateText(candidate));
  const scored = await mapLimit(roles, 6, async (role) => {
    const structured = structuredScore(candidate, role);
    const vector = candidateVector ? await safeEmbed(roleText(role)) : null;
    const similarity = candidateVector && vector ? cosine(candidateVector, vector) : null;
    return { role, ...structured, score: combine(structured, similarity) };
  });
  return scored.sort((a, b) => b.score - a.score);
}

module.exports = { rankCandidatesForRole, rankRolesForCandidate, structuredScore, normalizeSkill };
