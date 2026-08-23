// functions/api/history.js
// 历史查询 API（替代原来的 history/[date].js）

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const date = url.searchParams.get('date');
  const route = url.searchParams.get('route');

  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!date || !route) {
    return new Response(JSON.stringify({ error: 'Missing date or route parameter' }), {
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

  try {
    const redisKey = `history:${route}:${date}`;
    const resp = await fetch(`${UPSTASH_URL}/get/${redisKey}`, {
      headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
    });
    if (!resp.ok) {
      return new Response(JSON.stringify([]), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const data = await resp.json();
    let result = [];
    if (data.result) {
      try {
        result = JSON.parse(data.result);
      } catch (e) {
        result = [];
      }
    }
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}