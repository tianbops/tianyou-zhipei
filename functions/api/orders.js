// Zhipei One - 用户独立订单 API
// 订单按线路+日期统一存储，服务器为唯一真实数据源。
import { authRequired } from './_auth.js';
import { canUseRoute, legacyUserOrderKey, listUsersByRoute, loadRouteBase, normalizeRoute, routeBaseKey, routeOrderKey } from './_data.js';

const REDIS_TIMEOUT_MS = 8000;
const ORDER_LOCK_TTL_SECONDS = 60;

export async function onRequest({ request, env }) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);
  const session = await authRequired(request, env, { allowAnyRoute: true });
  if (!session?.id) return json({ error: '登录已失效或权限信息不完整' }, 401);
  try {
    if (request.method === 'POST') return await saveOrder(request, env, session);
    if (request.method === 'GET') return await readOrder(request, env, session);
    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('orders api error', error);
    return json({ success: false, error: '订单数据服务暂不可用', detail: error?.message || 'server error' }, 503);
  }
}

async function saveOrder(request, env, session) {
  const body = await request.json().catch(() => ({}));
  const route = normalizeRoute(body.route || session.route), userId = normalizeUserId(session.id);
  if (!canUseRoute(session.user || session, route)) return json({ error: '无权使用该路线' }, 403);
  // /api/orders POST 仅保留“订单详情页更换车辆”这一增量写操作。
  // 正式运单录入必须经过 /api/confirm，避免出现“今日订单已写入、历史记录未生成”的半确认状态。
  const source = String(body.source || '').trim();
  if (source !== 'order-detail') return json({ error: '订单录入请使用确认接口' }, 409);
  if (!String(body.orderBatchId || '').trim()) return json({ error: '缺少原订单批次，不能修改车辆' }, 400);
  if (!Array.isArray(body.orders) || !body.orders.length) return json({ error: '缺少订单数据' }, 400);
  const date = normalizeDate(body.date) || businessDate();
  const key = routeOrderKey(route, `today:${date}`), latestKey = routeOrderKey(route, 'latest');
  const lockKey = routeOrderKey(route, `lock:${date}`), lockToken = createLockToken();
  if (!(await acquireLock(env, lockKey, lockToken, ORDER_LOCK_TTL_SECONDS))) return json({ error: '当前线路正在保存订单，请稍后再试' }, 409);
  try {
    let existing = await redisGet(env, key);
    if (!existing && isBoundRoute(session, route)) {
      const users = await listUsersByRoute(env, route);
      const candidates = await Promise.all(users.map(async user => {
        const value = await redisGet(env, legacyUserOrderKey(user.id, route, `today:${date}`));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
      }));
      candidates.sort((a, b) => {
        const at = Date.parse(String(a.updatedAt || a.createdAt || '')) || 0;
        const bt = Date.parse(String(b.updatedAt || b.createdAt || '')) || 0;
        return bt - at;
      });
      existing = candidates.find(item => String(item.orderBatchId || '').trim()) || candidates[0] || null;
    }
    const orderBatchId = String(body.orderBatchId || '').trim() || existing?.orderBatchId || createBatchId(date, route);
    // 订单详情页的“更换车辆”只是修改当日车辆，不应重新按当前基准库计算订单。
    // 历史/今日订单必须继续使用原批次已经确认的门店顺序与匹配结果。
    const isVehicleOnlyUpdate = source === 'order-detail'
      && existing?.orderBatchId
      && orderBatchId === existing.orderBatchId
      && Array.isArray(existing.orders)
      && existing.orders.length > 0;
    if (!isVehicleOnlyUpdate) return json({ error: '原订单不存在或批次已变化，不能修改车辆' }, 409);

    let orders;
    let rawOrderCount;
    let duplicateCount;
    if (isVehicleOnlyUpdate) {
      orders = existing.orders;
      rawOrderCount = positiveInt(existing.rawOrderCount) || orders.length;
      duplicateCount = Number(existing.duplicateCount) || 0;
    } else {
      const base = await loadBaseData(env, route, userId);
      const normalized = body.orders.map((item, index) => normalizeOrder(item, index, orderBatchId, date, route)).filter(item => item.name);
      rawOrderCount = positiveInt(body.rawOrderCount) || positiveInt(body.recognizedCount) || normalized.length;
      const uniqueOrders = dedupeOrders(normalized, base);
      duplicateCount = Math.max(0, normalized.length - uniqueOrders.length);
      orders = sortByRouteBase(uniqueOrders, base);
    }
    const incomingWeight = normalizeWeight(body.totalWeight ?? body.weight);
    const totalWeight = incomingWeight && !isZeroWeight(incomingWeight) ? incomingWeight : normalizeWeight(existing?.totalWeight);
    const todayData = {
      orderBatchId, date, route, userId,
      vehicle: String(body.vehicle || '').trim() || session.vehicle || String(existing?.vehicle || ''),
      orders, totalWeight, count: orders.length, uniqueStoreCount: orders.length,
      matchedCount: orders.filter(x => x.matched).length,
      newStoreCount: orders.filter(x => x.isNew).length,
      duplicateCount: Math.max(Number(body.duplicateCount) || 0, duplicateCount),
      recognizedCount: positiveInt(body.recognizedCount) || rawOrderCount, rawOrderCount,
      source, updatedAt: new Date().toISOString()
    };
    const historyKey = routeOrderKey(route, `history:${date}`);
    let updatedHistory = null;
    if (isVehicleOnlyUpdate) {
      let historyData = await redisGet(env, historyKey);
      if (!Array.isArray(historyData) && isBoundRoute(session, route)) {
        const users = await listUsersByRoute(env, route);
        const legacyLists = await Promise.all(users.map(async user => {
          const legacy = await redisGet(env, legacyUserOrderKey(user.id, route, `history:${date}`));
          return Array.isArray(legacy) ? legacy : [];
        }));
        const merged = dedupeHistoryRecords(legacyLists.flat());
        historyData = merged.length ? merged : null;
      }
      if (Array.isArray(historyData)) {
        updatedHistory = historyData.map(item =>
          item?.orderBatchId === orderBatchId
            ? { ...item, vehicle: todayData.vehicle, updatedAt: todayData.updatedAt }
            : item
        );
      }
    }

    // 正常保存：今日订单与 latest 一起原子提交。
    // 更换车辆：今日订单、对应历史记录、latest 三者一起原子提交，
    // 避免网络/Redis故障造成“今日车辆已变、历史车辆未变”的半成功状态。
    await atomicSaveOrder(env, {
      todayKey: key,
      todayData,
      latestKey,
      latestData: { date, orderBatchId, updatedAt: todayData.updatedAt },
      historyKey: isVehicleOnlyUpdate && Array.isArray(updatedHistory) ? historyKey : '',
      historyData: isVehicleOnlyUpdate && Array.isArray(updatedHistory) ? updatedHistory : null
    });

    const saved = await readAfterWrite(env, key, orderBatchId, orders.length);
    if (!saved) throw new Error('订单已提交但服务器未确认保存成功，请重试');
    return json({ success: true, data: saved });
  } finally { await releaseLock(env, lockKey, lockToken).catch(() => {}); }
}

async function readOrder(request, env, session) {
  const url = new URL(request.url), requestedDate = normalizeDate(url.searchParams.get('date'));
  const route = normalizeRoute(url.searchParams.get('route') || session.route), userId = normalizeUserId(session.id);
  if (!canUseRoute(session.user || session, route)) return json({ error: '无权使用该路线' }, 403);
  const batch = String(url.searchParams.get('orderBatchId') || url.searchParams.get('batch') || '').trim();

  // 未指定日期时只读取业务日，避免明日预上传通过 latest 提前进入首页“今日任务”。
  // 需要读取历史或明日数据的页面必须显式传 date。
  const date = requestedDate || businessDate();
  let today = await redisGet(env, routeOrderKey(route, `today:${date}`));
  let historyData = await redisGet(env, routeOrderKey(route, `history:${date}`));
  if (isBoundRoute(session, route)) {
    // 线路级数据是唯一权威来源；只有线路级 key 不存在时才读取 legacy。
    // legacy 可能分散在司机/送货员多个用户下，因此必须合并全部当前绑定用户。
    if (!today) {
      const users = await listUsersByRoute(env, route);
      const legacyToday = await Promise.all(users.map(async user => {
        const value = await redisGet(env, legacyUserOrderKey(user.id, route, `today:${date}`));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
      }));
      const candidates = legacyToday.filter(Boolean);
      candidates.sort((a, b) => {
        const at = Date.parse(String(a.updatedAt || a.createdAt || '')) || 0;
        const bt = Date.parse(String(b.updatedAt || b.createdAt || '')) || 0;
        return bt - at;
      });
      today = candidates[0] || null;
      if (today) await redisSet(env, routeOrderKey(route, `today:${date}`), today);
    }
    if (!historyData) {
      const users = await listUsersByRoute(env, route);
      const legacyLists = await Promise.all(users.map(async user => {
        const value = await redisGet(env, legacyUserOrderKey(user.id, route, `history:${date}`));
        return Array.isArray(value) ? value : [];
      }));
      const merged = dedupeHistoryRecords(legacyLists.flat());
      historyData = merged.length ? merged : null;
      if (historyData) await redisSet(env, routeOrderKey(route, `history:${date}`), historyData);
    }
  }
  const history = Array.isArray(historyData) ? historyData : [];
  let selected = today;
  if (batch && selected?.orderBatchId !== batch) selected = history.find(item => item?.orderBatchId === batch) || null;
  else if (!selected || !Array.isArray(selected.orders)) selected = history[history.length - 1] || null;

  // 首页保持原有“今日任务”结构，但当天可以存在多笔独立运单。
  // today 仍返回当前最新一笔，新增汇总字段仅供首页显示多运单汇总，不改变既有详情接口语义。
  const dailyRecords = history.filter(item => normalizeDate(item?.date) === date);
  const todayWaybillCount = dailyRecords.length;
  const summaryStores = dailyRecords.reduce((sum, item) => sum + (Number(item?.uniqueStoreCount) || Number(item?.count) || (Array.isArray(item?.orders) ? item.orders.length : 0)), 0);
  const summaryWeight = dailyRecords.reduce((sum, item) => sum + parseWeightToTons(item?.totalWeight ?? item?.weight), 0);
  const todaySummary = {
    storeCount: summaryStores,
    totalWeight: summaryWeight > 0 ? (Math.round((summaryWeight + Number.EPSILON) * 1000000) / 1000000) + 't' : ''
  };
  return json({ success: true, today: selected && normalizeDate(selected.date) === date ? selected : null, history, todayWaybillCount, todaySummary });
}

async function loadBaseData(env, route, userId) {
  const raw = await redisGet(env, scopedBaseKey(userId, route)), stores = Array.isArray(raw?.stores) ? raw.stores : [];
  return stores.map((store, index) => ({ ...store, routeOrder: Number(store?.routeOrder || store?.code || index + 1) || index + 1, nameKey: normalizeStoreName(store?.name || store?.storeName || store?.shopName || store?.['门店名称']), businessCode: extractBusinessCode(store?.name || store?.storeName || store?.shopName || store?.['门店名称']) })).filter(store => store.nameKey);
}

function dedupeOrders(orders, base) {
  const baseByName = new Map(base.map((store, index) => [store.nameKey, `b:${index}`]));
  const baseByBusinessCode = new Map(base.filter(store => store.businessCode).map((store, index) => [store.businessCode, `b:${index}`]));
  const seen = new Set(), result = [];
  for (const order of orders) {
    const nameKey = normalizeStoreName(order.name), businessCode = order.businessCode || extractBusinessCode(order.name);
    if (!nameKey) continue;
    const identity = baseByName.get(nameKey) || (businessCode ? baseByBusinessCode.get(businessCode) : '') || `n:${nameKey}`;
    if (seen.has(identity)) continue;
    seen.add(identity); result.push(order);
  }
  return result;
}

function sortByRouteBase(orders, base) {
  if (!base.length) return orders.map((item, index) => ({ ...item, code: String(index + 1).padStart(2, '0') }));
  const orderMap = new Map(base.map((store, index) => [store.nameKey, Number(store.routeOrder) || index + 1]));
  const codeMap = new Map(base.filter(store => store.businessCode).map((store, index) => [store.businessCode, Number(store.routeOrder) || index + 1]));
  const matched = [], news = [];
  for (const order of orders) {
    const routeOrder = orderMap.get(normalizeStoreName(order.name)) ?? codeMap.get(order.businessCode || extractBusinessCode(order.name));
    if (routeOrder != null && !order.isNew) matched.push({ ...order, routeOrder, matched: true, isNew: false });
    else news.push({ ...order, routeOrder: null, matched: false, isNew: true });
  }
  matched.sort((a, b) => a.routeOrder - b.routeOrder);
  matched.forEach((item, index) => { item.code = String(index + 1).padStart(2, '0'); });
  news.forEach((item, index) => { item.code = `N${String(index + 1).padStart(2, '0')}`; });
  return matched.concat(news).map(({ routeOrder, ...item }) => item);
}

function normalizeOrder(item, index, batchId, date, route) {
  const value = typeof item === 'string' ? { name: item } : (item || {}), name = String(value.name || value.storeName || value.shopName || value['门店名称'] || '').trim();
  return { id: String(value.id || `${batchId}-${index + 1}`), orderBatchId: batchId, code: String(value.code || index + 1).padStart(2, '0'), businessCode: String(value.businessCode || extractBusinessCode(name)).trim().toUpperCase(), name, nav: String(value.nav || value.navigation || value.url || value['导航'] || '').trim(), weight: Number(value.weight ?? value['重量'] ?? 0) || 0, note: String(value.note || value['备注'] || '').trim(), matched: value.matched === true, isNew: value.isNew === true || value.newStore === true, status: String(value.status || '待配送'), route, date };
}

function extractBusinessCode(value) { const match = String(value || '').toUpperCase().match(/(?:^|[^A-Z0-9])((?:JM\d{4,6}|Q\d{3,5}|A\d{4,6}))(?:[^A-Z0-9]|$)/); return match ? match[1] : ''; }
function normalizeStoreName(value) { return String(value || '').trim().replace(/[\s\u3000]+/g, '').replace(/[【】\[\]]/g, '').toLowerCase().replace(/[（(]\s*(?:临时|20\d{2})\s*[）)]/g, '').replace(/谊品鲜/g, '谊品生鲜'); }
function isBoundRoute(session, route) { return normalizeRoute(session?.boundRouteId || session?.route) === normalizeRoute(route); }
function normalizeUserId(value) { return String(value || '').trim().slice(0, 128); }
function encodeKey(value) { return encodeURIComponent(String(value || '').trim()).replace(/%/g, '_'); }
function scopedBaseKey(userId, route) { return routeBaseKey(route); }
function normalizeWeight(value) { if (value === null || value === undefined || value === '') return ''; const s = String(value).trim().replace(/,/g, ''), m = s.match(/[\d]+(?:\.\d+)?/); if (!m) return ''; const n = Number(m[0]); if (!Number.isFinite(n) || n <= 0) return ''; const tons = /吨|\bt\b/i.test(s) ? n : /kg|千克|公斤/i.test(s) ? n / 1000 : n >= 1000 ? n / 1000 : n; const precise = Math.round((tons + Number.EPSILON) * 1000000) / 1000000; return `${precise.toFixed(6).replace(/0+$/,'').replace(/\.$/,'') || '0'}t`; }
function isZeroWeight(value) { const m = String(value || '').match(/[\d]+(?:\.\d+)?/); return !m || Number(m[0]) === 0; }
function parseWeightToTons(value) { const s = String(value ?? '').trim().replace(/,/g, ''); const m = s.match(/[\\d]+(?:\\.\\d+)?/); if (!m) return 0; const n = Number(m[0]); if (!Number.isFinite(n)) return 0; if (/吨|\\bt\\b/i.test(s)) return n; if (/kg|千克|公斤/i.test(s)) return n / 1000; return n >= 1000 ? n / 1000 : n; }
function positiveInt(value) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : 0; }
function dedupeHistoryRecords(input) {
  const byBatch = new Map();
  const fallback = new Map();
  for (const item of Array.isArray(input) ? input : []) {
    if (!item || typeof item !== 'object') continue;
    const batchId = String(item.orderBatchId || '').trim();
    const updated = Date.parse(String(item.updatedAt || item.createdAt || '')) || 0;
    if (batchId) {
      const old = byBatch.get(batchId);
      const oldUpdated = Date.parse(String(old?.updatedAt || old?.createdAt || '')) || 0;
      if (!old || updated >= oldUpdated) byBatch.set(batchId, item);
      continue;
    }
    const signature = historyRecordSignature(item);
    if (!signature) continue;
    const old = fallback.get(signature);
    const oldUpdated = Date.parse(String(old?.updatedAt || old?.createdAt || '')) || 0;
    if (!old || updated >= oldUpdated) fallback.set(signature, item);
  }
  return [...byBatch.values(), ...fallback.values()].sort((a, b) => {
    const at = Date.parse(String(a?.updatedAt || a?.createdAt || '')) || 0;
    const bt = Date.parse(String(b?.updatedAt || b?.createdAt || '')) || 0;
    return bt - at;
  });
}
function historyRecordSignature(record) {
  const stores = Array.isArray(record?.orders) ? record.orders.map(item => normalizeStoreName(item?.name)).filter(Boolean).sort() : [];
  return JSON.stringify({
    route: String(record?.route || ''),
    date: String(record?.date || ''),
    vehicle: String(record?.vehicle || ''),
    weight: normalizeWeight(record?.totalWeight ?? record?.weight),
    stores
  });
}
function normalizeDate(value) { const s = String(value || '').trim().replace(/[年月]/g, '-').replace(/日/g, '').replace(/[/.]/g, '-'), m = s.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/); return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : ''; }

async function acquireLock(env, key, token, seconds) {
  const response = await redisFetch(env, `/set/${encodeURIComponent(key)}/${encodeURIComponent(token)}/NX/EX/${seconds}`, { method: 'POST' });
  if (!response.ok) return false;
  const data = await response.json().catch(() => ({}));
  return data.result === 'OK';
}
async function releaseLock(env, key, token) { const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"; await redisFetch(env, '/eval', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([script, 1, key, token]) }); }
async function redisGet(env, key) {
  const response = await redisFetch(env, `/get/${encodeURIComponent(key)}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Redis读取失败（HTTP ${response.status}）`);
  if (data.result === null || data.result === undefined || data.result === '') return null;
  try { return typeof data.result === 'string' ? JSON.parse(data.result) : data.result; } catch { return null; }
}
async function atomicSaveOrder(env, { todayKey, todayData, latestKey, latestData, historyKey, historyData }) {
  const keys = [todayKey, latestKey];
  const values = [JSON.stringify(todayData), JSON.stringify(latestData)];
  if (historyKey && Array.isArray(historyData)) {
    keys.push(historyKey);
    values.push(JSON.stringify(historyData));
  }
  const script = [
    'for i=1,#KEYS do',
    '  redis.call("SET", KEYS[i], ARGV[i])',
    'end',
    'return "OK"'
  ].join('\n');
  const response = await redisFetch(env, '/eval', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([script, keys.length, ...keys, ...values])
  });
  if (!response.ok) throw new Error(`订单原子保存失败（HTTP ${response.status}）`);
  const data = await response.json().catch(() => ({}));
  if (data.result !== 'OK') throw new Error('订单原子保存未确认');
}

async function redisSet(env, key, value) {
  const response = await redisFetch(env, `/set/${encodeURIComponent(key)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Redis保存失败（HTTP ${response.status}）`);
  if (data.result !== undefined && data.result !== 'OK') throw new Error('Redis保存未确认');
}
async function readAfterWrite(env, key, batchId, count) { for (let attempt = 0; attempt < 3; attempt += 1) { const saved = await redisGet(env, key); if (saved?.orderBatchId === batchId && Array.isArray(saved.orders) && saved.orders.length === count) return saved; if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1))); } return null; }
function json(payload, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
