// Zhipei One - 路线历史查询 API
// 今日订单/历史记录按线路+日期统一存储；userId 保留在记录内用于审计与兼容。允许提前一天上传并查询明日运单。
import { authRequired } from './_auth.js';
import { canManageRoute, canUseRoute, legacyUserOrderKey, normalizeRoute, routeOrderKey, redisCommand } from './_data.js';

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

    const key = scopedKey(userId, route, `history:${date}`);
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
  let fromLegacy = false;
  if ((!Array.isArray(result) || !result.length) && isBoundRoute(session, route)) {
    result = await redisGet(env, legacyUserOrderKey(userId, route, `history:${date}`));
    fromLegacy = Array.isArray(result) && result.length > 0;
  }
  let records = Array.isArray(result) ? result : [];
  if (records.length) {
    // 旧用户级历史首次被绑定用户访问时，提升为路线级数据；旧键保留作只读恢复备份。
    if (fromLegacy) await redisSet(env, key, records);
    return records;
  }

  // 兼容旧版本半成功数据：历史没有记录，但同日期 today 数据仍存在。
  const todayKey = scopedKey(userId, route, `today:${date}`);
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
  const historyPattern = scopedKey(userId, route, 'history:*');
  const todayPattern = scopedKey(userId, route, 'today:*');
  let [historyKeys, todayKeys] = await Promise.all([
    scanKeys(env, historyPattern),
    scanKeys(env, todayPattern)
  ]);
  if (!historyKeys.length && !todayKeys.length && isBoundRoute(session, route)) {
    const legacyPrefix = 'user:' + encodeKey(userId) + ':route:' + encodeKey(route) + ':orders:';
    [historyKeys, todayKeys] = await Promise.all([
      scanKeys(env, legacyPrefix + 'history:*'),
      scanKeys(env, legacyPrefix + 'today:*')
    ]);
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
  const key = scopedKey(userId, route, `history:${date}`);
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

  const todayKey = scopedKey(userId, route, `today:${date}`);
  const today = await redisGet(env, todayKey);
  const deleteToday = Boolean(today && targetBatchId && String(today?.orderBatchId || '').trim() === targetBatchId);
  await atomicDeleteHistory(env, {
    historyKey: key,
    expectedHistory: current,
    remaining,
    todayKey,
    deleteToday,
    expectedToday: today
  });
  return json({ success: true, deleted, date, orderBatchId: batchId, removedSameData: 0, todayDeleted: deleteToday });
}


async function atomicDeleteHistory(env, { historyKey, expectedHistory, remaining, todayKey, deleteToday, expectedToday }) {
  const script = `
local currentHistory = redis.call('GET', KEYS[1])
if currentHistory ~= ARGV[1] then return 'CONFLICT' end
redis.call('SET', KEYS[1], ARGV[2])
if ARGV[3] == '1' then
  local currentToday = redis.call('GET', KEYS[2])
  if currentToday ~= ARGV[4] then return 'CONFLICT_TODAY' end
  redis.call('DEL', KEYS[2])
end
return 'OK'
`;
  const expectedHistoryJson = JSON.stringify(expectedHistory);
  const remainingJson = JSON.stringify(remaining);
  const expectedTodayJson = expectedToday === null || expectedToday === undefined ? '' : JSON.stringify(expectedToday);
  const result = await redisCommand(env, [
    'EVAL',
    script,
    '2',
    historyKey,
    todayKey,
    expectedHistoryJson,
    remainingJson,
    deleteToday ? '1' : '0',
    expectedTodayJson
  ]);
  if (result === 'CONFLICT' || result === 'CONFLICT_TODAY') {
    throw new Error('历史记录刚刚发生变化，请刷新后重试');
  }
  if (result !== 'OK') throw new Error('历史记录原子删除未确认');
}

async function purgeExpiredHistory(env, userId, route) {
  const today = businessDate();
  const cutoff = addDays(today, -(HISTORY_DAYS - 1));
  const futureCutoff = addDays(today, FUTURE_DAYS);
  const keys = await scanKeys(env, scopedKey(userId, route, 'history:*'));
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
function scopedKey(userId, route, suffix) { return routeOrderKey(route, suffix); }

async function redisPipelineGet(env, keys) {
  return redisPipeline(env, keys.map(key => ['GET', key])).then(results => results.map(item => {
    const value = item?.result;
    if (value === null || value === undefined || value === '') return null;
    try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
  }));
}

function normalizeDate(value) { const s = String(value || '').trim().replace(/[年月]/g, '-').replace(/日/g, '').replace(/[/.]/g, '-'), m = s.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/); return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : ''; }
function json(payload, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
