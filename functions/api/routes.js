// 天友智配One V1.0 - 唯一路线与基准数据库 API
import { authRequired } from './_auth.js';
import {
  canManageRoute, getRoute, getUser, loadRouteBase, normalizeRoute,
  normalizeStores, routeBaseKey, saveRoute, redisSet
} from './_data.js';

const LOCK_TTL_SECONDS = 20;

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const route = normalizeRoute(url.searchParams.get('route'));
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);

  const session = await authRequired(request, env, { allowAnyRoute: true });
  if (!session) return json({ error: '未登录或登录已失效' }, 401);

  try {
    // GET：所有正常用户都可以读取任意路线的基准库，用于调度。
    if (request.method === 'GET') {
      if (!route) return json({ success: true, routes: await listRoutes(env) });
      const base = await loadRouteBase(env, route, { allowLegacyUserId: session.boundRouteId || session.id });
      if (!base) return json({ route, stores: [], source: 'server', updatedAt: null, dataVersion: 0, migrationRequired: true });
      return json({
        route,
        stores: normalizeStores(base.stores),
        source: base.source || 'route',
        updatedAt: base.updatedAt || null,
        dataVersion: Number(base.dataVersion) || 1,
        schemaVersion: Number(base.schemaVersion) || 1,
        editable: canManageRoute(session.user || session, route)
      });
    }

    if (request.method === 'PUT') {
      if (!route) return json({ error: 'Missing route parameter' }, 400);
      // 只有该路线绑定的驾驶员/配送员可以修改基准库。
      if (!canManageRoute(session.user || session, route)) {
        return json({ error: '当前账号可以调度该路线，但无权修改该路线基准数据库' }, 403);
      }

      const body = await request.json().catch(() => ({}));
      if (!Array.isArray(body.stores)) return json({ error: 'stores 必须是数组' }, 400);

      const lockKey = `lock:route-base:${encodeURIComponent(route)}`;
      const lockValue = crypto.randomUUID();
      if (!(await acquireLock(env, lockKey, lockValue, LOCK_TTL_SECONDS))) {
        return json({ error: '该路线基准库正在被修改，请稍后重试' }, 409);
      }

      try {
        const current = await loadRouteBase(env, route, { allowLegacyUserId: session.boundRouteId || session.id });
        const currentVersion = Number(current?.dataVersion) || 0;
        const expectedVersion = body.expectedDataVersion === undefined || body.expectedDataVersion === null
          ? null : Number(body.expectedDataVersion);

        if (expectedVersion !== null && expectedVersion !== currentVersion) {
          return json({
            error: '路线基准库已被其他维护用户更新，请刷新后再保存',
            code: 'DATA_CONFLICT',
            dataVersion: currentVersion
          }, 409);
        }

        const stores = normalizeStores(body.stores);
        const updatedAt = new Date().toISOString();
        const value = {
          schemaVersion: 1,
          route,
          stores,
          dataVersion: currentVersion + 1 || 1,
          updatedAt,
          updatedBy: session.id,
          source: 'route-editor'
        };
        await redisSet(env, routeBaseKey(route), value);

        // 路线实体不存在时自动建立，但不会改变其他绑定。
        const routeRecord = await getRoute(env, route);
        if (!routeRecord) await saveRoute(env, route, {
          driverUserId: '',
          deliveryUserId: '',
          createdAt: updatedAt
        });

        return json({
          success: true,
          route,
          stores,
          storeCount: stores.length,
          source: 'route',
          updatedAt,
          dataVersion: value.dataVersion,
          editable: true
        });
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
  const response = await fetch(
    `${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/NX/EX/${ttl}`,
    { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store' }
  );
  if (!response.ok) return false;
  const data = await response.json().catch(() => ({}));
  return data.result === 'OK';
}

async function releaseLock(env, key, value) {
  const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
  await fetch(`${env.UPSTASH_REDIS_REST_URL}/eval`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([script, 1, key, value]),
    cache: 'no-store'
  });
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}


async function listRoutes(env) {
  let cursor = '0';
  const records = [];
  do {
    const response = await fetch(env.UPSTASH_REDIS_REST_URL + '/', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.UPSTASH_REDIS_REST_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SCAN', cursor, 'MATCH', 'route:*', 'COUNT', '200']),
      cache: 'no-store'
    });
    if (!response.ok) throw new Error('路线列表读取失败');
    const data = await response.json().catch(() => ({}));
    cursor = String(data?.result?.[0] || '0');
    const keys = Array.isArray(data?.result?.[1]) ? data.result[1] : [];
    for (const key of keys) {
      if (key.includes(':base') || key.includes(':orders:') || key.includes(':learning')) continue;
      const value = await fetch(env.UPSTASH_REDIS_REST_URL + '/get/' + encodeURIComponent(key), {
        headers: { Authorization: 'Bearer ' + env.UPSTASH_REDIS_REST_TOKEN },
        cache: 'no-store'
      }).then(r => r.json()).catch(() => ({}));
      const record = typeof value?.result === 'string' ? (() => { try { return JSON.parse(value.result); } catch { return null; } })() : value?.result;
      if (record?.id) records.push(record);
    }
  } while (cursor !== '0');
  records.sort((a, b) => String(a.id).localeCompare(String(b.id), 'zh-CN', { numeric: true }));
  return records;
}
