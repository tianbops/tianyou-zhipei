// 天友智配One - 多用户登录
// 用户资料与密码哈希均保存在 Upstash；每个用户绑定独立线路。
import { createSession, sessionCookie } from './_auth.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
  if (!redisReady(env)) return json({ success: false, error: '登录服务未配置，请检查 Upstash 配置' }, 500);
  if (!env.SESSION_SECRET) return json({ success: false, error: 'SESSION_SECRET 未配置，登录服务暂不可用' }, 500);

  try {
    const body = await request.json().catch(() => ({}));
    const username = normalizeUsername(body.username || body.account);
    const password = String(body.password || '');
    if (!username) return json({ success: false, error: '用户名不能为空' }, 400);
    if (!password) return json({ success: false, error: '密码不能为空' }, 400);

    const userId = await redisGet(env, `user:username:${encodeURIComponent(username)}`);
    if (!userId) return json({ success: false, error: '用户名或密码错误' }, 401);

    const user = parseRecord(await redisGet(env, `user:${userId}`));
    if (!user || user.status === 'disabled') return json({ success: false, error: '用户不存在或已停用' }, 401);
    if (!user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
      return json({ success: false, error: '用户名或密码错误' }, 401);
    }

    const safeUser = publicUser(user);
    const token = await createSession(env, safeUser);
    return new Response(JSON.stringify({ success: true, user: safeUser }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': sessionCookie(token)
      }
    });
  } catch (error) {
    console.error('login error', error);
    return json({ success: false, error: '登录服务异常，请稍后重试' }, 500);
  }
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function publicUser(user) {
  return {
    id: String(user.id),
    username: String(user.username),
    name: String(user.name || user.username),
    route: normalizeRoute(user.route),
    vehicle: String(user.vehicle || '')
  };
}

async function verifyPassword(password, encoded) {
  try {
    const [salt, stored] = String(encoded).split(':');
    if (!salt || !stored) return false;
    const derived = await derivePassword(password, decodeBase64(salt));
    return timingSafeEqual(derived, decodeBase64(stored));
  } catch {
    return false;
  }
}

async function derivePassword(password, salt) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, material, 256);
  return new Uint8Array(bits);
}

function decodeBase64(value) {
  const raw = atob(String(value || ''));
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function parseRecord(value) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try {
    const first = JSON.parse(value);
    if (typeof first === 'string') return JSON.parse(first);
    return first;
  } catch {
    return null;
  }
}

async function redisGet(env, key) {
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
    cache: 'no-store'
  });
  if (!response.ok) throw new Error('Redis 读取失败');
  const data = await response.json().catch(() => ({}));
  return data.result || null;
}

function redisReady(env) {
  return Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN);
}

function normalizeRoute(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  return m ? `${String(parseInt(m[1] || m[2], 10)).padStart(2, '0')}号线` : s;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
