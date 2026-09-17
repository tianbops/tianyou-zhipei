// Zhipei One - 微信小程序登录入口
// 当前未配置微信 AppID/Secret 时，作为现有账号密码登录的安全桥接入口。
// 正式接入微信后，这里只负责把微信身份绑定到现有 userId，不创建第二套用户。
import { createMiniToken } from './_auth.js';

export async function onRequestPost({ request, env }) {
  if (request.method !== 'POST') return json({ message: 'Method not allowed' }, 405);
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    return json({ message: '登录服务未配置，请检查 Upstash 配置' }, 500);
  }
  if (!env.SESSION_SECRET) return json({ message: 'SESSION_SECRET 未配置' }, 500);

  try {
    const body = await request.json().catch(() => ({}));
    const username = normalizeUsername(body.username || body.account);
    const password = String(body.password || '');
    const code = String(body.code || '').trim();

    if (!username || !password) return json({ message: '请输入智配 One 账号和密码' }, 400);

    // 当前阶段允许小程序使用现有账号密码获取短期 Bearer Token。
    // code 仅作为未来微信身份绑定字段，不直接作为用户身份或 token。
    const userId = await redisGet(env, `user:username:${encodeURIComponent(username)}`);
    if (!userId) return json({ message: '用户名或密码错误' }, 401);

    const user = parseRecord(await redisGet(env, `user:${userId}`));
    if (!user || user.status === 'disabled') return json({ message: '用户不存在或已停用' }, 401);
    if (!user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
      return json({ message: '用户名或密码错误' }, 401);
    }

    const safeUser = publicUser(user);
    const token = await createMiniToken(env, user);
    return json({ success: true, token, user: safeUser, wxBindingRequired: Boolean(!code) });
  } catch (error) {
    console.error('mini-login error', error);
    return json({ message: '小程序登录服务异常，请稍后重试' }, 500);
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
    const value = String(encoded || '');
    let iterations = 100000;
    let salt;
    let stored;
    const parts = value.split('$');
    if (parts.length === 3 && parts[0] === 'pbkdf2-sha256') {
      iterations = Number(parts[1]);
      [salt, stored] = parts[2].split(':');
    } else {
      [salt, stored] = value.split(':');
    }
    if (!salt || !stored || !Number.isInteger(iterations) || iterations < 1 || iterations > 100000) return false;
    const derived = await derivePassword(password, decodeBase64(salt), iterations);
    return timingSafeEqual(derived, decodeBase64(stored));
  } catch {
    return false;
  }
}

async function derivePassword(password, salt, iterations = 100000) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, material, 256);
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

function normalizeRoute(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  return m ? `${String(parseInt(m[1] || m[2], 10)).padStart(2, '0')}号线` : s;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}
