// 天友智配One - 线路基准数据库 API
// 当前版本仅服务17号线；基准库按线路独立保存于 Upstash。
import { authRequired } from './_auth.js';

const LOCK_TTL_SECONDS = 15;

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const route = normalizeRoute(url.searchParams.get('route'));
  if (!route) return json({ error: 'Missing route parameter' }, 400);
  if (route !== '17号线') return json({ error: '当前仅支持17号线' }, 403);
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);

  const session = await authRequired(request, env, { route });
  if (!session) return json({ error: '未登录或无权访问该线路数据' }, 401);

  const key = `route:${route}:base`;
  try {
    if (request.method === 'GET') {
      const result = await redisGet(env, key);
      if (!result.ok) return json({ error: '线路基准数据库读取失败' }, 502);
      const record = parseRecord(result.result);
      return json({ route, stores: Array.isArray(record?.stores) ? record.stores : [], source: 'server', updatedAt: record?.updatedAt || null });
    }

    if (request.method === 'PUT') {
      const body = await request.json().catch(() => ({}));
      if (!Array.isArray(body.stores)) return json({ error: 'stores 必须是数组' }, 400);

      const lockKey = `lock:route-base:${route}`;
      const lockValue = crypto.randomUUID();
      if (!(await acquireLock(env, lockKey, lockValue, LOCK_TTL_SECONDS))) return json({ error: '该线路基准库正在被修改，请稍后重试' }, 409);

      try {
        const stores = body.stores.map((store, index) => ({
          ...store,
          code: String(store?.code || index + 1).padStart(2, '0'),
          routeOrder: index + 1
        }));
        const value = { route, stores, updatedAt: new Date().toISOString() };
        const saved = await redisSet(env, key, value);
        if (!saved.ok) return json({ error: '线路基准数据库保存失败' }, 500);
        return json({ success: true, route, storeCount: stores.length, source: 'server' });
      } finally {
        await releaseLock(env, lockKey, lockValue).catch(() => {});
      }
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('routes api error', error);
    return json({ error: '线路基准数据库服务异常' }, 503);
  }
}

async function acquireLock(env, key, value, ttl) {
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/NX/EX/${ttl}`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store'
  });
  if (!response.ok) return false;
  const data = await response.json().catch(() => ({}));
  return data.result === 'OK';
}

async function releaseLock(env, key, value) {
  const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/eval`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([script, 1, key, value]),
    cache: 'no-store'
  });
  if (response.ok) await response.json().catch(() => null);
}

async function redisGet(env, key) {
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, result: data.result };
}

async function redisSet(env, key, value) {
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(value)),
    cache: 'no-store'
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok && (data.result === undefined || data.result === 'OK') };
}

function parseRecord(value) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function normalizeRoute(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  return m ? `${String(parseInt(m[1] || m[2], 10)).padStart(2, '0')}号线` : s;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
