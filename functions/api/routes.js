// 天友智配One V1.0 - 线路与基准数据库 API
import { authRequired } from './_auth.js';
import { baseKey as v3BaseKey, getBase as getV3Base, getRoute as getV3Route, isRouteMaintainer as isV3RouteMaintainer } from './v3/data.js';
import { normalizeStores, normalizeRoute } from './_data.js';

const LOCK_TTL_SECONDS = 20;

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const route = normalizeRoute(url.searchParams.get('route'));
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);

  const session = await authRequired(request, env, { allowAnyRoute: true });
  if (!session) return json({ error: '未登录或登录已失效' }, 401);

  try {
    if (request.method === 'GET') {
      if (!route) return json({ success: true, routes: await listRoutes(env) });
      const base = await getV3Base(env, route);
      if (!base) return json({ route, stores: [], source: 'server', updatedAt: null, dataVersion: 0, migrationRequired: true });
      return json({
        route,
        stores: normalizeStores(base.stores),
        source: 'v3',
        updatedAt: base.updatedAt || null,
        dataVersion: Number(base.dataVersion) || 1,
        schemaVersion: Number(base.schemaVersion) || 1,
        editable: isV3RouteMaintainer(session, route)
      });
    }

    if (request.method === 'PUT') {
      if (!route) return json({ error: 'Missing route parameter' }, 400);
      if (!isV3RouteMaintainer(session, route)) return json({ error: '当前账号可以调度该线路，但无权修改该线路基准数据库' }, 403);
      const body = await request.json().catch(() => ({}));
      if (!Array.isArray(body.stores)) return json({ error: 'stores 必须是数组' }, 400);
      const routeRecord = await getV3Route(env, route);
      if (!routeRecord) return json({ error: '线路不存在，请先由系统管理员创建该线路', code: 'ROUTE_NOT_FOUND' }, 404);

      const lockKey = `lock:route-base:${encodeURIComponent(route)}`;
      const lockValue = crypto.randomUUID();
      if (!(await acquireLock(env, lockKey, lockValue, LOCK_TTL_SECONDS))) return json({ error: '该线路基准库正在被修改，请稍后重试' }, 409);

      try {
        const current = await getV3Base(env, route);
        const currentVersion = Number(current?.dataVersion) || 0;
        const expectedVersion = body.expectedDataVersion === undefined || body.expectedDataVersion === null ? null : Number(body.expectedDataVersion);
        if (expectedVersion !== null && expectedVersion !== currentVersion) {
          return json({ error: '线路基准库已被其他维护用户更新，请刷新后再保存', code: 'DATA_CONFLICT', dataVersion: currentVersion }, 409);
        }
        const stores = normalizeStores(body.stores);
        const updatedAt = new Date().toISOString();
        const value = {
          schemaVersion: 3, route, stores, dataVersion: currentVersion + 1 || 1,
          updatedAt, updatedBy: session.id, source: 'route-editor'
        };
        const writeResult = await atomicSaveRouteBase(env, {
          lockKey,
          lockValue,
          baseKey: v3BaseKey(route),
          expectedVersion: currentVersion,
          value
        });
        if (writeResult === 'LOCK_LOST') return json({ error: '线路基准库锁已失效，请重新加载后保存', code: 'LOCK_LOST' }, 409);
        if (writeResult === 'BASE_MISSING') return json({ error: '线路基准数据库已不存在，请重新加载后保存', code: 'BASE_MISSING' }, 409);
        if (writeResult === 'VERSION_CONFLICT') return json({ error: '线路基准库已被其他维护操作更新，请刷新后再保存', code: 'DATA_CONFLICT' }, 409);
        return json({ success: true, route, stores, storeCount: stores.length, source: 'route', updatedAt, dataVersion: value.dataVersion, editable: true });
      } finally {
        await releaseLock(env, lockKey, lockValue).catch(() => {});
      }
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('routes api error', error);
    return json({ success: false, error: error?.message || '线路基准数据库服务异常', code: 'ROUTES_API_ERROR' }, 503);
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

async function atomicSaveRouteBase(env, { lockKey, lockValue, baseKey, expectedVersion, value }) {
  const script = `
local lock = redis.call('GET', KEYS[1])
if lock ~= ARGV[1] then return 'LOCK_LOST' end
if redis.call('EXISTS', KEYS[2]) ~= 1 then return 'BASE_MISSING' end
local current = redis.call('GET', KEYS[2])
if not current then return 'BASE_MISSING' end
local ok, parsed = pcall(cjson.decode, current)
if not ok or type(parsed) ~= 'table' then return 'VERSION_CONFLICT' end
local currentVersion = tonumber(parsed.dataVersion) or 0
if currentVersion ~= tonumber(ARGV[2]) then return 'VERSION_CONFLICT' end
redis.call('SET', KEYS[2], ARGV[3])
return 'OK'
`;
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/eval`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([script, 2, lockKey, baseKey, lockValue, String(expectedVersion), JSON.stringify(value)]),
    cache: 'no-store'
  });
  if (!response.ok) throw new Error('线路基准数据库原子写入失败');
  const data = await response.json().catch(() => ({}));
  return data.result;
}

async function releaseLock(env, key, value) {
  const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
  await fetch(`${env.UPSTASH_REDIS_REST_URL}/eval`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([script, 1, key, value]), cache: 'no-store'
  });
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function listRoutes(env) {
  let cursor = '0';
  const records = [];
  do {
    const response = await fetch(env.UPSTASH_REDIS_REST_URL + '/', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.UPSTASH_REDIS_REST_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SCAN', cursor, 'MATCH', 'zpei:v3:route:*', 'COUNT', '200']),
      cache: 'no-store'
    });
    if (!response.ok) throw new Error('线路列表读取失败');
    const data = await response.json().catch(() => ({}));
    cursor = String(data?.result?.[0] || '0');
    const keys = Array.isArray(data?.result?.[1]) ? data.result[1] : [];
    for (const key of keys) {
      if ((key.match(/:/g)||[]).length !== 3) continue;
      const value = await fetch(env.UPSTASH_REDIS_REST_URL + '/get/' + encodeURIComponent(key), {
        headers: { Authorization: 'Bearer ' + env.UPSTASH_REDIS_REST_TOKEN }, cache: 'no-store'
      }).then(r => r.json()).catch(() => ({}));
      const record = typeof value?.result === 'string' ? (() => { try { return JSON.parse(value.result); } catch { return null; } })() : value?.result;
      if (record?.id) records.push(record);
    }
  } while (cursor !== '0');
  return records.sort((a, b) => String(a.id).localeCompare(String(b.id), 'zh-CN', { numeric: true }));
}
