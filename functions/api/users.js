// functions/api/users.js
// 用户管理 API

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method;

  const UPSTASH_URL = env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = env.UPSTASH_REDIS_REST_TOKEN;

  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return new Response(JSON.stringify({ error: 'Redis not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const REDIS_KEY = 'admin_users';

  // ============================================================
  // GET - 获取所有用户
  // ============================================================
  if (method === 'GET') {
    try {
      const resp = await fetch(`${UPSTASH_URL}/get/${REDIS_KEY}`, {
        headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
      });
      if (!resp.ok) {
        return new Response(JSON.stringify({ users: [] }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const data = await resp.json();
      let users = [];
      if (data.result) {
        try {
          users = JSON.parse(data.result);
        } catch (e) {
          users = [];
        }
      }
      return new Response(JSON.stringify({ users }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // ============================================================
  // POST - 保存所有用户
  // ============================================================
  if (method === 'POST') {
    try {
      const body = await request.json();
      const users = body.users || [];
      const resp = await fetch(`${UPSTASH_URL}/set/${REDIS_KEY}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${UPSTASH_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(JSON.stringify(users))
      });
      if (!resp.ok) {
        return new Response(JSON.stringify({ error: 'Failed to save users' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ success: true, users }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' }
  });
}