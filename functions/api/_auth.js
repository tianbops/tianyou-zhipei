// 天友智配One - 服务器会话
// 当前版本只有 17号线司机用户：Session 使用 HttpOnly Cookie，浏览器无法读取 Session Token。
const SESSION_TTL = 8 * 60 * 60;
const SESSION_COOKIE = 'ty_session';
const DRIVER_KEY = 'driver:17';

function getSessionSecret(env) {
  return String(env.SESSION_SECRET || '');
}

function base64url(bytes) {
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64url(value) {
  const pad = value.length % 4 ? '='.repeat(4 - (value.length % 4)) : '';
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function sign(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}

export async function createSession(env, user) {
  const secret = getSessionSecret(env);
  if (!secret) throw new Error('SESSION_SECRET 未配置');
  const payload = {
    id: '17',
    name: String(user.name || ''),
    route: '17号线',
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL,
    sessionVersion: Number(user.sessionVersion || 1)
  };
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = base64url(await sign(secret, body));
  return `${body}.${signature}`;
}

export function sessionCookie(token) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${SESSION_TTL}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export async function verifySession(request, env) {
  const secret = getSessionSecret(env);
  const token = readCookie(request, SESSION_COOKIE);
  if (!secret || !token || !token.includes('.')) return null;
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return null;

  try {
    const [body, signature] = token.split('.', 2);
    const expected = await sign(secret, body);
    const actual = decodeBase64url(signature);
    if (!timingSafeEqual(expected, actual)) return null;

    const payload = JSON.parse(new TextDecoder().decode(decodeBase64url(body)));
    if (!payload?.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (String(payload.id) !== '17' || payload.route !== '17号线') return null;

    const driver = await redisGet(env, DRIVER_KEY);
    if (!driver || String(driver.id) !== '17') return null;
    if (String(driver.name || '') !== String(payload.name || '')) return null;
    if (Number(driver.sessionVersion || 1) !== Number(payload.sessionVersion || 1)) return null;

    return { id: '17', name: String(driver.name || ''), route: '17号线', vehicle: String(driver.vehicle || '渝DK7692'), sessionVersion: Number(driver.sessionVersion || 1) };
  } catch {
    return null;
  }
}

export async function authRequired(request, env, options = {}) {
  const session = await verifySession(request, env);
  if (!session) return null;
  if (options.route && normalizeRoute(options.route) !== session.route) return null;
  return session;
}

async function redisGet(env, key) {
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
    cache: 'no-store'
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => ({}));
  if (!data.result) return null;
  try { return typeof data.result === 'string' ? JSON.parse(data.result) : data.result; } catch { return null; }
}

function normalizeRoute(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  return m ? `${String(parseInt(m[1] || m[2], 10)).padStart(2, '0')}号线` : s;
}
