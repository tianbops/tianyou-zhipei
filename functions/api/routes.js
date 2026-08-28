// functions/api/routes.js
// 每条线路 = 一个独立用户 = 一个独立基准数据库。
// 普通用户只能读取/修改自己的线路；管理员可管理指定线路。
import { authRequired } from './_auth.js';

const LOCK_TTL_SECONDS = 15;

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const route = normalizeRoute(url.searchParams.get('route'));
  const method = request.method;
  if (!route) return json({ error: 'Missing route parameter' }, 400);
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);

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
          const p = typeof r.result === 'string' ? JSON.parse(r.result) : r.result;
          const data = typeof p === 'string' ? JSON.parse(p) : p;
          stores = Array.isArray(data?.stores) ? data.stores : [];
        } catch (_) {}
      }
      return json({ route, stores, source: 'server', updatedAt: getUpdatedAt(r.result) });
    }

    if (method === 'PUT') {
      const body = await request.json();
      if (!Array.isArray(body.stores)) return json({ error: 'stores 必须是数组' }, 400);

      const lockKey = `lock:route-base:${route}`;
      const lockValue = crypto.randomUUID();
      const locked = await acquireLock(env, lockKey, lockValue, LOCK_TTL_SECONDS);
      if (!locked) return json({ error: '该线路基准库正在被其他操作修改，请稍后重试' }, 409);

      try {
        const stores = body.stores.map((store, index) => ({
          ...store,
          code: String(store?.code || index + 1).padStart(2, '0'),
          routeOrder: index + 1
        }));
        const value = { route, stores, updatedAt: new Date().toISOString() };
        const r = await redisSet(env, key, value);
        if (!r.ok) return json({ error: '线路基准数据库保存失败' }, 500);
        return json({ success: true, route, storeCount: stores.length, source: 'server' });
      } finally {
        await releaseLock(env, lockKey, lockValue).catch(() => {});
      }
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (e) {
    console.error('routes api error', e);
    return json({ error: '线路基准数据库服务异常' }, 500);
  }
}

async function acquireLock(env, key, value, ttl) {
  const r = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/NX/EX/${ttl}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
    cache: 'no-store'
  });
  if (!r.ok) return false;
  const d = await r.json().catch(() => ({}));
  return d.result === 'OK';
}

async function releaseLock(env, key, value) {
  // Lua 保证只有持有者才能释放锁，避免误删其他请求的新锁。
  const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
  const r = await fetch(`${env.UPSTASH_REDIS_REST_URL}/eval`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([script, 1, key, value]),
    cache: 'no-store'
  });
  if (!r.ok) return;
  await r.json().catch(() => null);
}

async function redisGet(env, key) {
  const r = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
    cache: 'no-store'
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, result: d.result };
}

async function redisSet(env, key, value) {
  const r = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(JSON.stringify(value)),
    cache: 'no-store'
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok && (d.result === undefined || d.result === 'OK'), result: d.result };
}

function getUpdatedAt(value) {
  try {
    const a = typeof value === 'string' ? JSON.parse(value || '{}') : value;
    const data = typeof a === 'string' ? JSON.parse(a) : a;
    return data?.updatedAt || null;
  } catch { return null; }
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
