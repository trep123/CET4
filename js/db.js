// SQLite（sql.js）数据层：建表、持久化到 IndexedDB、备份/恢复
import { getSQL } from './sqlite.js';

const IDB_NAME = 'wordsprint';
const IDB_STORE = 'sqlite';
const IDB_KEY = 'main';

let SQL = null;
let db = null;

export const nowIso = () => new Date().toISOString();

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet() {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const r = d.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(IDB_KEY);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}
async function idbPut(bytes) {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(bytes, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS words (
  id INTEGER PRIMARY KEY,
  word VARCHAR(120) NOT NULL UNIQUE,
  ipa_uk VARCHAR(160) DEFAULT '',
  ipa_us VARCHAR(160) DEFAULT '',
  meaning_zh TEXT NOT NULL,
  example_en TEXT DEFAULT '',
  example_zh TEXT DEFAULT '',
  level VARCHAR(40) DEFAULT 'CET-4',
  tags VARCHAR(300) DEFAULT '',
  source VARCHAR(80) DEFAULT 'starter',
  active BOOLEAN DEFAULT 1,
  created_at VARCHAR(40) NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_words_word ON words(word);
CREATE TABLE IF NOT EXISTS review_states (
  id INTEGER PRIMARY KEY,
  word_id INTEGER NOT NULL UNIQUE REFERENCES words(id) ON DELETE CASCADE,
  repetitions INTEGER DEFAULT 0,
  interval_days FLOAT DEFAULT 0,
  ease_factor FLOAT DEFAULT 2.5,
  due_at VARCHAR(40),
  last_reviewed_at VARCHAR(40),
  last_rating VARCHAR(20),
  lapses INTEGER DEFAULT 0,
  total_reviews INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_states_due ON review_states(due_at);
CREATE TABLE IF NOT EXISTS review_logs (
  id INTEGER PRIMARY KEY,
  word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  reviewed_at VARCHAR(40) NOT NULL,
  rating VARCHAR(20) NOT NULL,
  was_correct BOOLEAN NOT NULL,
  mode VARCHAR(20) NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_logs_word ON review_logs(word_id);
CREATE INDEX IF NOT EXISTS ix_logs_time ON review_logs(reviewed_at);
CREATE TABLE IF NOT EXISTS seed_chunks (
  file VARCHAR(40) PRIMARY KEY,
  version VARCHAR(40) NOT NULL,
  loaded_at VARCHAR(40) NOT NULL
);
CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY,
  daily_new_count INTEGER DEFAULT 20,
  accent VARCHAR(10) DEFAULT 'en-US',
  show_example BOOLEAN DEFAULT 1,
  created_at VARCHAR(40),
  updated_at VARCHAR(40)
);
`;

const STARTER = [
  ['achieve', '/əˈtʃiːv/', '/əˈtʃiːv/', 'v. 实现；达到（目标）', 'She worked hard to achieve her goal.', '她努力实现自己的目标。', '核心动词'],
  ['abandon', '/əˈbændən/', '/əˈbændən/', 'v. 放弃；抛弃', 'They had to abandon the plan.', '他们不得不放弃这个计划。', '核心动词'],
  ['ability', '/əˈbɪləti/', '/əˈbɪləti/', 'n. 能力；才能', 'He has the ability to learn fast.', '他有快速学习的能力。', '名词'],
  ['available', '/əˈveɪləbl/', '/əˈveɪləbl/', 'adj. 可获得的；有空的', 'Tickets are available online.', '票可以在网上买到。', '形容词'],
  ['benefit', '/ˈbenɪfɪt/', '/ˈbenɪfɪt/', 'n. 益处 v. 有益于', 'Regular exercise will benefit your health.', '经常锻炼对健康有益。', '名词;动词'],
  ['challenge', '/ˈtʃælɪndʒ/', '/ˈtʃælɪndʒ/', 'n. 挑战 v. 向……挑战', 'Learning a language is a challenge.', '学习一门语言是一种挑战。', '名词'],
  ['consider', '/kənˈsɪdə(r)/', '/kənˈsɪdər/', 'v. 考虑；认为', 'Please consider my suggestion.', '请考虑一下我的建议。', '核心动词'],
  ['environment', '/ɪnˈvaɪrənmənt/', '/ɪnˈvaɪrənmənt/', 'n. 环境', 'We should protect the environment.', '我们应该保护环境。', '名词;话题'],
  ['opportunity', '/ˌɒpəˈtjuːnəti/', '/ˌɑːpərˈtuːnəti/', 'n. 机会', 'This is a great opportunity for you.', '这对你来说是个好机会。', '名词'],
  ['schedule', '/ˈʃedjuːl/', '/ˈskedʒuːl/', 'n. 日程表 v. 安排', 'The meeting is scheduled for Monday.', '会议安排在周一。', '名词;动词'],
];

function seedStarter() {
  const t = nowIso();
  {
    for (const w of STARTER) {
      db.run(
        `INSERT INTO words (word, ipa_uk, ipa_us, meaning_zh, example_en, example_zh, level, tags, source, active, created_at)
         VALUES (?,?,?,?,?,?,'CET-4',?,'starter',1,?)`,
        [...w, t]
      );
    }
  }
}

function seedSettings() {
  const t = nowIso();
  if (!get('SELECT id FROM app_settings WHERE id=1')) {
    db.run(`INSERT INTO app_settings (id, daily_new_count, accent, show_example, created_at, updated_at) VALUES (1,20,'en-US',1,?,?)`, [t, t]);
  }
}

// ---------- 按需加载的内置词库 ----------
// data/words/manifest.json 列出分包（每包 500 词，按词频排序）。首次只加载第 1 包，
// 新词不够、搜索、导出、巡览全部词汇时再加载后续分包。已加载分包记录在 seed_chunks 表；
// manifest 版本变化时自动用新内容更新已加载的分包（学习进度保留）。
const SEED_DIR = 'data/words/';
let manifest = null;

async function fetchManifest() {
  try {
    const res = await fetch(`${SEED_DIR}manifest.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    return await res.json();
  } catch (e) {
    console.warn('词库清单加载失败', e);
    return null;
  }
}

function loadedChunks() {
  return Object.fromEntries(all('SELECT file, version FROM seed_chunks').map((r) => [r.file, r.version]));
}

async function loadChunk(chunk) {
  const res = await fetch(`${SEED_DIR}${chunk.file}?v=${manifest.version}`);
  if (!res.ok) throw new Error(`词库分包 ${chunk.file} 加载失败`);
  const part = new SQL.Database(new Uint8Array(await res.arrayBuffer()));
  const st = part.prepare('SELECT word, ipa_uk, ipa_us, meaning_zh, level, tags, source FROM words ORDER BY id');
  const t = nowIso();
  transaction(() => {
    while (st.step()) {
      const w = st.getAsObject();
      const exist = get('SELECT id FROM words WHERE word=?', [w.word]);
      if (exist) {
        db.run(`UPDATE words SET ipa_uk=COALESCE(NULLIF(?,''), ipa_uk), ipa_us=COALESCE(NULLIF(?,''), ipa_us), meaning_zh=?, level=?, tags=?, active=1 WHERE id=?`,
          [w.ipa_uk, w.ipa_us, w.meaning_zh, w.level, w.tags, exist.id]);
      } else {
        db.run(`INSERT INTO words (word, ipa_uk, ipa_us, meaning_zh, example_en, example_zh, level, tags, source, active, created_at)
                VALUES (?,?,?,?,'','',?,?,?,1,?)`, [w.word, w.ipa_uk, w.ipa_us, w.meaning_zh, w.level, w.tags, w.source, t]);
      }
    }
    db.run('INSERT OR REPLACE INTO seed_chunks (file, version, loaded_at) VALUES (?,?,?)', [chunk.file, manifest.version, t]);
  });
  st.free();
  part.close();
}

let loading = Promise.resolve();
// 串行执行，避免同一分包被并发加载两次
function serial(fn) {
  const run = loading.then(fn, fn);
  loading = run.catch(() => {});
  return run;
}

/** 尚未加载的分包及其词数 */
export function seedStatus() {
  if (!manifest) return { total: 0, pending: 0, pendingChunks: 0, chunks: 0 };
  const done = loadedChunks();
  const rest = manifest.chunks.filter((c) => done[c.file] !== manifest.version);
  return { total: manifest.total, pending: rest.reduce((n, c) => n + c.count, 0), pendingChunks: rest.length, chunks: manifest.chunks.length };
}

/** 按顺序再加载 n 个分包（n=Infinity 为全部），onProgress(已完成, 总数) */
export function loadMoreChunks(n = 1, onProgress) {
  return serial(async () => {
    if (!manifest) return 0;
    const done = loadedChunks();
    const rest = manifest.chunks.filter((c) => done[c.file] !== manifest.version).slice(0, n);
    let i = 0;
    for (const c of rest) {
      await loadChunk(c);
      onProgress?.(++i, rest.length);
    }
    if (rest.length) await persist();
    return rest.length;
  });
}

async function initSeed() {
  manifest = await fetchManifest();
  if (!manifest) return;
  // 兼容旧版本：之前已一次性合并完整词库的浏览器，直接标记全部分包为已加载
  if (get('PRAGMA user_version').user_version >= 1 && !get('SELECT 1 FROM seed_chunks LIMIT 1') && get("SELECT 1 FROM words WHERE source='cet4-5278' LIMIT 1")) {
    const t = nowIso();
    for (const c of manifest.chunks) db.run('INSERT OR REPLACE INTO seed_chunks (file, version, loaded_at) VALUES (?,?,?)', [c.file, manifest.version, t]);
  }
  if (get('PRAGMA user_version').user_version < 2) {
    db.run("UPDATE app_settings SET accent='en-US', updated_at=? WHERE id=1", [nowIso()]);
    db.run('PRAGMA user_version=2');
  }
  const done = loadedChunks();
  const stale = manifest.chunks.filter((c) => done[c.file] && done[c.file] !== manifest.version);
  for (const c of stale) await loadChunk(c); // 词库内容更新：只刷新已加载过的分包
  if (!Object.keys(done).length) await loadChunk(manifest.chunks[0]); // 首次只加载第 1 包
}

export async function openDb() {
  SQL = await getSQL();
  const bytes = await idbGet();
  db = bytes ? new SQL.Database(new Uint8Array(bytes)) : new SQL.Database();
  db.run('PRAGMA foreign_keys=ON');
  db.exec(SCHEMA);
  const fresh = !get('SELECT 1 FROM app_settings WHERE id=1');
  if (fresh) seedSettings();
  await initSeed();
  if (!get('SELECT 1 FROM words LIMIT 1')) seedStarter(); // 词库清单不可用时的兜底示例词
  await persist();
  return { fresh };
}

// 每次写操作后整库导出存入 IndexedDB；export 会重置 PRAGMA，需重新开启外键
let saving = Promise.resolve();
export function persist() {
  const bytes = db.export();
  db.run('PRAGMA foreign_keys=ON');
  saving = saving.then(() => idbPut(bytes));
  return saving;
}

export function all(sql, params = []) {
  const st = db.prepare(sql);
  st.bind(params);
  const rows = [];
  while (st.step()) rows.push(st.getAsObject());
  st.free();
  return rows;
}
export function get(sql, params = []) {
  return all(sql, params)[0] || null;
}
export function run(sql, params = []) {
  db.run(sql, params);
}
export function transaction(fn) {
  db.run('BEGIN');
  try {
    const r = fn();
    db.run('COMMIT');
    return r;
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

export function health() {
  const tables = all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r) => r.name);
  return { ok: true, sqlite: get('SELECT sqlite_version() AS v').v, tables };
}

// 备份：导出完整 SQLite 文件
export function exportBytes() {
  const bytes = db.export();
  db.run('PRAGMA foreign_keys=ON');
  return bytes;
}

// 恢复：校验是否为本应用的数据库后替换
export async function restoreBytes(bytes) {
  const test = new SQL.Database(new Uint8Array(bytes));
  const names = new Set();
  const res = test.exec("SELECT name FROM sqlite_master WHERE type='table'");
  (res[0]?.values || []).forEach((v) => names.add(v[0]));
  for (const t of ['words', 'review_states', 'review_logs', 'app_settings']) {
    if (!names.has(t)) {
      test.close();
      throw new Error(`不是有效的 WordSprint 数据库（缺少表 ${t}）`);
    }
  }
  db.close();
  db = test;
  db.run('PRAGMA foreign_keys=ON');
  db.exec(SCHEMA);
  seedSettings();
  await initSeed();
  await persist();
}
