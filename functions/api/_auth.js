// functions/api/_auth.js
// 服务端会话令牌：浏览器只持有会话令牌，业务数据全部以服务器为准。
// SESSION_SECRET 为独立签名密钥；生产环境应配置该变量。

const SESSION_TTL = 8 * 60 * 60;

function getSessionSecret(env) {
  return env.SESSION_SECRET || env.UPSTASH_REDIS_REST_TOKEN || '';
}

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64url(s) {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const raw = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function sign(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a[i] ^ b[i];
  return x === 0;
}

export async function createSession(env, user) {
  const secret = getSessionSecret(env);
  if (!secret) throw new Error('Session secret unavailable');
  const payload = {
    id: user.id,
    name: user.name || '',
    route: user.route || '',
    role: user.role || 'driver',
    sessionVersion: Number(user.sessionVersion || 1),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL
  };
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = base64url(await sign(secret, body));
  return `${body}.${sig}`;
}

export async function verifySession(request, env) {
  const secret = getSessionSecret(env);
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') || request.headers.get('X-Session-Token') || '';
  if (!secret || !token || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  try {
    const expected = await sign(secret, body);
    const actual = decodeBase64url(signature);
    if (!timingSafeEqual(expected, actual)) return null;
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64url(body)));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.id || !Number.isFinite(Number(payload.sessionVersion))) return null;
    if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return null;

    const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/admin_users`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
      cache: 'no-store'
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => ({}));
    if (!data.result) return null;
    let users;
    try { users = JSON.parse(data.result); } catch { return null; }
    if (!Array.isArray(users)) return null;

    const user = users.find(u => u && String(u.id) === String(payload.id));
    if (!user) return null;
    const currentVersion = Number(user.sessionVersion || 1);
    if (currentVersion !== Number(payload.sessionVersion)) return null;

    // 会话中的身份/线路信息不能长期脱离服务器真实用户记录。
    // 用户被降权、改线路或停用后，旧 token 立即失效，避免越权访问。
    const currentRole = user.role || 'driver';
    const currentRoute = normalizeRoute(user.route || '');
    const tokenRoute = normalizeRoute(payload.route || '');
    if (String(payload.name || '') !== String(user.name || '') || currentRole !== payload.role || currentRoute !== tokenRoute) return null;

    return {
      ...payload,
      name: user.name || '',
      role: currentRole,
      route: currentRoute
    };
  } catch {
    return null;
  }
}

export function authRequired(request, env, options = {}) {
  return verifySession(request, env).then(session => {
    if (!session) return null;
    if (options.admin && session.role !== 'admin') return null;
    if (options.route && session.role !== 'admin' && session.route !== options.route) return null;
    return session;
  });
}

function normalizeRoute(v) {
  const s = String(v || '').trim();
  const m = s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  return m ? `${String(parseInt(m[1] || m[2], 10)).padStart(2, '0')}号线` : s;
}
