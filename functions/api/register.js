// 天友智配One - 用户注册
// 注册只创建最小账号资料；姓名、线路、车辆进入系统后再设置。
import { createSession, sessionCookie } from './_auth.js';
import { publicUser, redisCommand } from './_data.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
  if (!redisReady(env)) return json({ success: false, error: '注册服务未配置，请检查 Upstash 配置' }, 500);
  if (!env.SESSION_SECRET) return json({ success: false, error: 'SESSION_SECRET 未配置，注册服务暂不可用' }, 500);

  try {
    const body = await request.json().catch(() => ({}));
    const username = normalizeUsername(body.username);
    const password = String(body.password || '');

    if (!/^[a-z0-9_]{3,32}$/.test(username)) return json({ success: false, error: '用户名需为3-32位字母、数字或下划线' }, 400);
    if (password.length < 6 || password.length > 72) return json({ success: false, error: '密码需为6-72位' }, 400);

    const usernameKey = `user:username:${encodeURIComponent(username)}`;
    const existing = await redisCommand(env, ['GET', usernameKey]);
    if (existing) return json({ success: false, error: '用户名已存在，请换一个用户名' }, 409);

    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    const now = new Date().toISOString();
    const user = {
      id,
      username,
      name: username,
      phone: '',
      boundRouteId: '',
      route: '',
      vehicle: '',
      role: 'driver',
      passwordHash,
      status: 'active',
      sessionVersion: 1,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now
    };

    const claim = await redisCommand(env, ['SET', usernameKey, id, 'NX']);
    if (claim !== 'OK') return json({ success: false, error: '用户名已存在，请换一个用户名' }, 409);

    try {
      const saved = await redisCommand(env, ['SET', `user:${id}`, JSON.stringify(user)]);
      if (saved !== 'OK') throw new Error('用户保存失败');
    } catch (error) {
      await redisCommand(env, ['DEL', usernameKey]).catch(() => {});
      throw error;
    }

    const safeUser = publicUser(user);
    const token = await createSession(env, safeUser);
    return new Response(JSON.stringify({ success: true, user: safeUser, needSetup: true }), {
      status: 201,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': sessionCookie(token)
      }
    });
  } catch (error) {
    console.error('register error', error);
    return json({ success: false, error: '注册服务异常，请稍后重试', detail: safeError(error) }, 500);
  }
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  // Cloudflare Workers 当前 Web Crypto 对 PBKDF2 的迭代上限为 100000。
  const iterations = 100000;
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, material, 256);
  return `pbkdf2-sha256$${iterations}$${base64(salt)}:${base64(new Uint8Array(bits))}`;
}

async function redisCommand(env, command) {
  const url = String(env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
  const token = String(env.UPSTASH_REDIS_REST_TOKEN || '');
  const response = await fetch(`${url}/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command),
    cache: 'no-store'
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!response.ok || data.error) throw new Error(data.error || `Upstash HTTP ${response.status}`);
  return data.result;
}

function base64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function redisReady(env) {
  return Boolean(String(env.UPSTASH_REDIS_REST_URL || '').trim() && String(env.UPSTASH_REDIS_REST_TOKEN || '').trim());
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function safeError(error) {
  const message = String(error?.message || error || '').trim();
  return message ? message.slice(0, 180) : 'unknown';
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
