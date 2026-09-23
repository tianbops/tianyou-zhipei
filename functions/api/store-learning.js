// 天友智配One - 线路共享门店学习库
// 只保存用户确认过的 OCR 门店别名，不保存原始图片。
// 学习数据按线路写入 Upstash Redis；同一路线绑定用户共享同一学习库。
import { authRequired } from './_auth.js';
import { canManageRoute, legacyUserLearningKey, listUsersByRoute, loadRouteBase, normalizeRoute, routeLearningKey } from './_data.js';

const MAX_ALIASES = 1000;
const MAX_BATCH = 100;
const LOCK_SECONDS = 10;

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
  const session = await authRequired(request, env, { allowAnyRoute: true });
  if (!session?.id) return json({ success: false, error: '登录已失效或权限信息不完整' }, 401);
  try {
    const body = await request.json().catch(() => ({}));
    const route = normalizeRoute(body.route || session.boundRouteId);
    const userId = normalizeUserId(session.id);
    if (!route || !userId) return json({ success: false, error: '用户资料不完整，请重新登录' }, 403);
    if (!canManageRoute(session.user || session, route)) return json({ success: false, error: '只有绑定该线路的用户可以维护门店学习数据' }, 403);
    if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ success: false, error: '学习数据库不可用' }, 500);

    const input = Array.isArray(body.items) ? body.items : [body];
    if (input.length > MAX_BATCH) return json({ success: false, error: `单次最多学习 ${MAX_BATCH} 家门店` }, 400);
    const items = input.map(normalizeInput).filter(item => item.rawName && item.baseName);
    if (!items.length) return json({ success: false, error: '缺少待学习门店信息' }, 400);

    const base = await getBaseStores(env, route, userId);
    const validated = [];
    for (const item of items) {
      const target = resolveTarget(base, item);
      if (!target) return json({ success: false, error: `确认的基准门店不属于当前线路：${item.baseName}` }, 400);
      validated.push({ ...item, target });
    }

    const key = routeLearningKey(route);
    const lockKey = `lock:learning:${encodeKey(route)}`;
    const lockToken = createLockToken();
    if (!(await acquireLock(env, lockKey, lockToken, LOCK_SECONDS))) return json({ success: false, error: '当前用户学习库正在更新，请稍后再试' }, 409);
    try {
      const learning = await getLearning(env, key, userId, route, session.boundRouteId);
      learning.version = 4;
      delete learning.userId;
      learning.route = route;
      learning.updatedBy = userId;
      learning.aliases = learning.aliases && typeof learning.aliases === 'object' ? learning.aliases : {};
      const now = new Date().toISOString();
      let learnedCount = 0;
      const learned = [];

      for (const item of validated) {
        const aliasKey = matchKey(item.rawName);
        const baseKey = matchKey(item.target.name);
        if (!aliasKey || !baseKey || aliasKey === baseKey) continue;
        const previous = learning.aliases[aliasKey];
        const rawExamples = Array.isArray(previous?.rawExamples) ? previous.rawExamples.filter(Boolean) : [];
        if (!rawExamples.includes(item.rawName)) rawExamples.push(item.rawName);
        learning.aliases[aliasKey] = {
          baseKey,
          baseCode: String(item.target.code || ''),
          baseName: item.target.name,
          count: Math.max(1, Number(previous?.count) || 0) + 1,
          firstSeenAt: previous?.firstSeenAt || now,
          updatedAt: now,
          rawExamples: rawExamples.slice(-3)
        };
        learnedCount++;
        learned.push({ rawName: item.rawName, baseName: item.target.name, count: learning.aliases[aliasKey].count });
      }

      pruneAliases(learning.aliases, MAX_ALIASES);
      learning.updatedAt = now;
      await redisSet(env, key, learning);
      return json({ success: true, data: { route, userId, learned: true, learnedCount, aliasCount: Object.keys(learning.aliases).length, items: learned } });
    } finally {
      await releaseLock(env, lockKey, lockToken).catch(() => {});
    }
  } catch (error) {
    console.error('store learning error', error);
    return json({ success: false, error: error?.message || '学习记录保存失败' }, 503);
  }
}

function normalizeInput(item) {
  const value = item && typeof item === 'object' ? item : {};
  return { rawName: clean(value.rawName), baseName: clean(value.baseName), baseCode: cleanCode(value.baseCode) };
}

function resolveTarget(base, item) {
  if (item.baseCode) {
    const byCode = base.find(store => String(store.code || '') === item.baseCode);
    if (!byCode) return null;
    if (item.baseName && matchKey(byCode.name) !== matchKey(item.baseName)) return null;
    return byCode;
  }
  return base.find(store => matchKey(store.name) === matchKey(item.baseName)) || null;
}

async function getBaseStores(env, route, userId) {
  const data = await loadRouteBase(env, route);
  if (!Array.isArray(data?.stores) || !data.stores.length) throw new Error(`未找到${route}独立基准数据库`);
  return data.stores.map((store, index) => normalizeBase(store, index)).filter(Boolean);
}

async function getLearning(env, key, userId, route, boundRouteId) {
  let data = await redisGet(env, key);
  if (data && typeof data === 'object') {
    return { ...data, version: 4, route, aliases: data.aliases && typeof data.aliases === 'object' ? data.aliases : {} };
  }

  // 路线学习库尚未建立时，兼容迁移所有“当前绑定用户”的旧学习库，
  // 避免第一个访问用户的旧数据把第二个绑定用户的历史学习数据永久覆盖。
  if (normalizeRoute(boundRouteId) !== normalizeRoute(route)) {
    return { version: 4, route, aliases: {} };
  }

  const boundUsers = await listUsersByRoute(env, route);
  const boundIds = boundUsers
    .map(user => String(user?.id || '').trim())
    .filter(Boolean);
  if (!boundIds.includes(userId)) boundIds.push(userId);

  const legacyValues = await Promise.all(
    [...new Set(boundIds)].map(id => redisGet(env, legacyUserLearningKey(id, route)).catch(() => null))
  );
  const merged = mergeLegacyLearning(legacyValues, route);
  if (!merged.aliases || !Object.keys(merged.aliases).length) {
    return { version: 4, route, aliases: {} };
  }

  const migrated = {
    ...merged,
    version: 4,
    route,
    migratedFromUserIds: [...new Set(boundIds)],
    migratedAt: new Date().toISOString(),
    updatedAt: merged.updatedAt || new Date().toISOString()
  };
  await redisSet(env, key, migrated);
  return migrated;
}

function mergeLegacyLearning(values, route) {
  const aliases = {};
  let latestUpdatedAt = '';
  for (const data of values) {
    if (!data || typeof data !== 'object' || !data.aliases || typeof data.aliases !== 'object') continue;
    if (String(data.updatedAt || '') > latestUpdatedAt) latestUpdatedAt = String(data.updatedAt || '');
    for (const [aliasKey, value] of Object.entries(data.aliases)) {
      if (!aliasKey || !value || typeof value !== 'object') continue;
      const previous = aliases[aliasKey];
      if (!previous) {
        aliases[aliasKey] = { ...value };
        continue;
      }
      const previousCount = Number(previous.count) || 0;
      const incomingCount = Number(value.count) || 0;
      const preferred = incomingCount >= previousCount ? value : previous;
      const examples = [...new Set([
        ...(Array.isArray(previous.rawExamples) ? previous.rawExamples : []),
        ...(Array.isArray(value.rawExamples) ? value.rawExamples : [])
      ].filter(Boolean))].slice(-3);
      aliases[aliasKey] = {
        ...previous,
        ...preferred,
        count: previousCount + incomingCount || 1,
        firstSeenAt: [previous.firstSeenAt, value.firstSeenAt].filter(Boolean).sort()[0] || '',
        updatedAt: [previous.updatedAt, value.updatedAt].filter(Boolean).sort().at(-1) || '',
        rawExamples: examples
      };
    }
  }
  pruneAliases(aliases, MAX_ALIASES);
  return { version: 4, route, aliases, updatedAt: latestUpdatedAt };
}

function encodeKey(value) { return encodeURIComponent(String(value || '').trim()).replace(/%/g, '_'); }
function normalizeUserId(value) { return String(value || '').trim().slice(0, 128); }

function pruneAliases(aliases, limit) {
  const entries = Object.entries(aliases);
  if (entries.length <= limit) return;
  entries.sort((a, b) => String(a[1]?.updatedAt || '').localeCompare(String(b[1]?.updatedAt || '')));
  for (const [key] of entries.slice(0, entries.length - limit)) delete aliases[key];
}

async function acquireLock(env, key, token, seconds) {
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(token)}/NX/EX/${seconds}`, { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store' });
  if (!response.ok) return false;
  const data = await response.json().catch(() => ({}));
  return data.result === 'OK';
}

async function releaseLock(env, key, token) {
  const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
  await fetch(`${env.UPSTASH_REDIS_REST_URL}/eval`, { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify([script, 1, key, token]), cache: 'no-store' });
}

async function redisGet(env, key) {
  const url = String(env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
  const response = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store' });
  if (!response.ok) throw new Error('Redis读取失败');
  const data = await response.json().catch(() => ({}));
  if (data?.result === null || data?.result === undefined || data?.result === '') return null;
  try { return typeof data.result === 'string' ? JSON.parse(data.result) : data.result; } catch { return null; }
}

async function redisSet(env, key, value) {
  const url = String(env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
  const response = await fetch(`${url}/set/${encodeURIComponent(key)}`, { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value), cache: 'no-store' });
  if (!response.ok) throw new Error('Redis保存失败');
  const data = await response.json().catch(() => ({}));
  if (data.result !== undefined && data.result !== 'OK') throw new Error('Redis保存未确认');
}

function normalizeBase(store, index) {
  if (typeof store === 'string') return { name: clean(store), code: String(index + 1).padStart(2, '0') };
  if (!store) return null;
  const name = clean(store.name || store.storeName || store.title || store.customerName || store['门店名称'] || '');
  return name ? { name, code: cleanCode(store.code || index + 1) } : null;
}

function clean(value) { return String(value || '').replace(/^\s*[\d０-９]+[、.．)）-]+/, '').replace(/\s+/g, ' ').trim(); }
function cleanCode(value) { const text = String(value || '').trim(), match = text.match(/\d+/); return match ? String(Number(match[0])).padStart(2, '0') : text; }

function matchKey(value) {
  const romanMap = { 'Ⅱ': 'II', 'Ⅲ': 'III', 'Ⅳ': 'IV', 'Ⅴ': 'V', 'Ⅵ': 'VI', 'Ⅶ': 'VII', 'Ⅷ': 'VIII', 'Ⅸ': 'IX', 'Ⅹ': 'X' };
  return clean(value).replace(/[ⅡⅢⅣⅤⅥⅦⅧⅨⅩ]/g, roman => romanMap[roman] || roman).replace(/[∥〢丨]/g, 'II').replace(/谊品鲜/g, '谊品生鲜').replace(/客户中心/g, '客服中心').replace(/[（(]\s*(?:临时|20\d{2})\s*[）)]/g, '').replace(/[\s\u3000，,。；;：:（）()【】\[\]<>《》“”\"'‘’·\-_/]/g, '').toLowerCase();
}


function createLockToken() { return `${Date.now()}-${Math.random().toString(36).slice(2)}-${crypto.randomUUID?.() || ''}`; }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
