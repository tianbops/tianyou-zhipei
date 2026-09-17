// 天友智配One - 用户注册
// 注册只创建最小账号资料；姓名、线路、车辆进入系统后再设置。
import { createSession, sessionCookie } from './_auth.js';

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
    if (await redisGet(env, usernameKey)) return json({ success: false, error: '用户名已存在，请换一个用户名' }, 409);

    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    const now = new Date().toISOString();
    const user = {
      id,
      username,
      name: username,
      route: '',
      vehicle: '',
      passwordHash,
      status: 'active',
      sessionVersion: 1,
      createdAt: now,
      updatedAt: now
    };

    const userClaim = await redisSetNx(env, usernameKey, id);
    if (!userClaim) return json({ success: false, error: '用户名已存在，请换一个用户名' }, 409);

    const saved = await redisSet(env, `user:${id}`, user);
    if (!saved) {
      await redisDelete(env, usernameKey);
      return json({ success: false, error: '用户保存失败，请稍后重试' }, 500);
    }

    const safeUser = { id, username, name: username, route: '', vehicle: '' };
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
    return json({ success: false, error: '注册服务异常，请稍后重试' }, 500);
  }
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, material, 256);
  return `${base64(salt)}:${base64(new Uint8Array(bits))}`;
}

function base64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function redisGet(env, key) {
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store'
  });
  if (!response.ok) throw new Error('Redis 读取失败');
  const data = await response.json().catch(() => ({}));
  return data.result || null;
}

async function redisSetNx(env, key, value) {
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/NX`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store'
  });
  if (!response.ok) throw new Error('Redis 写入失败');
  const data = await response.json().catch(() => ({}));
  return data.result === 'OK';
}

async function redisSet(env, key, value) {
  const encodedValue = encodeURIComponent(JSON.stringify(value));
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodedValue}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
    cache: 'no-store'
  });
  const data = await response.json().catch(() => ({}));
  return response.ok && data.result === 'OK';
}

async function redisDelete(env, key) {
  await fetch(`${env.UPSTASH_REDIS_REST_URL}/del/${encodeURIComponent(key)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store'
  }).catch(() => {});
}

function redisReady(env) { return Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN); }
function normalizeUsername(value) { return String(value || '').trim().toLowerCase(); }
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
