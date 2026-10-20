import { openDb, exportBytes, restoreBytes, health } from './db.js';
import * as api from './api.js';
import { RATINGS } from './scheduler.js';
import { currentUser, login, logout } from './auth.js';

const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtInterval = (d) => (d < 1 ? `${Math.round(d * 1440)} 分钟` : `${Math.round(d * 10) / 10} 天`);

function toast(msg, ms = 2200) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

// ---------- 发音 ----------
function speak(word) {
  if (!('speechSynthesis' in window)) return toast('当前浏览器不支持语音合成');
  const { accent } = api.getSettings();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(word);
  u.lang = accent;
  const voice = speechSynthesis.getVoices().find((v) => v.lang === accent) || speechSynthesis.getVoices().find((v) => v.lang.startsWith(accent.slice(0, 2)));
  if (voice) u.voice = voice;
  u.rate = 0.9;
  speechSynthesis.speak(u);
}
if ('speechSynthesis' in window) speechSynthesis.getVoices();

// 当前口音没有音标时回退到另一套，并标注（英）/（美）
const ipaOf = (w) => {
  const { accent } = api.getSettings();
  const main = accent === 'en-US' ? w.ipa_us : w.ipa_uk;
  if (main) return main;
  const other = accent === 'en-US' ? w.ipa_uk : w.ipa_us;
  return other ? `${other}（${accent === 'en-US' ? '英' : '美'}）` : '';
};

// ---------- 页面：学习概览 ----------
function viewHome() {
  const d = api.dashboard();
  $app.innerHTML = `
    <section class="hero">
      <h1>今天也来冲刺几个词</h1>
      <p>先看英文和音标、主动回忆中文，再翻面评级。评级决定下一次复习时间。</p>
    </section>
    <section class="grid stats-grid">
      ${tile('总词量', d.total)}
      ${tile('今日新词剩余', d.new_available, `每日目标 ${d.daily_new_count}`)}
      ${tile('到期复习', d.due)}
      ${tile('待巩固错词', d.wrong)}
      ${tile('今日复习次数', d.today_reviews)}
      ${tile('连续学习', `${d.streak} 天`)}
    </section>
    <section class="grid tasks">
      ${task('new', '新词', `今日还可学 ${d.new_available} 个`, d.new_available)}
      ${task('review', '到期复习', `${d.due} 个词已到复习时间`, d.due)}
      ${task('wrong', '错词复习', `${d.wrong} 个词待巩固`, d.wrong)}
    </section>
    ${d.total <= 10 ? `<p class="note">目前只有 ${d.total} 个示例词。到「词库」页导入你自己的四级 CSV 词库。</p>` : ''}
  `;
}
const tile = (label, val, sub = '') => `<div class="tile"><span>${label}</span><b>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
const task = (mode, title, desc, n) =>
  `<a class="task ${n ? '' : 'empty'}" href="#/study?mode=${mode}"><b>${title}</b><span>${desc}</span><em>${n ? '开始 →' : '暂无'}</em></a>`;

// ---------- 页面：单词卡片 ----------
const session = { mode: 'new', dir: 'en2zh', queue: [], idx: 0, flipped: false, done: 0 };

function startSession(mode, dir) {
  session.mode = mode;
  session.dir = dir || session.dir;
  session.queue = api.studyQueue(mode); // 本轮快照
  session.idx = 0;
  session.done = 0;
  session.flipped = false;
}

function viewStudy(params) {
  const mode = params.get('mode') || session.mode;
  if (mode !== session.mode || !session.queue.length || session.idx >= session.queue.length || params.get('restart')) startSession(mode);
  renderCard();
}

function renderCard() {
  const s = session;
  const settings = api.getSettings();
  const modes = { new: '新词', review: '到期复习', wrong: '错词复习', all: '全部词汇' };
  const head = `
    <div class="study-head">
      <div class="seg">${Object.entries(modes).map(([k, v]) => `<button data-mode="${k}" class="${k === s.mode ? 'on' : ''}">${v}</button>`).join('')}</div>
      <div class="seg">
        <button data-dir="en2zh" class="${s.dir === 'en2zh' ? 'on' : ''}">英 → 中</button>
        <button data-dir="zh2en" class="${s.dir === 'zh2en' ? 'on' : ''}">中 → 英</button>
      </div>
    </div>`;

  if (s.idx >= s.queue.length) {
    $app.innerHTML = `${head}<div class="card done-card"><h2>${s.queue.length ? '本轮完成 🎉' : '这个队列暂时没有词'}</h2>
      <p>${s.queue.length ? `本轮评级 ${s.done} 个，跳过 ${s.queue.length - s.done} 个。` : s.mode === 'new' ? '今日新词额度已用完，或词库里没有未学的词。' : '换一个队列试试。'}</p>
      <div class="row center"><a class="btn" href="#/">返回概览</a><button class="btn ghost" data-restart>重新加载队列</button></div></div>`;
    bindStudyHead();
    $app.querySelector('[data-restart]').onclick = () => { startSession(s.mode); renderCard(); };
    return;
  }

  const w = s.queue[s.idx];
  const ipa = ipaOf(w);
  const enBlock = `<div class="word">${esc(w.word)}</div><div class="ipa">${ipa ? esc(ipa) : '<i>（暂无音标）</i>'}</div>`;
  const zhBlock = `<div class="meaning">${esc(w.meaning_zh)}</div>`;
  const example = settings.show_example && (w.example_en || w.example_zh)
    ? `<div class="example">${w.example_en ? `<p>${esc(w.example_en)}</p>` : ''}${w.example_zh ? `<p class="zh">${esc(w.example_zh)}</p>` : ''}</div>` : '';
  const front = s.dir === 'en2zh' ? enBlock + `<p class="hint">先在心里说出中文意思，再翻面。</p>` : zhBlock + `<p class="hint">先回忆英文拼写，再翻面。</p>`;
  const back = s.dir === 'en2zh' ? enBlock + zhBlock + example : zhBlock + enBlock + example;

  $app.innerHTML = `${head}
    <div class="progress"><div style="width:${(s.idx / s.queue.length) * 100}%"></div></div>
    <p class="counter">${s.idx + 1} / ${s.queue.length}</p>
    <div class="card flip ${s.flipped ? 'flipped' : ''}" tabindex="0" role="button" aria-label="点击翻面">
      ${s.flipped ? back : front}
      <div class="card-tools">
        <button class="btn ghost small" data-speak>🔊 听发音</button>
        ${s.flipped ? '' : '<button class="btn small" data-flip>显示答案</button>'}
      </div>
    </div>
    ${s.flipped ? `<div class="ratings">${RATINGS.map((r) => `<button class="rate rate-${r.value}" data-rate="${r.value}"><b>${r.label}</b><small>${r.key}</small></button>`).join('')}</div>` : ''}
    <div class="row center"><button class="link" data-skip>跳过（不记录）</button></div>
    <p class="kbd-hint">快捷键：Enter / 空格 翻面 · 1–4 评级 · P 发音 · S 跳过</p>`;

  bindStudyHead();
  const card = $app.querySelector('.card');
  card.onclick = (e) => { if (!e.target.closest('button') && !s.flipped) flip(); };
  card.focus({ preventScroll: true });
  $app.querySelector('[data-speak]').onclick = () => speak(w.word);
  $app.querySelector('[data-flip]')?.addEventListener('click', flip);
  $app.querySelector('[data-skip]').onclick = skip;
  $app.querySelectorAll('[data-rate]').forEach((b) => (b.onclick = () => rate(b.dataset.rate)));
}

function bindStudyHead() {
  $app.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => { location.hash = `#/study?mode=${b.dataset.mode}&restart=${Date.now()}`; }));
  $app.querySelectorAll('[data-dir]').forEach((b) => (b.onclick = () => { session.dir = b.dataset.dir; session.flipped = false; renderCard(); }));
}
function flip() { session.flipped = true; renderCard(); }
function skip() { session.idx++; session.flipped = false; renderCard(); }
async function rate(rating) {
  const w = session.queue[session.idx];
  try {
    const r = await api.submitReview({ word_id: w.id, rating, mode: session.mode });
    toast(`已记录 · ${fmtInterval(r.interval_days)}后复习（${fmtTime(r.next_due_at)}）`);
    session.done++;
    session.idx++;
    session.flipped = false;
    renderCard();
  } catch (e) {
    toast(e.message);
  }
}

document.addEventListener('keydown', (e) => {
  if (currentView !== 'study' || e.target.matches('input, textarea, select')) return;
  const s = session;
  if (s.idx >= s.queue.length) return;
  if ((e.key === 'Enter' || e.key === ' ') && !s.flipped) { e.preventDefault(); flip(); }
  else if (s.flipped && ['1', '2', '3', '4'].includes(e.key)) rate(RATINGS[Number(e.key) - 1].value);
  else if (e.key === 'p' || e.key === 'P') speak(s.queue[s.idx].word);
  else if (e.key === 's' || e.key === 'S') skip();
});

// ---------- 页面：错词本 ----------
function viewWrong() {
  const list = api.wrongWords();
  $app.innerHTML = `
    <div class="page-head"><h1>错词本 <small>${list.length} 个待巩固</small></h1>
      ${list.length ? '<a class="btn" href="#/study?mode=wrong&restart=1">开始错词复习</a>' : ''}</div>
    <p class="note">最近一次评为「忘记了 / 有点模糊」的词会出现在这里；再次评为「认识 / 很熟悉」后移出。</p>
    ${list.length ? `<table class="tbl"><thead><tr><th>单词</th><th>音标</th><th>释义</th><th>最近评级</th><th>遗忘次数</th><th>下次复习</th><th></th></tr></thead><tbody>
      ${list.map((w) => `<tr><td><b>${esc(w.word)}</b></td><td class="ipa-s">${esc(ipaOf(w))}</td><td>${esc(w.meaning_zh)}</td>
        <td><span class="tag tag-${w.last_rating}">${w.last_rating === 'again' ? '忘记了' : '有点模糊'}</span></td><td>${w.lapses}</td><td>${fmtTime(w.due_at)}</td>
        <td><button class="link" data-say="${esc(w.word)}">🔊</button></td></tr>`).join('')}
    </tbody></table>` : '<div class="empty-box">暂无错词，继续保持。</div>'}`;
  $app.querySelectorAll('[data-say]').forEach((b) => (b.onclick = () => speak(b.dataset.say)));
}

// ---------- 页面：词库 ----------
const wordsState = { q: '', offset: 0, limit: 50 };
function viewWords() {
  const { total, items } = api.searchWords(wordsState);
  const page = Math.floor(wordsState.offset / wordsState.limit) + 1;
  const pages = Math.max(1, Math.ceil(total / wordsState.limit));
  const status = (w) => (!w.due_at ? '<span class="tag">新词</span>' : w.last_rating === 'again' || w.last_rating === 'hard' ? '<span class="tag tag-hard">待巩固</span>' : `<span class="tag tag-good">${fmtTime(w.due_at)}</span>`);
  $app.innerHTML = `
    <div class="page-head"><h1>词库 <small>${total} 条</small></h1>
      <input id="q" class="search" placeholder="搜索单词 / 中文 / 标签" value="${esc(wordsState.q)}" /></div>
    <table class="tbl"><thead><tr><th>单词</th><th>英式 IPA</th><th>美式 IPA</th><th>释义</th><th>标签</th><th>状态 / 下次复习</th><th></th></tr></thead><tbody>
      ${items.map((w) => `<tr><td><b>${esc(w.word)}</b></td><td class="ipa-s">${esc(w.ipa_uk)}</td><td class="ipa-s">${esc(w.ipa_us)}</td><td>${esc(w.meaning_zh)}</td><td class="muted">${esc(w.tags)}</td><td>${status(w)}</td><td><button class="link" data-say="${esc(w.word)}">🔊</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted center">没有匹配的词条</td></tr>'}
    </tbody></table>
    <div class="row center pager"><button class="btn ghost small" data-prev ${page <= 1 ? 'disabled' : ''}>上一页</button><span>${page} / ${pages}</span><button class="btn ghost small" data-next ${page >= pages ? 'disabled' : ''}>下一页</button></div>

    <section class="panel">
      <h2>导入 CSV</h2>
      <p class="muted">表头至少包含 <code>word,meaning_zh</code>；完整字段：<code>${api.CSV_FIELDS.join(',')}</code>。同一单词重复导入会更新词条字段，不清除学习进度。</p>
      <div class="row wrap">
        <label class="btn">选择 CSV 文件<input type="file" id="csvFile" accept=".csv,text/csv" hidden /></label>
        <button class="btn ghost" data-repo>加载仓库内 data/words.csv</button>
        <button class="btn ghost" data-template>下载示例模板</button>
      </div>
      <textarea id="csvText" rows="5" placeholder="也可以直接粘贴 CSV 文本到这里"></textarea>
      <button class="btn" data-import-text>导入粘贴内容</button>
    </section>

    <section class="panel">
      <h2>导出与备份</h2>
      <div class="row wrap">
        <button class="btn" data-export>导出 CSV 词库</button>
        <button class="btn" data-backup>下载 SQLite 数据库备份</button>
        <label class="btn ghost">从备份恢复（.sqlite3）<input type="file" id="restoreFile" accept=".sqlite3,.sqlite,.db" hidden /></label>
      </div>
      <p class="muted">备份文件是完整的 SQLite 数据库（words / review_states / review_logs / app_settings），可用 DB Browser for SQLite 打开。恢复会覆盖当前浏览器里的全部数据。</p>
    </section>`;

  const q = $app.querySelector('#q');
  q.oninput = () => { clearTimeout(viewWords._t); viewWords._t = setTimeout(() => { wordsState.q = q.value; wordsState.offset = 0; viewWords(); const n = $app.querySelector('#q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 250); };
  $app.querySelector('[data-prev]').onclick = () => { wordsState.offset = Math.max(0, wordsState.offset - wordsState.limit); viewWords(); };
  $app.querySelector('[data-next]').onclick = () => { wordsState.offset += wordsState.limit; viewWords(); };
  $app.querySelectorAll('[data-say]').forEach((b) => (b.onclick = () => speak(b.dataset.say)));

  const doImport = async (text, source) => {
    try {
      const r = await api.importCsv(text, source);
      toast(`导入完成：新增 ${r.created}，更新 ${r.updated}，跳过 ${r.skipped}`, 4000);
      viewWords();
    } catch (e) { toast(e.message, 4000); }
  };
  $app.querySelector('#csvFile').onchange = async (e) => { const f = e.target.files[0]; if (f) doImport(await f.text(), 'csv-import'); };
  $app.querySelector('[data-import-text]').onclick = () => { const t = $app.querySelector('#csvText').value; if (t.trim()) doImport(t, 'csv-import'); };
  $app.querySelector('[data-repo]').onclick = async () => {
    try {
      const res = await fetch(`data/words.csv?t=${Date.now()}`);
      if (!res.ok) throw new Error('仓库里没有找到 data/words.csv');
      doImport(await res.text(), 'repo-csv');
    } catch (e) { toast(e.message, 4000); }
  };
  $app.querySelector('[data-template]').onclick = () => download('wordsprint-template.csv',
    '\uFEFFword,ipa_uk,ipa_us,meaning_zh,example_en,example_zh,level,tags\r\nachieve,/əˈtʃiːv/,/əˈtʃiːv/,实现；达到（目标）,She worked hard to achieve her goal.,她努力实现自己的目标。,CET-4,核心动词;目标\r\n', 'text/csv');
  $app.querySelector('[data-export]').onclick = () => download(`wordsprint-words-${stamp()}.csv`, api.exportCsv(), 'text/csv;charset=utf-8');
  $app.querySelector('[data-backup]').onclick = () => download(`wordsprint-${stamp()}.sqlite3`, new Blob([exportBytes()], { type: 'application/x-sqlite3' }));
  $app.querySelector('#restoreFile').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (!confirm('恢复会覆盖当前浏览器里的全部词库与学习进度，确定继续？')) return;
    try {
      await restoreBytes(new Uint8Array(await f.arrayBuffer()));
      session.queue = [];
      toast('数据库已恢复');
      viewWords();
    } catch (err) { toast(err.message, 4000); }
  };
}

// ---------- 页面：统计 ----------
function viewStats() {
  const s = api.stats();
  const max = Math.max(1, ...s.days.map((d) => d.reviews));
  $app.innerHTML = `
    <div class="page-head"><h1>学习统计</h1></div>
    <section class="grid stats-grid">
      ${tile('总词量', s.total)}
      ${tile('已开始学习', s.started)}
      ${tile('初步掌握', s.mastered, '连续 ≥3 次且最近为认识/很熟悉')}
      ${tile('今日复习次数', s.today_reviews)}
      ${tile('今日新词剩余', s.new_remaining)}
      ${tile('近 7 天正确率', s.accuracy_7d == null ? '—' : `${Math.round(s.accuracy_7d * 100)}%`, '「有点模糊」不计为正确')}
      ${tile('连续学习', `${s.streak} 天`)}
    </section>
    <section class="panel">
      <h2>近 7 天复习</h2>
      <div class="chart">
        ${s.days.map((d) => `<div class="bar-col"><span class="bar-val">${d.reviews}</span>
          <div class="bar" style="height:${(d.reviews / max) * 160}px"><div class="bar-ok" style="height:${d.reviews ? (d.correct / d.reviews) * 100 : 0}%"></div></div>
          <span class="bar-lbl">${d.date.slice(5)}</span></div>`).join('')}
      </div>
      <p class="muted legend"><i class="sw sw-all"></i>复习次数 <i class="sw sw-ok"></i>其中正确（认识/很熟悉）</p>
    </section>`;
}

// ---------- 页面：设置 ----------
function viewSettings() {
  const s = api.getSettings();
  const h = health();
  $app.innerHTML = `
    <div class="page-head"><h1>设置</h1></div>
    <form class="panel form" id="sf">
      <label>每日新词数量<input type="number" name="daily_new_count" min="5" max="100" value="${s.daily_new_count}" required /><small>5–100</small></label>
      <label>发音口音
        <select name="accent"><option value="en-GB" ${s.accent === 'en-GB' ? 'selected' : ''}>英式（en-GB，显示英式 IPA）</option><option value="en-US" ${s.accent === 'en-US' ? 'selected' : ''}>美式（en-US，显示美式 IPA）</option></select></label>
      <label class="check"><input type="checkbox" name="show_example" ${s.show_example ? 'checked' : ''} /> 揭晓答案后显示双语例句</label>
      <div class="row"><button class="btn" type="submit">保存设置</button><button class="btn ghost" type="button" data-test>试听口音</button></div>
    </form>
    <section class="panel">
      <h2>运行状态</h2>
      <p class="muted">SQLite ${esc(h.sqlite)}（sql.js / WebAssembly） · 表：${h.tables.map(esc).join('、')} · 存储：浏览器 IndexedDB</p>
    </section>`;
  const f = $app.querySelector('#sf');
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api.updateSettings({ daily_new_count: Number(f.daily_new_count.value), accent: f.accent.value, show_example: f.show_example.checked });
      session.queue = [];
      toast('设置已保存');
    } catch (err) { toast(err.message); }
  };
  $app.querySelector('[data-test]').onclick = async () => {
    await api.updateSettings({ daily_new_count: Number(f.daily_new_count.value), accent: f.accent.value, show_example: f.show_example.checked }).catch(() => {});
    speak('schedule');
  };
}

// ---------- 路由 ----------
const routes = { '': ['home', viewHome], study: ['study', viewStudy], wrong: ['wrong', viewWrong], words: ['words', viewWords], stats: ['stats', viewStats], settings: ['settings', viewSettings] };
let currentView = 'home';
function route() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const [name, fn] = routes[path] || routes[''];
  currentView = name;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.view === name));
  try { fn(new URLSearchParams(qs || '')); } catch (e) { console.error(e); $app.innerHTML = `<div class="empty-box">出错了：${esc(e.message)}</div>`; }
  window.scrollTo(0, 0);
}

function viewLogin() {
  document.getElementById('nav').hidden = true;
  $app.innerHTML = `
    <form class="panel form login" id="lf">
      <h1>登录 WordSprint</h1>
      <label>用户名<input name="u" autocomplete="username" required autofocus /></label>
      <label>密码<input name="p" type="password" autocomplete="current-password" required /></label>
      <p class="err" id="lerr"></p>
      <button class="btn" type="submit">登录</button>
    </form>`;
  const f = $app.querySelector('#lf');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button');
    btn.disabled = true;
    btn.textContent = '验证中…';
    try {
      await login(f.u.value, f.p.value);
      start();
    } catch (err) {
      f.querySelector('#lerr').textContent = err.message;
      btn.disabled = false;
      btn.textContent = '登录';
    }
  };
}

function addUserBar(user) {
  const nav = document.getElementById('nav');
  nav.hidden = false;
  if (nav.querySelector('.user')) return;
  const span = document.createElement('span');
  span.className = 'user';
  span.innerHTML = `${esc(user.name || user.username)} · <button class="link" type="button">退出</button>`;
  span.querySelector('button').onclick = () => { logout(); location.hash = '#/'; location.reload(); };
  nav.appendChild(span);
}

async function start() {
  const user = currentUser();
  if (!user) return viewLogin();
  addUserBar(user);
  $app.innerHTML = '<div class="loading">正在加载 SQLite 数据库…</div>';
  try {
    const merged = await openDb();
    if (merged && merged.created) setTimeout(() => toast(`已载入内置四级词库：新增 ${merged.created} 词，更新 ${merged.updated} 词`, 4000), 300);
  } catch (e) {
    $app.innerHTML = `<div class="empty-box">数据库加载失败：${esc(e.message)}<br/>请使用较新的 Chrome / Edge / Firefox / Safari，并通过 http(s) 访问（不能直接双击打开文件）。</div>`;
    return;
  }
  window.addEventListener('hashchange', route);
  route();
}
start();
