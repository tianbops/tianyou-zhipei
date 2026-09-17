// Zhipei One - 统一服务器会话
// Web 使用 HttpOnly Cookie；微信小程序使用 Bearer Token；两者最终都映射到同一个 userId。
const WEB_SESSION_TTL = 8 * 60 * 60;
const MINI_SESSION_TTL = 7 * 24 * 60 * 60;
const SESSION_COOKIE = 'ty_session';

function getSessionSecret(env) { return String(env.SESSION_SECRET || ''); }

function base64url(bytes) {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64url(value) {
  const text = String(value || '');
  const pad = text.length % 4 ? '='.repeat(4 - (text.length % 4)) : '';
  const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}

async function sign(secret, text) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
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

function readBearer(request) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

export async function createSession(env, user, options = {}) {
  return createToken(env, user, {
    client: options.client || 'web',
    ttl: options.ttl || (options.client === 'mini' ? MINI_SESSION_TTL : WEB_SESSION_TTL)
  });
}

export async function createMiniToken(env, user) {
  return createToken(env, user, { client: 'mini', ttl: MINI_SESSION_TTL });
}

async function createToken(env, user, { client, ttl }) {
  const secret = getSessionSecret(env);
  if (!secret) throw new Error('SESSION_SECRET 未配置');
  const id = String(user.id || '').trim();
  if (!id) throw new Error('用户资料缺少 id');

  const payload = {
    client,
    id,
    name: String(user.name || user.username || ''),
    route: normalizeRoute(user.route),
    vehicle: String(user.vehicle || ''),
    sessionVersion: Number(user.sessionVersion || 1),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttl
  };

  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = base64url(await sign(secret, body));
  return `${body}.${signature}`;
}

export function sessionCookie(token) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${WEB_SESSION_TTL}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export async function verifySession(request, env) {
  const cookieToken = readCookie(request, SESSION_COOKIE);
  const bearerToken = readBearer(request);
  return (await verifyToken(cookieToken, env, 'web')) || (await verifyToken(bearerToken, env, 'mini')) || null;
}

async function verifyToken(token, env, expectedClient) {
  const secret = getSessionSecret(env);
  if (!secret || !token || !token.includes('.')) return null;
  try {
    const [body, signature] = token.split('.', 2);
    const expected = await sign(secret, body);
    const actual = decodeBase64url(signature);
    if (!timingSafeEqual(expected, actual)) return null;

    const payload = JSON.parse(new TextDecoder().decode(decodeBase64url(body)));
    if (!payload?.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (payload.client !== expectedClient) return null;

    const id = String(payload.id || '').trim();
    if (!id) return null;

    return {
      id,
      name: String(payload.name || ''),
      route: normalizeRoute(payload.route),
      vehicle: String(payload.vehicle || ''),
      sessionVersion: Number(payload.sessionVersion || 1),
      client: expectedClient
    };
  } catch {
    return null;
  }
}

export async function authRequired(request, env, options = {}) {
  const session = await verifySession(request, env);
  if (!session) return null;
  if (options.client && session.client !== options.client) return null;
  if (options.route && normalizeRoute(options.route) !== session.route) return null;
  return session;
}

function normalizeRoute(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  return m ? `${String(parseInt(m[1] || m[2], 10)).padStart(2, '0')}号线` : s;
}
