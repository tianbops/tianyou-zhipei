// 天友智配One - 线路基准数据库 API
// 基准库按线路独立保存于 Upstash，代码仓库不再内置任何线路门店数据。
import { authRequired } from './_auth.js';

const LOCK_TTL_SECONDS = 15;

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const route = normalizeRoute(url.searchParams.get('route'));
  if (!route) return json({ error: 'Missing route parameter' }, 400);
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);

  const session = await authRequired(request, env, { route });
  if (!session) return json({ error: '未登录或无权访问该线路数据' }, 401);

  const userId = normalizeUserId(session.id);
  if (!userId) return json({ error: '用户身份信息不完整，无法访问线路基准数据库' }, 403);
  const key = scopedBaseKey(userId, route);
  try {
    if (request.method === 'GET') {
      const result = await redisGet(env, key);
      if (!result.ok) return json({ error: '线路基准数据库读取失败' }, 502);
      const record = parseRecord(result.result);
      if (!record) {
        const legacy = await redisGet(env, `route:${route}:base`);
        if (!legacy.ok) return json({ error: '线路基准数据库读取失败' }, 502);
        const legacyRecord = parseRecord(legacy.result);
        const hasLegacy = Array.isArray(legacyRecord?.stores) && legacyRecord.stores.length > 0;
        if (hasLegacy) {
          return json({ route, stores: [], source: 'server', updatedAt: null, dataVersion: 0, migrationRequired: true });
        }
        const now = new Date().toISOString();
        const initialized = {
          userId, route, stores: [], dataVersion: 1, updatedAt: now, source: 'auto-init'
        };
        const created = await redisSetIfAbsent(env, key, initialized);
        if (!created.ok) return json({ error: '线路基准数据库初始化失败' }, 500);
        if (created.created) {
          return json({ route, stores: [], source: 'server', updatedAt: now, dataVersion: 1, migrationRequired: false, initialized: true });
        }
        // 并发情况下，其他请求可能已先创建/保存真实基准库；重新读取，绝不覆盖对方数据。
        const current = parseRecord(created.result);
        const currentStores = normalizeStores(current?.stores);
        return json({ route, stores: currentStores, source: 'server', updatedAt: current?.updatedAt || null,
          dataVersion: Number(current?.dataVersion) || 1, migrationRequired: false, initialized: false });
      }
      const stores = normalizeStores(record?.stores);
      const recordUserId = normalizeUserId(record?.userId);
      const recordRoute = normalizeRoute(record?.route);
      // 防止历史/手工写入的错误记录被当前账号误读；只有明确属于当前用户+当前线路的数据才可使用。
      if (recordUserId && recordUserId !== userId) {
        return json({ error: '线路基准数据库归属校验失败' }, 403);
      }
      if (recordRoute && recordRoute !== route) {
        return json({ error: '线路基准数据库线路校验失败' }, 409);
      }
      return json({ route, stores, source: 'server', updatedAt: record?.updatedAt || null,
        dataVersion: Number(record?.dataVersion) || 1, migrationRequired: false });
    }

    if (request.method === 'PUT') {
      const body = await request.json().catch(() => ({}));
      const isLegacyMigration = body.migrateLegacy === true;
      if (!isLegacyMigration && !Array.isArray(body.stores)) {
        return json({ error: 'stores 必须是数组' }, 400);
      }

      const lockKey = `lock:route-base:${encodeKey(userId)}:${encodeKey(route)}`;
      const lockValue = crypto.randomUUID();
      if (!(await acquireLock(env, lockKey, lockValue, LOCK_TTL_SECONDS))) {
        return json({ error: '该线路基准库正在被修改，请稍后重试' }, 409);
      }

      try {
        let stores;
        let dataVersion = 1;
        if (isLegacyMigration) {
          const current = await redisGet(env, key);
          const currentRecord = parseRecord(current.result);
          const currentStores = Array.isArray(currentRecord?.stores) ? currentRecord.stores : null;
          const canReplaceAutoInit = currentRecord
            && Array.isArray(currentStores)
            && currentStores.length === 0
            && currentRecord.source === 'auto-init';
          if (current.ok && current.result && !canReplaceAutoInit) {
            return json({ error: '当前账号已经存在线路基准数据库，无需迁移' }, 409);
          }
          const legacy = await redisGet(env, `route:${route}:base`);
          const legacyRecord = parseRecord(legacy.result);
          if (!Array.isArray(legacyRecord?.stores) || !legacyRecord.stores.length) return json({ error: '未找到可迁移的旧版线路基准数据库' }, 404);
          stores = normalizeStores(legacyRecord.stores);
          dataVersion = Math.max(1, Number(legacyRecord?.dataVersion) || 1);
        } else {
          stores = normalizeStores(body.stores);
          const current = await redisGet(env, key);
          const currentRecord = parseRecord(current.result);
          dataVersion = Math.max(1, Number(currentRecord?.dataVersion) || 0) + 1;
        }
        const updatedAt = new Date().toISOString();
        const value = { userId, route, stores, dataVersion, updatedAt,
          source: isLegacyMigration ? 'legacy-migration' : 'route-editor' };
        const saved = await redisSet(env, key, value);
        if (!saved.ok) return json({ error: '线路基准数据库保存失败' }, 500);

        return json({
          success: true,
          route,
          stores,
          storeCount: stores.length,
          source: 'server',
          updatedAt,
          dataVersion
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



function normalizeUserId(value) {
  return String(value || '').trim();
}

function scopedBaseKey(userId, route) {
  return `user:${encodeKey(userId)}:route:${encodeKey(normalizeRoute(route))}:base`;
}

function encodeKey(value) {
  return encodeURIComponent(String(value || '').trim()).replace(/%/g, '_');
}

function normalizeStores(stores) {
  if (!Array.isArray(stores)) return [];
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

async function acquireLock(env, key, value, ttl) {
  const response = await fetch(
    `${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/NX/EX/${ttl}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
      cache: 'no-store'
    }
  );
  if (!response.ok) return false;
  const data = await response.json().catch(() => ({}));
  return data.result === 'OK';
}

async function releaseLock(env, key, value) {
  const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/eval`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([script, 1, key, value]),
    cache: 'no-store'
  });
  if (response.ok) await response.json().catch(() => null);
}

async function redisGet(env, key) {
  const response = await fetch(
    `${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`,
    {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
      cache: 'no-store'
    }
  );
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, result: data.result };
}

async function redisSetIfAbsent(env, key, value) {
  const response = await fetch(
    `${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}/NX`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
      cache: 'no-store'
    }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, created: false, result: null };
  if (data.result === 'OK') return { ok: true, created: true, result: value };
  if (data.result === null) {
    const current = await redisGet(env, key);
    return { ok: current.ok, created: false, result: current.result };
  }
  return { ok: false, created: false, result: data.result };
}

async function redisSet(env, key, value) {
  const response = await fetch(
    `${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(value),
      cache: 'no-store'
    }
  );
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
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
