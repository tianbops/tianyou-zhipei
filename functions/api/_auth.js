// 天友智配One - 服务器会话
// 当前版本只有 17号线司机用户：Session 使用 HttpOnly Cookie，浏览器无法读取 Session Token。
const SESSION_TTL = 8 * 60 * 60;
const SESSION_COOKIE = 'ty_session';

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
    name: String(user.name || user.username || ''),
    route: '17号线',
    vehicle: String(user.vehicle || '渝DK7692'),
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

  try {
    const [body, signature] = token.split('.', 2);
    const expected = await sign(secret, body);
    const actual = decodeBase64url(signature);
    if (!timingSafeEqual(expected, actual)) return null;

    const payload = JSON.parse(new TextDecoder().decode(decodeBase64url(body)));
    if (!payload?.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (String(payload.id) !== '17' || normalizeRoute(payload.route) !== '17号线') return null;

    // Session 本身由 SESSION_SECRET 签名。
    // 认证请求不再额外查询 Upstash Redis，避免每个 API 请求多一次网络往返。
    // 登录时仍会维护 driver:17 资料；Session 内已携带当前用户所需身份信息。
    return {
      id: '17',
      name: String(payload.name || ''),
      route: '17号线',
      vehicle: String(payload.vehicle || '渝DK7692'),
      sessionVersion: Number(payload.sessionVersion || 1)
    };
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

function normalizeRoute(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  return m ? `${String(parseInt(m[1] || m[2], 10)).padStart(2, '0')}号线` : s;
}
