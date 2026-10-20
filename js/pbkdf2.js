// 纯 JS 的 PBKDF2-HMAC-SHA256：用于 crypto.subtle 不可用的场景
// （浏览器只在 HTTPS 或 localhost 下提供 Web Crypto，用 http:// 局域网地址或部分内嵌浏览器打开时为 undefined）
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const W = new Uint32Array(64);

// 压缩一个 64 字节块（16 个大端 32 位字），更新状态 h
function block(h, m) {
  for (let i = 0; i < 16; i++) W[i] = m[i];
  for (let i = 16; i < 64; i++) {
    const a = W[i - 15], b = W[i - 2];
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
  }
  let [a, b, c, d, e, f, g, hh] = h;
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
  h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
}

// 对字节数组做完整 SHA-256，可指定初始状态与已处理长度（用于 HMAC 预计算）
function sha256(bytes, state = IV, prefixLen = 0) {
  const h = Int32Array.from(state);
  const total = prefixLen + bytes.length;
  const padLen = ((bytes.length + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(padLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const bits = total * 8;
  const dv = new DataView(buf.buffer);
  dv.setUint32(padLen - 8, Math.floor(bits / 0x100000000));
  dv.setUint32(padLen - 4, bits >>> 0);
  const m = new Int32Array(16);
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = dv.getInt32(off + i * 4);
    block(h, m);
  }
  return h;
}

function toBytes(words) {
  const out = new Uint8Array(32);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) dv.setInt32(i * 4, words[i]);
  return out;
}

export function pbkdf2Sha256(password, salt, iterations, dkLen = 32) {
  let key = password;
  if (key.length > 64) key = toBytes(sha256(key));
  const ipad = new Uint8Array(64).fill(0x36), opad = new Uint8Array(64).fill(0x5c);
  for (let i = 0; i < key.length; i++) { ipad[i] ^= key[i]; opad[i] ^= key[i]; }
  // 预计算 ipad/opad 块后的中间状态，每轮只需压缩 2 个块
  const mi = new Int32Array(16), mo = new Int32Array(16);
  const di = new DataView(ipad.buffer), dov = new DataView(opad.buffer);
  for (let i = 0; i < 16; i++) { mi[i] = di.getInt32(i * 4); mo[i] = dov.getInt32(i * 4); }
  const hi = Int32Array.from(IV), ho = Int32Array.from(IV);
  block(hi, mi); block(ho, mo);
  // 32 字节消息（内层摘要）的填充块模板
  const msg = new Int32Array(16);
  msg[8] = 0x80000000 | 0; msg[15] = (64 + 32) * 8;
  const hmac32 = (u) => { // 输入 8 个字（32 字节），输出 8 个字
    for (let i = 0; i < 8; i++) msg[i] = u[i];
    const h1 = Int32Array.from(hi); block(h1, msg);
    for (let i = 0; i < 8; i++) msg[i] = h1[i];
    const h2 = Int32Array.from(ho); block(h2, msg);
    return h2;
  };
  const out = new Uint8Array(Math.ceil(dkLen / 32) * 32);
  for (let blockIdx = 1; blockIdx * 32 - 32 < dkLen; blockIdx++) {
    const s = new Uint8Array(salt.length + 4);
    s.set(salt);
    new DataView(s.buffer).setUint32(salt.length, blockIdx);
    let u = sha256(s, hi, 64);
    u = sha256(toBytes(u), ho, 64);
    const t = Int32Array.from(u);
    for (let n = 1; n < iterations; n++) {
      u = hmac32(u);
      for (let i = 0; i < 8; i++) t[i] ^= u[i];
    }
    out.set(toBytes(t), (blockIdx - 1) * 32);
  }
  return out.slice(0, dkLen);
}
