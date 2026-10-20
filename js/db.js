// SQLite（sql.js）数据层：建表、持久化到 IndexedDB、备份/恢复
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
CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY,
  daily_new_count INTEGER DEFAULT 20,
  accent VARCHAR(10) DEFAULT 'en-GB',
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

function seed() {
  const n = get('SELECT COUNT(*) AS n FROM words').n;
  const t = nowIso();
  if (n === 0) {
    for (const w of STARTER) {
      db.run(
        `INSERT INTO words (word, ipa_uk, ipa_us, meaning_zh, example_en, example_zh, level, tags, source, active, created_at)
         VALUES (?,?,?,?,?,?,'CET-4',?,'starter',1,?)`,
        [...w, t]
      );
    }
  }
  if (!get('SELECT id FROM app_settings WHERE id=1')) {
    db.run(`INSERT INTO app_settings (id, daily_new_count, accent, show_example, created_at, updated_at) VALUES (1,20,'en-GB',1,?,?)`, [t, t]);
  }
}

// 内置词库 data/cet4.sqlite3（由 tools/build_seed.py 从 xlsx 生成）。
// 词库更新后把 SEED_VERSION 加 1，已有用户下次打开时自动合并（只更新词条，保留学习进度）。
export const SEED_VERSION = 1;
const SEED_URL = 'data/cet4.sqlite3';

async function mergeSeed() {
  const cur = get('PRAGMA user_version').user_version;
  if (cur >= SEED_VERSION) return null;
  let res;
  try {
    res = await fetch(`${SEED_URL}?v=${SEED_VERSION}`);
    if (!res.ok) throw new Error(res.status);
  } catch (e) {
    console.warn('内置词库加载失败，使用示例词', e);
    return null;
  }
  const seedDb = new SQL.Database(new Uint8Array(await res.arrayBuffer()));
  const st = seedDb.prepare('SELECT word, ipa_uk, ipa_us, meaning_zh, level, tags, source FROM words ORDER BY id');
  const t = nowIso();
  let created = 0, updated = 0;
  transaction(() => {
    while (st.step()) {
      const w = st.getAsObject();
      const exist = get('SELECT id FROM words WHERE word=?', [w.word]);
      if (exist) {
        db.run(`UPDATE words SET ipa_uk=COALESCE(NULLIF(?,''), ipa_uk), ipa_us=COALESCE(NULLIF(?,''), ipa_us), meaning_zh=?, level=?, tags=?, active=1 WHERE id=?`,
          [w.ipa_uk, w.ipa_us, w.meaning_zh, w.level, w.tags, exist.id]);
        updated++;
      } else {
        db.run(`INSERT INTO words (word, ipa_uk, ipa_us, meaning_zh, example_en, example_zh, level, tags, source, active, created_at)
                VALUES (?,?,?,?,'','',?,?,?,1,?)`, [w.word, w.ipa_uk, w.ipa_us, w.meaning_zh, w.level, w.tags, w.source, t]);
        created++;
      }
    }
  });
  st.free();
  seedDb.close();
  db.run(`PRAGMA user_version=${SEED_VERSION}`);
  return { created, updated };
}

export async function openDb() {
  SQL = await window.initSqlJs({ locateFile: (f) => `assets/vendor/sqljs/${f}` });
  const bytes = await idbGet();
  db = bytes ? new SQL.Database(new Uint8Array(bytes)) : new SQL.Database();
  db.run('PRAGMA foreign_keys=ON');
  db.exec(SCHEMA);
  const merged = await mergeSeed();
  seed();
  await persist();
  return merged;
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
  await mergeSeed();
  seed();
  await persist();
}
