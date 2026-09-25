// 天友智配One V1.0 - 统一多端身份认证
// Web：HttpOnly Cookie；微信小程序/Android：Bearer Token。
// 所有客户端最终映射到同一个 userId，并实时校验用户状态与 sessionVersion。
import { getUser, normalizeRoute, normalizeRole } from './_data.js';
import { getUserProfile, setUserProfile } from './v3/data.js';

const WEB_SESSION_TTL = 8 * 60 * 60;
const TOKEN_SESSION_TTL = 30 * 24 * 60 * 60;
const SESSION_COOKIE = 'ty_session';

function getSessionSecret(env) { return String(env.SESSION_SECRET || ''); }

function base64url(bytes) {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function decodeBase64url(value) {
  const text = String(value || '');
  const pad = text.length % 4 ? '='.repeat(4 - text.length % 4) : '';
  const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(raw, char => char.charCodeAt(0));
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
function readBearer(request) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

export async function createSession(env, user, options = {}) {
  return createToken(env, user, {
    client: options.client || 'web',
    ttl: options.ttl || WEB_SESSION_TTL
  });
}
export async function createMiniToken(env, user) {
  return createToken(env, user, { client: 'miniprogram', ttl: TOKEN_SESSION_TTL });
}
export async function createAndroidToken(env, user) {
  return createToken(env, user, { client: 'android', ttl: TOKEN_SESSION_TTL });
}

async function createToken(env, user, { client, ttl }) {
  const secret = getSessionSecret(env);
  if (!secret) throw new Error('SESSION_SECRET 未配置');
  const id = String(user?.id || '').trim();
  if (!id) throw new Error('用户资料缺少 id');
  const isPrimaryAdmin = user?.role === 'system_admin' && user?.adminLevel === 'primary';
  if (isPrimaryAdmin && client !== 'web') throw new Error('主系统管理员仅可签发系统管理端会话');
  const payload = {
    version: 1,
    client,
    id,
    name: String(user.name || user.username || ''),
    username: String(user.username || ''),
    boundRouteId: normalizeRoute(user.boundRouteId),
    role: normalizeRole(user.role),
    adminLevel: String(user.adminLevel || ''),
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
  const session = await verifyToken(cookieToken, env, 'web') || await verifyToken(bearerToken, env, null);
  if (!session) return null;

  // 每次认证都回读用户资料：停用账号、密码重置、强制注销可即时生效。
  const user = await getUser(env, session.id);
  if (!user || user.status === 'disabled') return null;
  if (Number(user.sessionVersion || 1) !== Number(session.sessionVersion || 1)) return null;

  const profile = await getUserProfile(env, user.id) || {
    userId: String(user.id),
    boundRouteId: normalizeRoute(user.boundRouteId),
    routeDuty: String(user.routeDuty || ''),
    status: String(user.status || 'active'),
    approvedAt: user.approvedAt || '',
    updatedAt: new Date().toISOString()
  };
  if (profile.boundRouteId !== normalizeRoute(user.boundRouteId) || profile.routeDuty !== String(user.routeDuty || '') || profile.status !== String(user.status || 'active')) {
    await setUserProfile(env, user.id, {
      ...profile,
      userId: String(user.id),
      boundRouteId: normalizeRoute(user.boundRouteId),
      routeDuty: String(user.routeDuty || ''),
      status: String(user.status || 'active'),
      approvedAt: user.approvedAt || profile.approvedAt || ''
    }).catch(() => {});
  }
  return {
    ...session,
    username: String(user.username || session.username || ''),
    name: String(user.name || session.name || user.username || ''),
    route: normalizeRoute(profile.boundRouteId),
    boundRouteId: normalizeRoute(profile.boundRouteId),
    role: normalizeRole(user.role),
    routeDuty: String(profile.routeDuty || ''),
    adminLevel: String(user.adminLevel || ''),
    vehicle: String(user.vehicle || ''),
    status: String(profile.status || user.status || 'active'),
    v3Profile: profile,
    user
  };
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
    if (expectedClient && payload.client !== expectedClient) return null;
    const id = String(payload.id || '').trim();
    if (!id) return null;
    return {
      id,
      name: String(payload.name || ''),
      username: String(payload.username || ''),
      route: normalizeRoute(payload.boundRouteId || payload.route),
      boundRouteId: normalizeRoute(payload.boundRouteId || payload.route),
      role: normalizeRole(payload.role),
      adminLevel: String(payload.adminLevel || ''),
      sessionVersion: Number(payload.sessionVersion || 1),
      client: String(payload.client || '')
    };
  } catch {
    return null;
  }
}

export async function authRequired(request, env, options = {}) {
  const session = await verifySession(request, env);
  if (!session) return null;
  if (session.adminLevel === 'primary' && !options.allowSystemAdmin) return null;
  if (options.client && session.client !== options.client) return null;
  if (options.route && normalizeRoute(options.route) !== session.boundRouteId) {
    if (!options.allowAnyRoute) return null;
  }
  if (options.roles?.length && !options.roles.includes(session.role)) return null;
  return session;
}

export async function requireSystemAdmin(request, env) {
  return authRequired(request, env, { roles: ['system_admin'], allowSystemAdmin: true });
}

export async function requireRouteMaintainer(request, env, route) {
  const session = await authRequired(request, env, { allowAnyRoute: true });
  if (!session) return null;
  if (normalizeRoute(session.boundRouteId) !== normalizeRoute(route)) return null;
  return session;
}
