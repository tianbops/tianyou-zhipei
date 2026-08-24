// functions/api/users.js
// 用户管理 API
// GET 不返回 password；POST 对缺失 password 的用户保留服务端原密码，避免管理端读取脱敏数据后覆盖密码。

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method;
  const UPSTASH_URL = env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = env.UPSTASH_REDIS_REST_TOKEN;
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return json({ error: 'Redis not configured' }, 500);
  const REDIS_KEY = 'admin_users';

  if (method === 'GET') {
    try {
      const users = await readUsers(UPSTASH_URL, UPSTASH_TOKEN, REDIS_KEY);
      return json({ users: sanitizeUsers(users) });
    } catch {
      return json({ error: '用户数据服务不可用', users: [] }, 503);
    }
  }

  if (method === 'POST') {
    try {
      const body = await request.json();
      if (!Array.isArray(body.users)) return json({ error: 'users 必须是数组' }, 400);

      // 管理端拿到的是脱敏用户资料。保存时从服务端原始数据恢复未提交的密码。
      const existing = await readUsers(UPSTASH_URL, UPSTASH_TOKEN, REDIS_KEY);
      const byId = new Map(existing.map(u => [String(u?.id), u]));
      const byRoute = new Map(existing.map(u => [normalizeRoute(u?.route), u]));
      const merged = body.users.map(input => {
        const old = byId.get(String(input?.id)) || byRoute.get(normalizeRoute(input?.route));
        const user = { ...(old || {}), ...(input || {}) };
        if (!Object.prototype.hasOwnProperty.call(input || {}, 'password') || !input.password) {
          if (old?.password) user.password = old.password;
          else delete user.password;
        }
        return user;
      });

      const resp = await fetch(`${UPSTASH_URL}/set/${REDIS_KEY}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(JSON.stringify(merged))
      });
      if (!resp.ok) return json({ error: '保存用户失败' }, 500);
      return json({ success: true, users: sanitizeUsers(merged) });
    } catch (e) {
      console.error('users save error', e);
      return json({ error: '保存用户失败' }, 500);
    }
  }
  return json({ error: 'Method not allowed' }, 405);
}

async function readUsers(url, token, key) {
  const resp = await fetch(`${url}/get/${key}`, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!resp.ok) throw new Error('Upstash request failed');
  const data = await resp.json();
  if (!data.result) return [];
  try {
    const users = JSON.parse(data.result);
    return Array.isArray(users) ? users : [];
  } catch { return []; }
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
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
