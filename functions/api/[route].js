export async function onRequest(context) {
  const { request, params, env } = context;
  const route = params.route;
  const method = request.method;

  const UPSTASH_URL = env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = env.UPSTASH_REDIS_REST_TOKEN;

  if (method === 'GET') {
    const redisKey = `route:${route}`;
    const resp = await fetch(`${UPSTASH_URL}/get/${redisKey}`, {
      headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
    });
    if (!resp.ok) {
      // 返回空数据或默认数据
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
  }

  if (method === 'PUT') {
    // 保存线路数据（可选）
    const body = await request.json();
    const redisKey = `route:${route}`;
    await fetch(`${UPSTASH_URL}/set/${redisKey}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(JSON.stringify(body))
    });
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
}
