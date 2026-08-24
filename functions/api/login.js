// functions/api/login.js
// 登录验证 API
// 说明：密码只在服务端与 Upstash 中比较，前端不再获取完整用户密码。

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const UPSTASH_URL = env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = env.UPSTASH_REDIS_REST_TOKEN;

  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return new Response(JSON.stringify({ error: 'Redis not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const body = await request.json();
    const type = body.type === 'admin' ? 'admin' : 'route';
    const account = String(body.account || '').trim();
    const password = String(body.password || '');

    if (!account || !password) {
      return new Response(JSON.stringify({ success: false, error: '账号和密码不能为空' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const resp = await fetch(`${UPSTASH_URL}/get/admin_users`, {
      headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
    });

    if (!resp.ok) {
      return new Response(JSON.stringify({ success: false, error: '用户数据服务不可用' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const data = await resp.json();
    let users = [];
    if (data.result) {
      try { users = JSON.parse(data.result); } catch { users = []; }
    }

    if (!Array.isArray(users)) users = [];

    let user;
    if (type === 'admin') {
      user = users.find(u => u.role === 'admin' && String(u.name || '').trim() === account);
    } else {
      const route = normalizeRoute(account);
      user = users.find(u => u.role !== 'admin' && normalizeRoute(u.route) === route);
    }

    if (!user || String(user.password ?? '') !== password) {
      return new Response(JSON.stringify({ success: false, error: '账号或密码错误' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      user: {
        id: user.id,
        name: user.name || '',
        route: normalizeRoute(user.route || ''),
        role: user.role || 'driver'
      }
    }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: '登录服务异常' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

function normalizeRoute(input) {
  const value = String(input || '').trim();
  const match = value.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  if (!match) return value;
  return `${String(parseInt(match[1] || match[2], 10)).padStart(2, '0')}号线`;
}
