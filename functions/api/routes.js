// functions/api/routes.js
// 每条线路 = 一个独立用户 = 一个独立基准数据库。
// 普通用户只能读取/修改自己的线路；管理员可管理指定线路。
import { authRequired } from './_auth.js';

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const route = normalizeRoute(url.searchParams.get('route'));
  const method = request.method;
  if (!route) return json({ error: 'Missing route parameter' }, 400);
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);

  // GET 同样必须认证，不能仅凭 URL 参数读取其他线路的基准数据库。
  const session = await authRequired(request, env, { route });
  if (!session) return json({ error: '未登录或无权访问该线路数据' }, 401);

  const key = `route:${route}:base`;
  try {
    if (method === 'GET') {
      const r = await redisGet(env, key);
      if (!r.ok) return json({ error: '线路基准数据库读取失败' }, 502);
      let stores = [];
      if (r.result) {
        try {
          const p = JSON.parse(r.result);
          stores = Array.isArray(p?.stores) ? p.stores : [];
        } catch (_) {}
      }
      return json({ route, stores, source: 'server', updatedAt: getUpdatedAt(r.result) });
    }

    if (method === 'PUT') {
      const body = await request.json();
      if (!Array.isArray(body.stores)) return json({ error: 'stores 必须是数组' }, 400);

      // 基准数据库保持顺序；服务端生成顺序号，防止客户端伪造排序结果。
      const stores = body.stores.map((store, index) => ({
        ...store,
        code: String(store?.code || index + 1).padStart(2, '0'),
        routeOrder: index + 1
      }));
      const value = JSON.stringify({ route, stores, updatedAt: new Date().toISOString() });
      const r = await redisSet(env, key, value);
      if (!r.ok) return json({ error: '线路基准数据库保存失败' }, 500);
      return json({ success: true, route, storeCount: stores.length, source: 'server' });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (e) {
    console.error('routes api error', e);
    return json({ error: '线路基准数据库服务异常' }, 500);
  }
}

async function redisGet(env, key) {
  const r = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, result: d.result };
}

async function redisSet(env, key, value) {
  return fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(value)
  });
}

function getUpdatedAt(value) {
  try { return JSON.parse(value || '{}')?.updatedAt || null; } catch { return null; }
}

function normalizeRoute(v) {
  const s = String(v || '').trim();
  const m = s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  return m ? `${String(parseInt(m[1] || m[2], 10)).padStart(2, '0')}号线` : s;
}

function json(p, status = 200) {
  return new Response(JSON.stringify(p), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
