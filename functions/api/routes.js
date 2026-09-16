// 天友智配One - 线路基准数据库 API
// 当前版本仅服务17号线；基准库按线路独立保存于 Upstash。
// 如果 Upstash 尚未初始化，则自动从项目内 data/base_data.json 初始化一次。
import { authRequired } from './_auth.js';

const LOCK_TTL_SECONDS = 15;
const STATIC_BASE_PATH = '/data/base_data.json';

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

      let record = parseRecord(result.result);

      // Redis 没有基准库时，用仓库中的最新基准数据初始化。
      // 初始化只在 Redis 为空时执行，不会覆盖管理员已经保存的线路修改。
      if (!Array.isArray(record?.stores) || !record.stores.length) {
        const seed = await loadStaticBase(request, route);
        if (seed?.stores?.length) {
          const stores = normalizeStores(seed.stores);
          const updatedAt = seed.updatedAt || new Date().toISOString();
          const value = { route, stores, updatedAt, source: 'data/base_data.json' };
          const saved = await redisSet(env, key, value);
          if (!saved.ok) return json({ error: '线路基准数据库初始化失败' }, 500);
          record = value;
        }
      }

      return json({
        route,
        stores: Array.isArray(record?.stores) ? record.stores : [],
        source: record?.source || 'server',
        updatedAt: record?.updatedAt || null
      });
    }

    if (request.method === 'PUT') {
      const body = await request.json().catch(() => ({}));
      if (!Array.isArray(body.stores)) return json({ error: 'stores 必须是数组' }, 400);

      const lockKey = `lock:route-base:${route}`;
      const lockValue = crypto.randomUUID();
      if (!(await acquireLock(env, lockKey, lockValue, LOCK_TTL_SECONDS))) return json({ error: '该线路基准库正在被修改，请稍后重试' }, 409);

      try {
        const stores = normalizeStores(body.stores);
        const updatedAt = new Date().toISOString();
        const value = { route, stores, updatedAt, source: 'route-editor' };
        const saved = await redisSet(env, key, value);
        if (!saved.ok) return json({ error: '线路基准数据库保存失败' }, 500);
        return json({ success: true, route, stores, storeCount: stores.length, source: 'server', updatedAt });
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

function normalizeStores(stores) {
  return stores
    .map((store, index) => ({
      ...store,
      code: String(store?.code || index + 1).padStart(2, '0'),
      routeOrder: index + 1,
      name: String(store?.name || '').trim(),
      nav: String(store?.nav || '').trim(),
      note: String(store?.note || '').trim()
    }))
    .filter(store => store.name);
}

async function loadStaticBase(request, route) {
  try {
    const response = await fetch(new URL(STATIC_BASE_PATH, request.url), { cache: 'no-store' });
    if (!response.ok) return null;
    const data = await response.json();
    if (normalizeRoute(data?.line) !== route) return null;
    return data;
  } catch (error) {
    console.error('static base load error', error);
    return null;
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
    body: JSON.stringify(value),
    cache: 'no-store'
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok && (data.result === undefined || data.result === 'OK') };
}

function parseRecord(value) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try {
    const first = JSON.parse(value);
    if (typeof first === 'string') {
      try { return JSON.parse(first); } catch { return first; }
    }
    return first;
  } catch {
    return null;
  }
}

function normalizeRoute(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  return m ? `${String(parseInt(m[1] || m[2], 10)).padStart(2, '0')}号线` : s;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
