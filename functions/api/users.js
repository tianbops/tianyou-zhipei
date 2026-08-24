// functions/api/users.js
// 管理员用户管理 API：真实读取/写入 Upstash admin_users。
// GET/POST 均要求管理员会话；返回数据永远不包含 password。
import { authRequired } from './_auth.js';

const REDIS_KEY = 'admin_users';
const DEFAULT_USERS = [
  { id: 1, name: 'tianbo', route: '', role: 'admin', password: '203526', createdAt: '2026-08-25T00:00:00.000Z' },
  { id: 17, name: '17号线', route: '17号线', role: 'driver', password: 'tianyou2024', createdAt: '2026-08-25T00:00:00.000Z' }
];

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

    // T1 数据迁移/初始化：如果历史版本没有 admin_users，自动建立正式账号。
    // 如果已有数据，只补齐缺失的正式账号，不覆盖已有用户资料。
    const seeded = ensureDefaultUsers(users);
    if (seeded.changed) {
      users = seeded.users;
      await saveUsers(UPSTASH_URL, UPSTASH_TOKEN, users);
    }

    if (method === 'GET') return json({ success: true, users: sanitizeUsers(users) });

    if (method === 'POST') {
      const body = await request.json();
      if (!Array.isArray(body.users)) return json({ error: 'users 必须是数组' }, 400);

      // 管理端读取的是脱敏数据，保存时从服务器原始数据恢复未提交的密码。
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

      // 不允许管理员管理接口把两个正式账号删除掉。
      for (const required of DEFAULT_USERS) {
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
    return json({ error: '用户数据服务不可用', detail: e?.message || '' }, 503);
  }
}

async function readUsers(url, token) {
  const resp = await fetch(`${url}/get/${REDIS_KEY}`, { headers: { Authorization: `Bearer ${token}` } });
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
    body: JSON.stringify(JSON.stringify(users))
  });
  if (!resp.ok) throw new Error('保存用户失败');
}

function ensureDefaultUsers(users) {
  const list = Array.isArray(users) ? [...users] : [];
  let changed = false;
  for (const required of DEFAULT_USERS) {
    const index = list.findIndex(u => String(u?.id) === String(required.id) || normalizeRoute(u?.route) === normalizeRoute(required.route));
    if (index < 0) {
      list.push({ ...required });
      changed = true;
      continue;
    }
    // 正式账号密码只在缺失时恢复，避免管理员主动修改密码被覆盖。
    if (!list[index].password) {
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
