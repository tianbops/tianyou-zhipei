// 历史查询 API：服务器为唯一真实数据源。
import { authRequired } from './_auth.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);

  const session = await authRequired(request, env);
  if (!session) return json({ error: '登录已失效或无权限' }, 401);

  const url = new URL(request.url);
  const date = url.searchParams.get('date');
  if (!date) return json({ error: 'Missing date parameter' }, 400);

  // 普通用户的线路完全由服务器 Session 决定，忽略客户端传入的 route。
  // 管理员可以按 route 查询指定线路。
  const requestedRoute = normalizeRoute(url.searchParams.get('route') || '');
  const route = session.role === 'admin' ? requestedRoute : normalizeRoute(session.route);
  if (!route) return json({ error: '用户未绑定线路' }, 403);

  try {
    const redisKey = `history:${route}:${date}`;
    const resp = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(redisKey)}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
      cache: 'no-store'
    });
    if (!resp.ok) return json({ error: '历史数据读取失败' }, 502);
    const data = await resp.json();
    let result = [];
    if (data.result) {
      try { result = JSON.parse(data.result); } catch { result = []; }
    }
    return json({ success: true, route, date, data: Array.isArray(result) ? result : [] });
  } catch (e) {
    return json({ error: '历史数据服务异常' }, 500);
  }
}

function normalizeRoute(v) {
  const s = String(v || '').trim();
  const m = s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  return m ? `${String(parseInt(m[1] || m[2], 10)).padStart(2, '0')}号线` : s;
}
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
