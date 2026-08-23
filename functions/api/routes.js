// functions/api/routes.js
// 线路数据 API（替代原来的 [route].js）

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const route = url.searchParams.get('route');
  const method = request.method;

  if (!route) {
    return new Response(JSON.stringify({ error: 'Missing route parameter' }), {
      status: 400,
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

  const redisKey = `route:${route}`;

  // ============================================================
  // GET - 获取线路数据
  // ============================================================
  if (method === 'GET') {
    try {
      const resp = await fetch(`${UPSTASH_URL}/get/${redisKey}`, {
        headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
      });
      if (!resp.ok) {
        return new Response(JSON.stringify({ route, stores: [] }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const data = await resp.json();
      let stores = [];
      if (data.result) {
        try {
          const parsed = JSON.parse(data.result);
          stores = parsed.stores || [];
        } catch (e) {}
      }
      return new Response(JSON.stringify({ route, stores }), {
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
  // PUT - 保存线路数据
  // ============================================================
  if (method === 'PUT') {
    try {
      const body = await request.json();
      const dataToSave = JSON.stringify({
        route: route,
        stores: body.stores || [],
        updatedAt: new Date().toISOString()
      });
      const resp = await fetch(`${UPSTASH_URL}/set/${redisKey}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${UPSTASH_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(dataToSave)
      });
      if (!resp.ok) {
        return new Response(JSON.stringify({ error: 'Failed to save route' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ success: true }), {
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