// 天友智配One - 用户独立订单 API
// 今日订单、最近订单均按用户ID+线路+日期存储，服务器为唯一真实数据源。
import { authRequired } from './_auth.js';

export async function onRequest({ request, env }) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);
  const session = await authRequired(request, env);
  if (!session?.route || !session?.id) return json({ error: '登录已失效或权限信息不完整' }, 401);
  try {
    if (request.method === 'POST') return await saveOrder(request, env, session);
    if (request.method === 'GET') return await readOrder(request, env, session);
    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('orders api error', error);
    return json({ success: false, error: '订单数据服务暂不可用' }, 503);
  }
}

async function saveOrder(request, env, session) {
  const route = normalizeRoute(session.route), userId = normalizeUserId(session.id);
  const body = await request.json().catch(() => ({}));
  if (!Array.isArray(body.orders) || !body.orders.length) return json({ error: '缺少订单数据' }, 400);
  const date = normalizeDate(body.date) || businessDate();
  const key = scopedKey(userId, route, `today:${date}`), latestKey = scopedKey(userId, route, 'latest');
  const lockKey = scopedKey(userId, route, `lock:${date}`), lockToken = createLockToken();
  if (!(await acquireLock(env, lockKey, lockToken, 15))) return json({ error: '当前用户正在保存订单，请稍后再试' }, 409);
  try {
    const existing = await redisGet(env, key);
    const orderBatchId = String(body.orderBatchId || '').trim() || existing?.orderBatchId || createBatchId(date, route);
    const base = await loadBaseData(env, route);
    const normalized = body.orders.map((item, index) => normalizeOrder(item, index, orderBatchId, date, route)).filter(item => item.name);
    const rawOrderCount = positiveInt(body.rawOrderCount) || positiveInt(body.recognizedCount) || normalized.length;
    const uniqueOrders = dedupeOrders(normalized, base);
    const duplicateCount = Math.max(0, normalized.length - uniqueOrders.length);
    const orders = sortByRouteBase(uniqueOrders, base);
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
      source: String(body.source || 'web'), updatedAt: new Date().toISOString()
    };
    await redisSet(env, key, todayData);
    const saved = await readAfterWrite(env, key, orderBatchId, orders.length);
    if (!saved) throw new Error('订单已提交但服务器未确认保存成功，请重试');
    await redisSet(env, latestKey, { date, orderBatchId, updatedAt: saved.updatedAt });
    return json({ success: true, data: saved });
  } finally { await releaseLock(env, lockKey, lockToken).catch(() => {}); }
}

async function readOrder(request, env, session) {
  const route = normalizeRoute(session.route), userId = normalizeUserId(session.id);
  const url = new URL(request.url), requestedDate = normalizeDate(url.searchParams.get('date'));
  const batch = String(url.searchParams.get('orderBatchId') || url.searchParams.get('batch') || '').trim();
  const latest = await redisGet(env, scopedKey(userId, route, 'latest'));
  let date = requestedDate || normalizeDate(latest?.date);
  if (!date) {
    const fallback = await findLatestHistory(env, userId, route);
    date = fallback?.date || '';
  }
  if (!date) return json({ success: true, today: null, history: [] });
  const today = await redisGet(env, scopedKey(userId, route, `today:${date}`));
  const historyData = await redisGet(env, scopedKey(userId, route, `history:${date}`));
  const history = Array.isArray(historyData) ? historyData : [];
  let selected = today;
  if (batch && selected?.orderBatchId !== batch) selected = history.find(item => item?.orderBatchId === batch) || null;
  else if (!selected || !Array.isArray(selected.orders)) selected = history[history.length - 1] || null;
  return json({ success: true, today: selected && normalizeDate(selected.date) === date ? selected : null, history });
}

async function findLatestHistory(env, userId, route) {
  let cursor = '0', newest = null;
  const pattern = scopedKey(userId, route, 'history:*');
  for (let page = 0; page < 5; page += 1) {
    const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/scan/${cursor}/match/${encodeURIComponent(pattern)}/count/100`, { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store' });
    if (!response.ok) break;
    const data = await response.json().catch(() => ({}));
    for (const key of Array.isArray(data.result?.[1]) ? data.result[1] : []) {
      const value = await redisGet(env, key), list = Array.isArray(value) ? value : (value?.orders ? [value] : []);
      for (const item of list) if (item?.date && item?.orders?.length && (!newest || String(item.updatedAt || '') > String(newest.updatedAt || ''))) newest = item;
    }
    cursor = String(data.result?.[0] || '0');
    if (cursor === '0') break;
  }
  return newest;
}

async function loadBaseData(env, route) {
  const raw = await redisGet(env, `route:${route}:base`), stores = Array.isArray(raw?.stores) ? raw.stores : [];
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
function normalizeUserId(value) { return String(value || '').trim().slice(0, 128); }
function encodeKey(value) { return encodeURIComponent(String(value || '').trim()).replace(/%/g, '_'); }
function scopedKey(userId, route, suffix) { return `user:${encodeKey(userId)}:route:${encodeKey(route)}:orders:${suffix}`; }
function normalizeWeight(value) { if (value === null || value === undefined || value === '') return ''; const s = String(value).trim().replace(/,/g, ''), m = s.match(/[\d]+(?:\.\d+)?/); if (!m) return ''; const n = Number(m[0]); if (!Number.isFinite(n) || n <= 0) return ''; const tons = /吨|\bt\b/i.test(s) ? n : /kg|千克|公斤/i.test(s) ? n / 1000 : n >= 1000 ? n / 1000 : n; const precise = Math.round((tons + Number.EPSILON) * 1000000) / 1000000; return `${precise.toFixed(6).replace(/0+$/,'').replace(/\.$/,'') || '0'}t`; }
function isZeroWeight(value) { const m = String(value || '').match(/[\d]+(?:\.\d+)?/); return !m || Number(m[0]) === 0; }
function positiveInt(value) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : 0; }
function normalizeDate(value) { const s = String(value || '').trim().replace(/[年月]/g, '-').replace(/日/g, '').replace(/[/.]/g, '-'), m = s.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/); return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : ''; }
function businessDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function createBatchId(date, route) { return `${date}-${route.replace(/\D/g, '')}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`; }
function createLockToken() { return `${Date.now()}-${Math.random().toString(36).slice(2)}-${crypto.randomUUID?.() || ''}`; }
async function acquireLock(env, key, token, seconds) { const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(token)}/NX/EX/${seconds}`, { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store' }); if (!response.ok) return false; const data = await response.json().catch(() => ({})); return data.result === 'OK'; }
async function releaseLock(env, key, token) { const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"; await fetch(`${env.UPSTASH_REDIS_REST_URL}/eval`, { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify([script, 1, key, token]), cache: 'no-store' }); }
async function redisGet(env, key) { const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store' }); if (!response.ok) throw new Error('Redis读取失败'); const data = await response.json().catch(() => ({})); if (data.result === null || data.result === undefined || data.result === '') return null; try { return typeof data.result === 'string' ? JSON.parse(data.result) : data.result; } catch { return null; } }
async function redisSet(env, key, value) { const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`, { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value), cache: 'no-store' }); if (!response.ok) throw new Error('Redis保存失败'); const data = await response.json().catch(() => ({})); if (data.result !== undefined && data.result !== 'OK') throw new Error('Redis保存未确认'); }
async function readAfterWrite(env, key, batchId, count) { for (let attempt = 0; attempt < 3; attempt += 1) { const saved = await redisGet(env, key); if (saved?.orderBatchId === batchId && Array.isArray(saved.orders) && saved.orders.length === count) return saved; if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1))); } return null; }
function json(payload, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
