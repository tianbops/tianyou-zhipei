// functions/api/users.js
// 管理员用户管理 API：真实读取/写入 Upstash admin_users。
// GET/POST 均要求管理员会话；返回数据永远不包含 password。
// 初始账号密码只允许来自 Cloudflare 环境变量，不再硬编码在公开代码中。
import { authRequired } from './_auth.js';

const REDIS_KEY = 'admin_users';

function defaultUsers(env) {
  return [
    {
      id: 1,
      name: String(env.DEFAULT_ADMIN_NAME || 'tianbo').trim(),
      route: '',
      role: 'admin',
      password: String(env.DEFAULT_ADMIN_PASSWORD || '').trim(),
      createdAt: '2026-08-25T00:00:00.000Z'
    },
    {
      id: 17,
      name: '17号线',
      route: '17号线',
      role: 'driver',
      password: String(env.DEFAULT_DRIVER_PASSWORD || '').trim(),
      createdAt: '2026-08-25T00:00:00.000Z'
    }
  ].filter(u => u.password);
}

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method;
  const UPSTASH_URL = env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = env.UPSTASH_REDIS_REST_TOKEN;
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return json({ error: 'Redis not configured' }, 500);

  const session = await authRequired(request, env, { admin: true });
  if (!session) return json({ error: '管理员登录已失效或无权限' }, 401);

  try {
    let users = await readUsers(UPSTASH_URL, UPSTASH_TOKEN);

    // 只在服务器已有用户数据时做结构迁移；空库初始化依赖环境变量。
    const seeded = ensureDefaultUsers(users, env);
    if (seeded.changed) {
      users = seeded.users;
      await saveUsers(UPSTASH_URL, UPSTASH_TOKEN, users);
    }

    if (method === 'GET') return json({ success: true, users: sanitizeUsers(users) });

    if (method === 'POST') {
      const body = await request.json();
      if (!Array.isArray(body.users)) return json({ error: 'users 必须是数组' }, 400);

      const byId = new Map(users.map(u => [String(u?.id), u]));
      const byRoute = new Map(users.map(u => [normalizeRoute(u?.route), u]));
      const merged = body.users.map(input => {
        const old = byId.get(String(input?.id)) || byRoute.get(normalizeRoute(input?.route));
        const user = { ...(old || {}), ...(input || {}) };
        if (!Object.prototype.hasOwnProperty.call(input || {}, 'password') || !input.password) {
          if (old?.password) user.password = old.password;
          else delete user.password;
        }
        return user;
      });

      // 正式账号不能被管理接口误删除；仅当环境变量提供初始密码时才补建。
      for (const required of defaultUsers(env)) {
        if (!merged.some(u => u && (String(u.id) === String(required.id) || normalizeRoute(u.route) === normalizeRoute(required.route)) && u.role === required.role)) {
          merged.push(required);
        }
      }

      await saveUsers(UPSTASH_URL, UPSTASH_TOKEN, merged);
      return json({ success: true, users: sanitizeUsers(merged) });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (e) {
    console.error('users api error', e);
    return json({ error: '用户数据服务不可用' }, 503);
  }
}

async function readUsers(url, token) {
  const resp = await fetch(`${url}/get/${REDIS_KEY}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!resp.ok) throw new Error('Upstash request failed');
  const data = await resp.json();
  if (!data.result) return [];
  try {
    const users = JSON.parse(data.result);
    return Array.isArray(users) ? users : [];
  } catch { return []; }
}

async function saveUsers(url, token, users) {
  const resp = await fetch(`${url}/set/${REDIS_KEY}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(users)),
    cache: 'no-store'
  });
  if (!resp.ok) throw new Error('保存用户失败');
  const data = await resp.json().catch(() => ({}));
  if (data.result !== undefined && data.result !== 'OK') throw new Error('保存用户未确认');
}

function ensureDefaultUsers(users, env) {
  const list = Array.isArray(users) ? [...users] : [];
  let changed = false;
  for (const required of defaultUsers(env)) {
    const index = list.findIndex(u => String(u?.id) === String(required.id) || normalizeRoute(u?.route) === normalizeRoute(required.route));
    if (index < 0) {
      list.push({ ...required });
      changed = true;
      continue;
    }
    // 只恢复缺失密码，不覆盖管理员已经主动修改的密码。
    if (!list[index].password && required.password) {
      list[index] = { ...list[index], password: required.password };
      changed = true;
    }
    if (required.id === 1 && list[index].role !== 'admin') {
      list[index] = { ...list[index], role: 'admin', name: list[index].name || required.name };
      changed = true;
    }
  }
  return { users: list, changed };
}

function normalizeRoute(input) {
  const value = String(input || '').trim();
  const match = value.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  return match ? `${String(parseInt(match[1] || match[2], 10)).padStart(2, '0')}号线` : value;
}

function sanitizeUsers(users) {
  return users.map(user => {
    const { password, ...safeUser } = user || {};
    return safeUser;
  });
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
