// 业务层：对应方案书 §7 的各个接口，只是改为浏览器内函数调用
import { all, get, run, transaction, persist, nowIso, seedStatus, loadMoreChunks } from './db.js?v=5';
import { schedule } from './scheduler.js?v=5';

// 本地日期边界（转为 UTC ISO 比较）
function dayStartIso(offsetDays = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString();
}
function localDateKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function getSettings() {
  const s = get('SELECT daily_new_count, accent, show_example FROM app_settings WHERE id=1');
  return { ...s, show_example: !!s.show_example };
}
export async function updateSettings({ daily_new_count, accent, show_example }) {
  const n = Number(daily_new_count);
  if (!Number.isInteger(n) || n < 5 || n > 100) throw new Error('每日新词数量须为 5–100 的整数');
  if (!['en-GB', 'en-US'].includes(accent)) throw new Error('口音设置无效');
  run('UPDATE app_settings SET daily_new_count=?, accent=?, show_example=?, updated_at=? WHERE id=1', [n, accent, show_example ? 1 : 0, nowIso()]);
  await persist();
  return getSettings();
}

function newStartedToday() {
  return get(`SELECT COUNT(DISTINCT word_id) AS n FROM review_logs WHERE mode='new' AND reviewed_at >= ?`, [dayStartIso()]).n;
}
function localUnlearned() {
  return get(`SELECT COUNT(*) AS n FROM words w LEFT JOIN review_states s ON s.word_id=w.id WHERE w.active=1 AND s.id IS NULL`).n;
}
// 未学词 = 本地未学 + 尚未加载分包中的词
function unlearnedCount() {
  return localUnlearned() + seedStatus().pending;
}
function totalWords() {
  return get('SELECT COUNT(*) AS n FROM words WHERE active=1').n + seedStatus().pending;
}
function newRemaining() {
  const { daily_new_count } = getSettings();
  return Math.min(Math.max(0, daily_new_count - newStartedToday()), unlearnedCount());
}
function streak() {
  const days = new Set(all('SELECT reviewed_at FROM review_logs WHERE reviewed_at >= ?', [dayStartIso(-400)]).map((r) => localDateKey(r.reviewed_at)));
  const d = new Date();
  if (!days.has(localDateKey(d.toISOString()))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (days.has(localDateKey(d.toISOString()))) {
    n += 1;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

export function dashboard() {
  const now = nowIso();
  return {
    total: totalWords(),
    new_available: newRemaining(),
    unlearned: unlearnedCount(),
    daily_new_count: getSettings().daily_new_count,
    due: get('SELECT COUNT(*) AS n FROM review_states s JOIN words w ON w.id=s.word_id WHERE w.active=1 AND s.due_at <= ?', [now]).n,
    wrong: get("SELECT COUNT(*) AS n FROM review_states s JOIN words w ON w.id=s.word_id WHERE w.active=1 AND s.last_rating IN ('again','hard')").n,
    today_reviews: get('SELECT COUNT(*) AS n FROM review_logs WHERE reviewed_at >= ?', [dayStartIso()]).n,
    streak: streak(),
  };
}

const WORD_COLS = 'w.id, w.word, w.ipa_uk, w.ipa_us, w.meaning_zh, w.example_en, w.example_zh, w.level, w.tags';

export async function studyQueue(mode) {
  const now = nowIso();
  if (mode === 'new') {
    // 本地未学词不够今天的额度时，按需加载下一个分包
    while (localUnlearned() < newRemaining() && seedStatus().pendingChunks > 0) await loadMoreChunks(1);
    return all(`SELECT ${WORD_COLS} FROM words w LEFT JOIN review_states s ON s.word_id=w.id
                WHERE w.active=1 AND s.id IS NULL ORDER BY w.id LIMIT ?`, [newRemaining()]);
  }
  if (mode === 'review') {
    return all(`SELECT ${WORD_COLS} FROM words w JOIN review_states s ON s.word_id=w.id
                WHERE w.active=1 AND s.due_at <= ? ORDER BY s.due_at LIMIT 200`, [now]);
  }
  if (mode === 'wrong') {
    return all(`SELECT ${WORD_COLS} FROM words w JOIN review_states s ON s.word_id=w.id
                WHERE w.active=1 AND s.last_rating IN ('again','hard') ORDER BY s.last_reviewed_at DESC LIMIT 200`);
  }
  if (mode === 'all') {
    if (seedStatus().pendingChunks) await loadMoreChunks(Infinity);
    return all(`SELECT ${WORD_COLS} FROM words w WHERE w.active=1 ORDER BY w.word LIMIT 100`);
  }
  throw new Error('无效队列');
}

export async function submitReview({ word_id, rating, mode }) {
  if (!['again', 'hard', 'good', 'easy'].includes(rating)) throw new Error('无效评级');
  if (!['new', 'review', 'wrong', 'all'].includes(mode)) throw new Error('无效模式');
  if (!get('SELECT id FROM words WHERE id=?', [word_id])) throw new Error('单词不存在（404）');
  const now = new Date();
  const t = now.toISOString();
  const result = transaction(() => {
    const st = get('SELECT * FROM review_states WHERE word_id=?', [word_id]);
    const next = schedule(st, rating, now);
    if (st) {
      run(`UPDATE review_states SET repetitions=?, interval_days=?, ease_factor=?, due_at=?, last_reviewed_at=?, last_rating=?, lapses=?, total_reviews=total_reviews+1 WHERE word_id=?`,
        [next.repetitions, next.interval_days, next.ease_factor, next.due_at, t, rating, next.lapses, word_id]);
    } else {
      run(`INSERT INTO review_states (word_id, repetitions, interval_days, ease_factor, due_at, last_reviewed_at, last_rating, lapses, total_reviews) VALUES (?,?,?,?,?,?,?,?,1)`,
        [word_id, next.repetitions, next.interval_days, next.ease_factor, next.due_at, t, rating, next.lapses]);
    }
    run('INSERT INTO review_logs (word_id, reviewed_at, rating, was_correct, mode) VALUES (?,?,?,?,?)',
      [word_id, t, rating, rating === 'good' || rating === 'easy' ? 1 : 0, mode]);
    return { ok: true, next_due_at: next.due_at, interval_days: next.interval_days, repetitions: next.repetitions };
  });
  await persist();
  return result;
}

export function wrongWords() {
  return all(`SELECT ${WORD_COLS}, s.last_rating, s.lapses, s.last_reviewed_at, s.due_at FROM words w JOIN review_states s ON s.word_id=w.id
              WHERE w.active=1 AND s.last_rating IN ('again','hard') ORDER BY s.last_reviewed_at DESC`);
}

export function stats() {
  const since = dayStartIso(-6);
  const logs = all('SELECT reviewed_at, was_correct FROM review_logs WHERE reviewed_at >= ?', [since]);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push({ date: localDateKey(d.toISOString()), reviews: 0, correct: 0 });
  }
  const map = Object.fromEntries(days.map((d) => [d.date, d]));
  for (const l of logs) {
    const k = map[localDateKey(l.reviewed_at)];
    if (k) {
      k.reviews += 1;
      k.correct += l.was_correct ? 1 : 0;
    }
  }
  const total7 = logs.length;
  const correct7 = logs.filter((l) => l.was_correct).length;
  return {
    total: totalWords(),
    started: get('SELECT COUNT(*) AS n FROM review_states').n,
    mastered: get("SELECT COUNT(*) AS n FROM review_states WHERE repetitions >= 3 AND last_rating IN ('good','easy')").n,
    today_reviews: get('SELECT COUNT(*) AS n FROM review_logs WHERE reviewed_at >= ?', [dayStartIso()]).n,
    new_remaining: newRemaining(),
    accuracy_7d: total7 ? correct7 / total7 : null,
    streak: streak(),
    days,
  };
}

export function searchWords({ q = '', offset = 0, limit = 50 }) {
  const like = `%${q.trim().toLowerCase()}%`;
  const where = q.trim() ? 'WHERE w.word LIKE ? OR w.meaning_zh LIKE ? OR w.tags LIKE ?' : '';
  const params = q.trim() ? [like, `%${q.trim()}%`, `%${q.trim()}%`] : [];
  const total = get(`SELECT COUNT(*) AS n FROM words w ${where}`, params).n;
  const items = all(`SELECT ${WORD_COLS}, s.due_at, s.last_rating, s.repetitions FROM words w LEFT JOIN review_states s ON s.word_id=w.id ${where}
                     ORDER BY w.word LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { total, items };
}

// ---------- CSV ----------
export const CSV_FIELDS = ['word', 'ipa_uk', 'ipa_us', 'meaning_zh', 'example_en', 'example_zh', 'level', 'tags'];

export function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export async function importCsv(text, source = 'csv-import') {
  if (text.length > 1000000) throw new Error('CSV 文本超过 1,000,000 个字符上限，请拆分后导入');
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('CSV 为空');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  if (!header.includes('word') || !header.includes('meaning_zh')) throw new Error('CSV 表头至少需要 word 和 meaning_zh');
  const cols = header.filter((h) => CSV_FIELDS.includes(h));
  let created = 0, updated = 0, skipped = 0;
  const t = nowIso();
  transaction(() => {
    for (const r of rows.slice(1)) {
      const rec = {};
      header.forEach((h, i) => { if (CSV_FIELDS.includes(h)) rec[h] = (r[i] ?? '').trim(); });
      rec.word = (rec.word || '').toLowerCase();
      if (!rec.word || !rec.meaning_zh || rec.word.length > 120) { skipped++; continue; }
      const exist = get('SELECT id FROM words WHERE word=?', [rec.word]);
      if (exist) {
        const set = cols.filter((c) => c !== 'word');
        run(`UPDATE words SET ${set.map((c) => `${c}=?`).join(', ')}, active=1 WHERE id=?`, [...set.map((c) => rec[c]), exist.id]);
        updated++;
      } else {
        run(`INSERT INTO words (word, ipa_uk, ipa_us, meaning_zh, example_en, example_zh, level, tags, source, active, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,1,?)`,
          [rec.word, rec.ipa_uk || '', rec.ipa_us || '', rec.meaning_zh, rec.example_en || '', rec.example_zh || '', rec.level || 'CET-4', rec.tags || '', source, t]);
        created++;
      }
    }
  });
  await persist();
  return { created, updated, skipped };
}

export function exportCsv() {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = all(`SELECT ${CSV_FIELDS.join(', ')} FROM words ORDER BY word`);
  return '\uFEFF' + [CSV_FIELDS.join(','), ...rows.map((r) => CSV_FIELDS.map((f) => esc(r[f])).join(','))].join('\r\n') + '\r\n';
}
