// Zhipei One - 路线历史查询 API
// 今日订单/历史记录按线路+日期统一存储；userId 保留在记录内用于审计与兼容。允许提前一天上传并查询明日运单。
import { authRequired } from './_auth.js';
import { canManageRoute, canUseRoute, legacyUserOrderKey, normalizeRoute, routeOrderKey, redisCommand, listUsersByRoute } from './_data.js';

const HISTORY_DAYS = 100;
const FUTURE_DAYS = 1;

export async function onRequest({ request, env }) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);
  const session = await authRequired(request, env, { allowAnyRoute: true });
  if (!session?.id) return json({ error: '登录已失效或权限信息不完整' }, 401);
  const url = new URL(request.url);
  const date = normalizeDate(url.searchParams.get('date'));
  const route = normalizeRoute(url.searchParams.get('route') || session.route), userId = normalizeUserId(session.id);
  if (!canUseRoute(session.user || session, route)) return json({ error: '无权使用该路线' }, 403);

  try {
    if (request.method === 'DELETE') {
      // 历史记录属于线路业务数据。可调度线路的用户可以查看，但只有该线路绑定用户可删除。
      if (!canManageRoute(session.user || session, route)) {
        return json({ success: false, error: '只有绑定该路线的用户可以删除历史记录' }, 403);
      }
      if (!date) return json({ success: false, error: 'Missing date parameter' }, 400);
      return await deleteHistoryRecord(env, userId, route, date, String(url.searchParams.get('orderBatchId') || url.searchParams.get('batch') || '').trim());
    }
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

    // 历史数据保留100天；每次进入历史查询时执行一次清理。
    await purgeExpiredHistory(env, userId, route);

    // 不传日期时返回该用户/线路全部历史日期。
    if (!date) return await listAllHistory(env, userId, route, session);

    const key = routeOrderKey(userId, route, `history:${date}`);
    let records = await readHistoryOrRecover(env, userId, route, date, key, session);
    const { records: cleaned, changed } = dedupeHistory(records);
    if (changed || cleaned.length !== records.length) await redisSet(env, key, cleaned);
    return json(cleaned);
  } catch (error) {
    console.error('history api error', error);
    return json({ error: request.method === 'DELETE' ? '历史记录删除失败' : '历史数据服务异常' }, 503);
  }
}

async function readHistoryOrRecover(env, userId, route, date, key, session) {
  let result = await redisGet(env, key);
  if (Array.isArray(result) && result.length) return result;

  // 路线历史已统一为共享数据。旧版本仍可能把同一条线路的历史分散在多个绑定用户键下，
  // 因此迁移必须合并全部绑定用户，而不是只读取当前登录用户，避免第二个用户覆盖第一个用户的数据。
  if (isBoundRoute(session, route)) {
    const migrated = await migrateLegacyHistory(env, route, date, key);
    if (migrated.length) return migrated;
  }

  // 兼容旧版本半成功数据：历史没有记录，但同日期 today 数据仍存在。
  const todayKey = routeOrderKey(userId, route, `today:${date}`);
  let today = await redisGet(env, todayKey);
  let todayFromLegacy = false;
  if (!today && isBoundRoute(session, route)) {
    today = await redisGet(env, legacyUserOrderKey(userId, route, `today:${date}`));
    todayFromLegacy = Boolean(today);
  }
  if (today && Array.isArray(today.orders) && today.orders.length && normalizeDate(today.date) === date) {
    const recovered = recoverFromToday(today, userId, route, date);
    if (historySignature(recovered)) {
      await redisSet(env, key, [recovered]);
      if (todayFromLegacy) await redisSet(env, todayKey, today);
      return [recovered];
    }
  }
  return [];
}

async function migrateLegacyHistory(env, route, date, key) {
  const lockKey = `lock:history-migration:${encodeKey(route)}:${date}`;
  const token = createLockToken();
  if (!(await acquireMigrationLock(env, lockKey, token, 10))) {
    const current = await redisGet(env, key);
    return Array.isArray(current) ? current : [];
  }

  try {
    const current = await redisGet(env, key);
    if (Array.isArray(current) && current.length) return current;

    const users = await listUsersByRoute(env, route);
    const legacyLists = await Promise.all(users.map(async user => {
      const legacyKey = legacyUserOrderKey(user.id, route, `history:${date}`);
      const value = await redisGet(env, legacyKey);
      return Array.isArray(value) ? value : [];
    }));
    const merged = dedupeHistory(legacyLists.flat()).records;
    if (!merged.length) return [];

    const expected = JSON.stringify(current ?? null);
    const next = JSON.stringify(merged);
    const result = await redisCommand(env, [
      'EVAL',
      `local current = redis.call('GET', KEYS[1])
if (current ~= ARGV[1]) then return 'CONFLICT' end
redis.call('SET', KEYS[1], ARGV[2])
return 'OK'`,
      '1',
      key,
      expected,
      next
    ]);
    if (result === 'OK') return merged;
    const after = await redisGet(env, key);
    return Array.isArray(after) ? after : merged;
  } finally {
    await releaseMigrationLock(env, lockKey, token).catch(() => {});
  }
}


function recoverFromToday(today, userId, route, date) {
  return {
    orderBatchId: String(today.orderBatchId || '').trim(),
    date,
    route,
    userId,
    vehicle: String(today.vehicle || '').trim(),
    count: Number(today.count) || today.orders.length,
    uniqueStoreCount: Number(today.uniqueStoreCount) || today.orders.length,
    weight: today.totalWeight ?? today.weight ?? '',
    totalWeight: today.totalWeight ?? today.weight ?? '',
    orders: today.orders,
    matchedCount: Number(today.matchedCount) || 0,
    newStoreCount: Number(today.newStoreCount) || 0,
    reviewCount: Number(today.reviewCount) || 0,
    duplicateCount: Number(today.duplicateCount) || 0,
    recognizedCount: Number(today.recognizedCount) || today.orders.length,
    rawOrderCount: Number(today.rawOrderCount) || today.orders.length,
    baseDatabaseAvailable: today.baseDatabaseAvailable !== false,
    source: String(today.source || 'recovered-from-today'),
    updatedAt: today.updatedAt || new Date().toISOString()
  };
}

async function listAllHistory(env, userId, route, session) {
  const historyPattern = routeOrderKey(userId, route, 'history:*');
  const todayPattern = routeOrderKey(userId, route, 'today:*');
  let [historyKeys, todayKeys] = await Promise.all([
    scanKeys(env, historyPattern),
    scanKeys(env, todayPattern)
  ]);
  if (isBoundRoute(session, route) && !historyKeys.length && !todayKeys.length) {
    const users = await listUsersByRoute(env, route);
    const legacyResults = await Promise.all(users.map(async user => {
      const legacyPrefix = 'user:' + encodeKey(user.id) + ':route:' + encodeKey(route) + ':orders:';
      const [h, t] = await Promise.all([
        scanKeys(env, legacyPrefix + 'history:*'),
        scanKeys(env, legacyPrefix + 'today:*')
      ]);
      return { history: h, today: t };
    }));
    historyKeys = legacyResults.flatMap(item => item.history);
    todayKeys = legacyResults.flatMap(item => item.today);
  }
  const keyMap = new Map();
  historyKeys.forEach(key => keyMap.set(key, 'history'));
  todayKeys.forEach(key => keyMap.set(key, 'today'));
  const keys = [...keyMap.keys()];
  if (!keys.length) return json([]);

  const values = await redisPipelineGet(env, keys);
  const grouped = new Map();

  keys.forEach((key, index) => {
    const type = keyMap.get(key);
    const raw = values[index];
    if (type === 'history') {
      const date = normalizeDate(String(key).split(':history:').pop());
      if (!date) return;
      const records = Array.isArray(raw) ? raw : [];
      if (!records.length) return;
      grouped.set(date, records);
      return;
    }

    // 旧数据兼容：today 有而 history 没有时自动补历史。
    const date = normalizeDate(String(key).split(':today:').pop());
    if (!date || !raw || !Array.isArray(raw.orders) || !raw.orders.length) return;
    if (grouped.has(date)) return;
    const recovered = recoverFromToday(raw, userId, route, date);
    if (!historySignature(recovered)) return;
    grouped.set(date, [recovered]);
  });

  const entries = [];
  for (const [date, rawRecords] of grouped.entries()) {
    const cleaned = dedupeHistory(rawRecords).records;
    if (!cleaned.length) continue;
    entries.push({ date, records: cleaned });
  }
  entries.sort((a, b) => b.date.localeCompare(a.date));
  return json(entries);
}

async function deleteHistoryRecord(env, userId, route, date, batchId) {
  const key = routeOrderKey(userId, route, `history:${date}`);
  let records = await redisGet(env, key);
  if ((!Array.isArray(records) || !records.length)) {
    records = await redisGet(env, legacyUserOrderKey(userId, route, `history:${date}`));
    if (Array.isArray(records) && records.length) await redisSet(env, key, records);
  }
  if (!Array.isArray(records) || !records.length) return json({ success: true, deleted: 0, date });

  const current = dedupeHistory(records).records;
  const target = batchId ? current.find(item => String(item?.orderBatchId || '').trim() === batchId) : null;
  if (!target) return json({ success: false, error: '未找到要删除的历史记录' }, 404);

  const targetBatchId = String(target?.orderBatchId || '').trim();
  const remaining = targetBatchId
    ? current.filter(item => String(item?.orderBatchId || '').trim() !== targetBatchId)
    : current.filter(item => historySignature(item) !== historySignature(target));
  const deleted = current.length - remaining.length;

  const todayKey = routeOrderKey(userId, route, `today:${date}`);
  const latestKey = routeOrderKey(userId, route, 'latest');
  const [today, latest] = await Promise.all([
    redisGet(env, todayKey),
    redisGet(env, latestKey)
  ]);
  const deleteToday = Boolean(today && targetBatchId && String(today?.orderBatchId || '').trim() === targetBatchId);
  const clearLatest = Boolean(latest && targetBatchId && String(latest?.orderBatchId || '').trim() === targetBatchId && normalizeDate(latest?.date) === date);
  await atomicDeleteHistory(env, {
    historyKey: key,
    expectedHistory: current,
    remaining,
    todayKey,
    deleteToday,
    expectedToday: today,
    latestKey,
    clearLatest,
    expectedLatest: latest
  });
  return json({ success: true, deleted, date, orderBatchId: batchId, removedSameData: 0, todayDeleted: deleteToday, latestCleared: clearLatest });
}


async function atomicDeleteHistory(env, { historyKey, expectedHistory, remaining, todayKey, deleteToday, expectedToday, latestKey, clearLatest, expectedLatest }) {
  const script = `
local currentHistory = redis.call('GET', KEYS[1])
if currentHistory ~= ARGV[1] then return 'CONFLICT' end
if ARGV[3] == '1' then
  local currentToday = redis.call('GET', KEYS[2])
  if currentToday ~= ARGV[4] then return 'CONFLICT_TODAY' end
end
if ARGV[5] == '1' then
  local currentLatest = redis.call('GET', KEYS[3])
  if currentLatest ~= ARGV[6] then return 'CONFLICT_LATEST' end
end
redis.call('SET', KEYS[1], ARGV[2])
if ARGV[3] == '1' then
  redis.call('DEL', KEYS[2])
end
if ARGV[5] == '1' then
  redis.call('DEL', KEYS[3])
end
return 'OK'
`;
  const expectedHistoryJson = JSON.stringify(expectedHistory);
  const remainingJson = JSON.stringify(remaining);
  const expectedTodayJson = expectedToday === null || expectedToday === undefined ? '' : JSON.stringify(expectedToday);
  const expectedLatestJson = expectedLatest === null || expectedLatest === undefined ? '' : JSON.stringify(expectedLatest);
  const result = await redisCommand(env, [
    'EVAL',
    script,
    '3',
    historyKey,
    todayKey,
    latestKey,
    expectedHistoryJson,
    remainingJson,
    deleteToday ? '1' : '0',
    expectedTodayJson,
    clearLatest ? '1' : '0',
    expectedLatestJson
  ]);
  if (result === 'CONFLICT' || result === 'CONFLICT_TODAY' || result === 'CONFLICT_LATEST') {
    throw new Error('历史记录刚刚发生变化，请刷新后重试');
  }
  if (result !== 'OK') throw new Error('历史记录原子删除未确认');
}

async function acquireMigrationLock(env, key, token, seconds) {
  const result = await redisCommand(env, ['SET', key, token, 'NX', 'EX', String(seconds)]);
  return result === 'OK';
}

async function releaseMigrationLock(env, key, token) {
  const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
  await redisCommand(env, ['EVAL', script, '1', key, token]);
}

function createLockToken() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function purgeExpiredHistory(env, userId, route) {
  const today = businessDate();
  const cutoff = addDays(today, -(HISTORY_DAYS - 1));
  const futureCutoff = addDays(today, FUTURE_DAYS);
  const keys = await scanKeys(env, routeOrderKey(userId, route, 'history:*'));
  if (!keys.length) return;

  const commands = [];
  for (const key of keys) {
    const date = normalizeDate(String(key).split(':history:').pop());
    if (!date || date < cutoff || date > futureCutoff) commands.push(['DEL', key]);
  }
  if (commands.length) await redisPipeline(env, commands);
}

async function scanKeys(env, pattern) {
  let cursor = '0', keys = [];
  for (let page = 0; page < 5; page += 1) {
    const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/scan/${cursor}/match/${encodeURIComponent(pattern)}/count/100`, { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store' });
    if (!response.ok) break;
    const data = await response.json().catch(() => ({}));
    keys.push(...(Array.isArray(data.result?.[1]) ? data.result[1] : []));
    cursor = String(data.result?.[0] || '0');
    if (cursor === '0') break;
  }
  return keys;
}

function dedupeHistory(input) { const map = new Map(); let changed = false; for (const item of input) { if (!item || typeof item !== 'object') { changed = true; continue; } const signature = historySignature(item); if (!signature) { changed = true; continue; } const old = map.get(signature); if (!old) map.set(signature, item); else { changed = true; if (compareUpdatedAt(item, old) > 0) map.set(signature, item); } } const records = Array.from(map.values()).sort((a, b) => compareUpdatedAt(b, a)); if (records.length !== input.length) changed = true; return { records, changed }; }
function historySignature(record) { const route = String(record?.route || '').trim(), date = normalizeDate(record?.date), vehicle = String(record?.vehicle || '').trim().toLowerCase(), weight = normalizeWeight(record?.totalWeight ?? record?.weight), orders = Array.isArray(record?.orders) ? record.orders : []; if (!date && !orders.length && !weight) return ''; const stores = orders.map(item => normalizeStoreName(item?.name || item?.storeName || item?.shopName || item?.['门店名称'])).filter(Boolean).sort(); return JSON.stringify({ route, date, vehicle, weight, stores }); }
function todayOrderSignature(record) { return historySignature(record); }
function normalizeStoreName(value) { return String(value || '').trim().replace(/[\s\u3000（）()【】\[\]]/g, '').replace(/谊品鲜/g, '谊品生鲜').replace(/\b20\d{2}\b/g, '').replace(/临时/g, '').toLowerCase(); }
function normalizeNumber(value) { const n = Number(value); return Number.isFinite(n) ? Math.round(n * 1000000) / 1000000 : 0; }
function normalizeWeight(value) { if (value === null || value === undefined || value === '') return ''; const s = String(value).trim().replace(/,/g, ''), m = s.match(/[\d]+(?:\.\d+)?/); if (!m) return ''; const n = Number(m[0]); if (!Number.isFinite(n) || n < 0) return ''; const tons = /吨|\bt\b/i.test(s) ? n : /kg|千克|公斤/i.test(s) ? n / 1000 : n >= 1000 ? n / 1000 : n; return `${(Math.round((tons + Number.EPSILON) * 1000000) / 1000000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`; }
function compareUpdatedAt(a, b) { return (Date.parse(String(a?.updatedAt || a?.createdAt || '')) || 0) - (Date.parse(String(b?.updatedAt || b?.createdAt || '')) || 0); }
function isBoundRoute(session, route) { return normalizeRoute(session?.boundRouteId || session?.route) === normalizeRoute(route); }
function normalizeUserId(value) { return String(value || '').trim().slice(0, 128); }
function encodeKey(value) { return encodeURIComponent(String(value || '').trim()).replace(/%/g, '_'); }
function routeOrderKey(userId, route, suffix) { return routeOrderKey(route, suffix); }

async function redisPipelineGet(env, keys) {
  return redisPipeline(env, keys.map(key => ['GET', key])).then(results => results.map(item => {
    const value = item?.result;
    if (value === null || value === undefined || value === '') return null;
    try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
  }));
}

function normalizeDate(value) { const s = String(value || '').trim().replace(/[年月]/g, '-').replace(/日/g, '').replace(/[/.]/g, '-'), m = s.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/); return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : ''; }
function json(payload, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
