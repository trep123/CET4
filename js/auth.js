import { getSQL } from './sqlite.js';

// 登录校验：用户存放在 data/users.sqlite3 的 users 表（PBKDF2-SHA256 哈希，见 tools/adduser.py）
const KEY = 'wordsprint_auth';
const DAYS = 7;
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));

export function currentUser() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s && s.exp > Date.now()) return s;
  } catch {}
  localStorage.removeItem(KEY);
  return null;
}

export function logout() {
  localStorage.removeItem(KEY);
}

async function pbkdf2(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations }, key, 256);
  return hex(bits);
}

export async function login(username, password) {
  const res = await fetch(`data/users.sqlite3?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('无法读取用户数据');
  const SQL = await getSQL();
  const db = new SQL.Database(new Uint8Array(await res.arrayBuffer()));
  let row = null;
  try {
    const st = db.prepare('SELECT username, name, role, salt, hash, iterations, disabled FROM users WHERE username=?');
    st.bind([username.trim()]);
    if (st.step()) row = st.getAsObject();
    st.free();
  } finally {
    db.close();
  }
  if (!row || (await pbkdf2(password, row.salt, row.iterations)) !== row.hash) throw new Error('用户名或密码错误');
  if (row.disabled) throw new Error('该账号已停用');
  const s = { username: row.username, name: row.name, role: row.role, exp: Date.now() + DAYS * 86400000 };
  localStorage.setItem(KEY, JSON.stringify(s));
  return s;
}
