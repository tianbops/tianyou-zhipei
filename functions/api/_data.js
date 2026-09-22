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

export function routeOrderKey(route, suffix) {
  return `route:${encodeKey(normalizeRoute(route))}:orders:${suffix}`;
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

  const current = await redisGet(env, routeBaseKey(normalized));
  if (current && Array.isArray(current.stores)) {
    return {
      ...current,
      route: normalized,
      stores: normalizeStores(current.stores),
      source: 'route'
    };
  }

  // V1.0 迁移兼容：旧版是 user:{userId}:route:{route}:base。
  // 若路线基准尚未建立，则从绑定用户的旧库迁移一次。
  const record = await getRoute(env, normalized);
  const candidates = Array.isArray(record?.boundUserIds) ? record.boundUserIds.filter(Boolean) : [];
  for (const userId of candidates) {
    const legacy = await redisGet(env, legacyUserBaseKey(userId, normalized));
    if (!legacy || !Array.isArray(legacy.stores) || !legacy.stores.length) continue;

    const migrated = {
      schemaVersion: 1,
      route: normalized,
      stores: normalizeStores(legacy.stores),
      dataVersion: Math.max(1, Number(legacy.dataVersion) || 1),
      updatedAt: legacy.updatedAt || new Date().toISOString(),
      source: 'route-migration',
      migratedFromUserId: userId
    };
    await redisSet(env, routeBaseKey(normalized), migrated);
    return { ...migrated, source: 'route-migration' };
  }

  if (options.allowLegacyUserId) {
    const legacy = await redisGet(env, legacyUserBaseKey(options.allowLegacyUserId, normalized));
    if (legacy && Array.isArray(legacy.stores) && legacy.stores.length) {
      const migrated = {
        schemaVersion: 1,
        route: normalized,
        stores: normalizeStores(legacy.stores),
        dataVersion: Math.max(1, Number(legacy.dataVersion) || 1),
        updatedAt: legacy.updatedAt || new Date().toISOString(),
        source: 'route-migration',
        migratedFromUserId: options.allowLegacyUserId
      };
      await redisSet(env, routeBaseKey(normalized), migrated);
      return { ...migrated, source: 'route-migration' };
    }
  }

  return null;
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
  try { return typeof data.result === 'string' ? JSON.parse(data.result) : data.result; } catch { return null; }
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
