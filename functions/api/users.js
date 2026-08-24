// functions/api/users.js
// 用户管理 API
// 安全规则：GET/POST 响应均不返回 password，密码只允许在服务端登录验证时使用。

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method;

  const UPSTASH_URL = env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = env.UPSTASH_REDIS_REST_TOKEN;

  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return json({ error: 'Redis not configured' }, 500);
  }

  const REDIS_KEY = 'admin_users';

  if (method === 'GET') {
    try {
      const users = await readUsers(UPSTASH_URL, UPSTASH_TOKEN, REDIS_KEY);
      return json({ users: sanitizeUsers(users) });
    } catch (e) {
      return json({ error: '用户数据服务不可用', users: [] }, 503);
    }
  }

  if (method === 'POST') {
    try {
      const body = await request.json();
      if (!Array.isArray(body.users)) {
        return json({ error: 'users 必须是数组' }, 400);
      }

      // POST 仍允许现有管理端保存完整用户对象，密码由服务端原样写入 Upstash；
      // 但响应绝不把密码返回给浏览器。
      const resp = await fetch(`${UPSTASH_URL}/set/${REDIS_KEY}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${UPSTASH_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(JSON.stringify(body.users))
      });

      if (!resp.ok) {
        return json({ error: '保存用户失败' }, 500);
      }

      return json({ success: true, users: sanitizeUsers(body.users) });
    } catch (e) {
      return json({ error: '保存用户失败' }, 500);
    }
  }

  return json({ error: 'Method not allowed' }, 405);
}

async function readUsers(url, token, key) {
  const resp = await fetch(`${url}/get/${key}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!resp.ok) throw new Error('Upstash request failed');

  const data = await resp.json();
  if (!data.result) return [];

  try {
    const users = JSON.parse(data.result);
    return Array.isArray(users) ? users : [];
  } catch {
    return [];
  }
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
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
