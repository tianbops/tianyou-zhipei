// 天友智配One V1.0 - 统一数据与权限基础层
// 路线是独立系统实体；用户只通过 boundRouteId 形成维护归属。
// 所有客户端可读取/调度任意路线，只有绑定该路线的用户可修改基准库。

export const API_VERSION = 'v1';
export const ROLES = Object.freeze({
  DRIVER: 'driver',
  ROUTE_ADMIN: 'route_admin',
  SYSTEM_ADMIN: 'system_admin'
});

export function normalizeRoute(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  return m ? `${String(parseInt(m[1] || m[2], 10)).padStart(2, '0')}号线` : s;
}

export function encodeKey(value) {
  return encodeURIComponent(String(value || '').trim()).replace(/%/g, '_');
}

export function routeRecordKey(route) {
  return `route:${encodeKey(normalizeRoute(route))}`;
}

export function routeBaseKey(route) {
  return `route:${encodeKey(normalizeRoute(route))}:base`;
}

export function legacyUserBaseKey(userId, route) {
  return `user:${encodeKey(userId)}:route:${encodeKey(normalizeRoute(route))}:base`;
}

export function legacyUserOrderKey(userId, route, suffix) {
  return `user:${encodeKey(userId)}:route:${encodeKey(normalizeRoute(route))}:orders:${suffix}`;
}

export function routeOrderKey(route, suffix) {
  return `route:${encodeKey(normalizeRoute(route))}:orders:${suffix}`;
}

export function legacyUserLearningKey(userId, route) {
  return `user:${encodeKey(userId)}:route:${encodeKey(normalizeRoute(route))}:learning`;
}

export function routeLearningKey(route) {
  return `route:${encodeKey(normalizeRoute(route))}:learning`;
}

export function publicUser(user) {
  return {
    id: String(user?.id || ''),
    username: String(user?.username || ''),
    name: String(user?.name || user?.username || ''),
    phone: String(user?.phone || ''),
    role: normalizeRole(user?.role),
    boundRouteId: normalizeRoute(user?.boundRouteId || user?.route),
    route: normalizeRoute(user?.boundRouteId || user?.route),
    vehicle: String(user?.vehicle || ''),
    status: String(user?.status || 'active')
  };
}

export function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  return Object.values(ROLES).includes(role) ? role : ROLES.DRIVER;
}

export function isRouteMaintainer(user, route) {
  return Boolean(user && normalizeRoute(user.boundRouteId || user.route) === normalizeRoute(route));
}

export function canUseRoute(user, route) {
  return Boolean(user && user.status !== 'disabled' && normalizeRoute(route));
}

export function canManageRoute(user, route) {
  // system_admin 负责系统管理，不因管理员身份获得业务基准库修改权。
  return isRouteMaintainer(user, route);
}

export async function getUser(env, userId) {
  const value = await redisGet(env, `user:${encodeKey(userId)}`);
  return value && typeof value === 'object' ? value : null;
}

export async function getRoute(env, route) {
  const normalized = normalizeRoute(route);
  if (!normalized) return null;
  const value = await redisGet(env, routeRecordKey(normalized));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

export async function saveRoute(env, route, record) {
  const normalized = normalizeRoute(route);
  const value = {
    schemaVersion: 1,
    id: normalized,
    name: normalized,
    driverUserId: String(record?.driverUserId || ''),
    deliveryUserId: String(record?.deliveryUserId || ''),
    boundUserIds: [
      String(record?.driverUserId || ''),
      String(record?.deliveryUserId || '')
    ].filter(Boolean).filter((id, index, arr) => arr.indexOf(id) === index),
    status: record?.status === 'disabled' ? 'disabled' : 'active',
    createdAt: record?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await redisSet(env, routeRecordKey(normalized), value);
  return value;
}

export async function loadRouteBase(env, route, options = {}) {
  const normalized = normalizeRoute(route);
  if (!normalized) return null;

  let current = await redisGet(env, routeBaseKey(normalized));
  if (current && Array.isArray(current.stores)) {
    return { ...current, route: normalized, stores: normalizeStores(current.stores), source: 'route' };
  }

  const lockKey = `lock:route-base-migration:${encodeKey(normalized)}`;
  const lockToken = createLockToken();
  if (await acquireMigrationLock(env, lockKey, lockToken, 10)) {
    try {
      current = await redisGet(env, routeBaseKey(normalized));
      if (current && Array.isArray(current.stores)) {
        return { ...current, route: normalized, stores: normalizeStores(current.stores), source: 'route' };
      }

      const record = await getRoute(env, normalized);
      const candidates = Array.isArray(record?.boundUserIds) ? record.boundUserIds.filter(Boolean) : [];
      for (const userId of candidates) {
        const legacy = await redisGet(env, legacyUserBaseKey(userId, normalized));
        if (!legacy || !Array.isArray(legacy.stores) || !legacy.stores.length) continue;
        const migrated = {
          schemaVersion: 1, route: normalized, stores: normalizeStores(legacy.stores),
          dataVersion: Math.max(1, Number(legacy.dataVersion) || 1),
          updatedAt: legacy.updatedAt || new Date().toISOString(),
          source: 'route-migration', migratedFromUserId: userId
        };
        await redisSet(env, routeBaseKey(normalized), migrated);
        return { ...migrated, source: 'route-migration' };
      }

      if (options.allowLegacyUserId) {
        const legacy = await redisGet(env, legacyUserBaseKey(options.allowLegacyUserId, normalized));
        if (legacy && Array.isArray(legacy.stores) && legacy.stores.length) {
          const migrated = {
            schemaVersion: 1, route: normalized, stores: normalizeStores(legacy.stores),
            dataVersion: Math.max(1, Number(legacy.dataVersion) || 1),
            updatedAt: legacy.updatedAt || new Date().toISOString(),
            source: 'route-migration', migratedFromUserId: options.allowLegacyUserId
          };
          await redisSet(env, routeBaseKey(normalized), migrated);
          return { ...migrated, source: 'route-migration' };
        }
      }
    } finally {
      await releaseMigrationLock(env, lockKey, lockToken).catch(() => {});
    }
  }

  current = await redisGet(env, routeBaseKey(normalized));
  if (current && Array.isArray(current.stores)) {
    return { ...current, route: normalized, stores: normalizeStores(current.stores), source: 'route' };
  }
  return null;
}

async function acquireMigrationLock(env, key, token, seconds) {
  const response = await redisFetch(env, `/set/${encodeURIComponent(key)}/${encodeURIComponent(token)}/NX/EX/${seconds}`);
  if (!response.ok) return false;
  const data = await response.json().catch(() => ({}));
  return data.result === 'OK';
}

async function releaseMigrationLock(env, key, token) {
  const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
  await redisFetch(env, '/eval', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([script, 1, key, token])
  });
}

export function normalizeStores(stores) {
  if (!Array.isArray(stores)) return [];
  return stores.map((store, index) => ({
    ...store,
    code: String(store?.code || index + 1).padStart(2, '0'),
    routeOrder: index + 1,
    name: String(store?.name || store?.storeName || store?.title || store?.customerName || store?.['门店名称'] || '').trim(),
    nav: String(store?.nav || store?.navigation || store?.navUrl || store?.amap || '').trim(),
    note: String(store?.note || store?.remark || '').trim()
  })).filter(store => store.name);
}

export async function listUsersByRoute(env, route) {
  const users = await scanUsers(env);
  const normalized = normalizeRoute(route);
  return users.filter(user => normalizeRoute(user?.boundRouteId || user?.route) === normalized);
}


export async function recordAdminLog(env, actor, action, targetType, targetId, detail = {}) {
  const key = 'system:admin:logs';
  const current = await redisGet(env, key);
  const list = Array.isArray(current) ? current : [];
  list.unshift({
    id: crypto.randomUUID(),
    actorUserId: String(actor?.id || ''),
    action: String(action || ''),
    targetType: String(targetType || ''),
    targetId: String(targetId || ''),
    detail,
    createdAt: new Date().toISOString()
  });
  await redisSet(env, key, list.slice(0, 500));
}

export async function scanUsers(env) {
  const users = [];
  let cursor = '0';
  do {
    const result = await redisCommand(env, ['SCAN', cursor, 'MATCH', 'user:*', 'COUNT', '200']);
    cursor = String(result?.[0] || '0');
    const keys = Array.isArray(result?.[1]) ? result[1] : [];
    for (const key of keys) {
      if (key.includes(':route:') || key.includes(':username:')) continue;
      const value = await redisGet(env, key);
      if (value && typeof value === 'object' && value.id && value.username) users.push(value);
    }
  } while (cursor !== '0');
  return users;
}

export async function redisGet(env, key) {
  const response = await redisFetch(env, `/get/${encodeURIComponent(key)}`);
  if (!response.ok) throw new Error(`Redis读取失败（HTTP ${response.status}）`);
  const data = await response.json().catch(() => ({}));
  if (data.result === null || data.result === undefined || data.result === '') return null;
  try { return typeof data.result === 'string' ? JSON.parse(data.result) : data.result; } catch { return data.result; }
}

export async function redisSet(env, key, value) {
  const response = await redisFetch(env, `/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  if (!response.ok) throw new Error(`Redis保存失败（HTTP ${response.status}）`);
  const data = await response.json().catch(() => ({}));
  if (data.result !== undefined && data.result !== 'OK') throw new Error('Redis保存未确认');
  return true;
}

export async function redisCommand(env, command) {
  const response = await redisFetch(env, '/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  if (!response.ok) throw new Error(`Redis命令失败（HTTP ${response.status}）`);
  const data = await response.json().catch(() => ({}));
  if (data.error) throw new Error(String(data.error));
  return data.result;
}

// 路线绑定需要同时更新路线记录和多个用户记录；使用单次 EVAL 保证整组写入原子提交。
// 同时用 expectedUpdatedAt / expectedSessionVersion 做乐观并发校验，避免并发管理员覆盖最新绑定。
export async function atomicRouteBinding(env, { routeKey, expectedRouteUpdatedAt = '', routeRecord, userUpdates = [] }) {
  const updates = Array.isArray(userUpdates) ? userUpdates.filter(item => item?.key && item?.user) : [];
  const keys = [routeKey, ...updates.map(item => item.key)];
  const args = [String(expectedRouteUpdatedAt || ''), JSON.stringify(routeRecord), ...updates.flatMap(item => [
    String(Number(item.expectedSessionVersion || 1)),
    JSON.stringify(item.user)
  ])];
  const script = `
local expectedRouteUpdatedAt = ARGV[1]
local routeJson = ARGV[2]
local currentRoute = redis.call('GET', KEYS[1])
if expectedRouteUpdatedAt ~= '' then
  if not currentRoute then return 'ROUTE_CONFLICT' end
  local ok, obj = pcall(cjson.decode, currentRoute)
  if not ok or tostring(obj.updatedAt or '') ~= expectedRouteUpdatedAt then return 'ROUTE_CONFLICT' end
else
  if currentRoute then return 'ROUTE_CONFLICT' end
end

for i = 2, #KEYS do
  local argIndex = 3 + (i - 2) * 2
  local expectedVersion = tonumber(ARGV[argIndex]) or 1
  local currentUser = redis.call('GET', KEYS[i])
  if not currentUser then return 'USER_CONFLICT' end
  local ok, obj = pcall(cjson.decode, currentUser)
  if not ok or tonumber(obj.sessionVersion or 1) ~= expectedVersion then return 'USER_CONFLICT' end
end

redis.call('SET', KEYS[1], routeJson)
for i = 2, #KEYS do
  local argIndex = 3 + (i - 2) * 2
  redis.call('SET', KEYS[i], ARGV[argIndex + 1])
end
return 'OK'
`;
  const result = await redisCommand(env, ['EVAL', script, String(keys.length), ...keys, ...args]);
  if (result === 'ROUTE_CONFLICT') throw new Error('路线绑定已被其他管理员更新，请刷新后重试');
  if (result === 'USER_CONFLICT') throw new Error('用户绑定状态已发生变化，请刷新后重试');
  if (result !== 'OK') throw new Error('路线绑定原子提交未确认');
  return true;
}

async function redisFetch(env, path, options = {}) {
  const base = String(env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
  if (!base || !env.UPSTASH_REDIS_REST_TOKEN) throw new Error('Redis未配置');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    return await fetch(`${base}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
        ...(options.headers || {})
      },
      cache: 'no-store',
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}
