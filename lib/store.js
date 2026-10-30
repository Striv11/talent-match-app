const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');
const EMBEDDINGS_PATH = path.join(DATA_DIR, 'embeddings.json');
const COLLECTIONS = ['candidates', 'companies', 'roles', 'applications', 'intros', 'interviews'];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

// The store lives in memory and is persisted on change, so concurrent async
// handlers never overwrite each other's writes.
const db = readJson(STORE_PATH, {});
COLLECTIONS.forEach((name) => { if (!Array.isArray(db[name])) db[name] = []; });
delete db.pipeline;
delete db.matchResponses;

const embeddings = readJson(EMBEDDINGS_PATH, {});

let saveTimer = null;
let embeddingTimer = null;

function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  writeJsonAtomic(STORE_PATH, db);
}

function save() {
  if (!saveTimer) saveTimer = setTimeout(flush, 50);
}

function saveEmbeddings() {
  clearTimeout(embeddingTimer);
  embeddingTimer = setTimeout(() => writeJsonAtomic(EMBEDDINGS_PATH, embeddings), 500);
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

function now() {
  return new Date().toISOString();
}

process.on('exit', () => { if (saveTimer) flush(); });
['SIGINT', 'SIGTERM'].forEach((signal) => process.on(signal, () => process.exit(0)));

flush();

module.exports = { db, save, flush, newId, now, embeddings, saveEmbeddings };
