// 天友智配One - 服务器订单 API
// 订单按「17号线 + 业务日期」独立存储；今日订单只保存实际配送门店。
import { authRequired } from './_auth.js';

const ROUTE = '17号线';

export async function onRequest({ request, env }) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);
  const session = await authRequired(request, env, { route: ROUTE });
  if (!session) return json({ error: '登录已失效或无权限' }, 401);
  try {
    if (request.method === 'POST') return await saveOrder(request, env);
    if (request.method === 'GET') return await readOrder(request, env);
    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('orders api error', error);
    return json({ success: false, error: '订单数据服务暂不可用' }, 503);
  }
}

async function saveOrder(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!Array.isArray(body.orders) || !body.orders.length) return json({ error: '缺少订单数据' }, 400);
  const date = normalizeDate(body.date) || businessDate();
  const key = `today_orders:${ROUTE}:${date}`;
  const lockKey = `lock:orders:${ROUTE}:${date}`;
  const lockToken = createLockToken();
  if (!(await acquireLock(env, lockKey, lockToken, 15))) return json({ error: '该线路正在保存订单，请稍后再试' }, 409);
  try {
    let existing = null;
    let orderBatchId = String(body.orderBatchId || '').trim();
    if (!orderBatchId || !String(body.vehicle || '').trim()) existing = await redisGet(env, key);
    orderBatchId = orderBatchId || existing?.orderBatchId || createBatchId(date);
    let orders = body.orders.map((item, index) => normalizeOrder(item, index, orderBatchId, date)).filter(item => item.name);
    orders = sortByRouteBase(orders, await loadBaseData(env));
    const incomingWeight = normalizeWeight(body.totalWeight ?? body.weight);
    const totalWeight = incomingWeight && !isZeroWeight(incomingWeight) ? incomingWeight : normalizeWeight(existing?.totalWeight);
    const todayData = { orderBatchId, date, route: ROUTE, vehicle: String(body.vehicle || '').trim() || sessionVehicle(existing), orders, totalWeight, count: orders.length, matchedCount: orders.filter(x => x.matched).length, newStoreCount: orders.filter(x => x.isNew).length, recognizedCount: Number(body.recognizedCount) || orders.length, rawOrderCount: Number(body.rawOrderCount) || 0, source: String(body.source || 'web'), updatedAt: new Date().toISOString() };
    await redisSet(env, key, todayData);
    return json({ success: true, data: todayData });
  } finally {
    await releaseLock(env, lockKey, lockToken).catch(() => {});
  }
}

async function readOrder(request, env) {
  const url = new URL(request.url);
  const date = normalizeDate(url.searchParams.get('date')) || businessDate();
  const todayKey = `today_orders:${ROUTE}:${date}`;
  let today = await redisGet(env, todayKey);
  if (!today || !Array.isArray(today.orders)) {
    const history = await redisGet(env, `history:${ROUTE}:${date}`);
    if (Array.isArray(history) && history.length) {
      today = history[history.length - 1] || null;
    } else if (history && Array.isArray(history.orders)) {
      today = history;
    }
  }
  const historyData = await redisGet(env, `history:${ROUTE}:${date}`);
  const history = Array.isArray(historyData) ? historyData : [];
  return json({ success: true, today: today && normalizeDate(today.date) === date ? today : null, history });
}

function sessionVehicle(existing) { return String(existing?.vehicle || '渝DK7692'); }
async function loadBaseData(env) { const raw = await redisGet(env, `route:${ROUTE}:base`); const stores = Array.isArray(raw?.stores) ? raw.stores : []; return stores.map((store, index) => ({ ...store, routeOrder: Number(store?.routeOrder || store?.code || index + 1) || index + 1, nameKey: normalizeStoreName(store?.name || store?.storeName || store?.shopName || store?.['门店名称']) })).filter(store => store.nameKey); }
function sortByRouteBase(orders, base) { if (!base.length) return orders.map((item, index) => ({ ...item, code: String(index + 1).padStart(2, '0') })); const orderMap = new Map(base.map((store, index) => [store.nameKey, Number(store.routeOrder) || index + 1])); const matched = [], news = []; for (const order of orders) { const routeOrder = orderMap.get(normalizeStoreName(order.name)); if (routeOrder != null) matched.push({ ...order, routeOrder, matched: true, isNew: false }); else news.push({ ...order, routeOrder: null, matched: false, isNew: true }); } matched.sort((a, b) => a.routeOrder - b.routeOrder); matched.forEach((item, index) => { item.code = String(index + 1).padStart(2, '0'); }); news.forEach((item, index) => { item.code = `N${String(index + 1).padStart(2, '0')}`; }); return matched.concat(news).map(({ routeOrder, ...item }) => item); }
function normalizeOrder(item, index, batchId, date) { const value = typeof item === 'string' ? { name: item } : (item || {}); return { id: String(value.id || `${batchId}-${index + 1}`), orderBatchId: batchId, code: String(value.code || index + 1).padStart(2, '0'), name: String(value.name || value.storeName || value.shopName || value['门店名称'] || '').trim(), nav: String(value.nav || value.navigation || value.url || value['导航'] || '').trim(), weight: Number(value.weight ?? value['重量'] ?? 0) || 0, note: String(value.note || value['备注'] || '').trim(), matched: value.matched === true, isNew: value.isNew === true || value.newStore === true, status: String(value.status || '待配送'), route: ROUTE, date }; }
async function acquireLock(env, key, token, seconds) { const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(token)}/NX/EX/${seconds}`, { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store' }); if (!response.ok) return false; const data = await response.json().catch(() => ({})); return data.result === 'OK'; }
async function releaseLock(env, key, token) { const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"; await fetch(`${env.UPSTASH_REDIS_REST_URL}/eval`, { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify([script, 1, key, token]), cache: 'no-store' }); }
async function redisGet(env, key) { const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store' }); if (!response.ok) throw new Error('Redis读取失败'); const data = await response.json().catch(() => ({})); if (!data.result) return null; try { return typeof data.result === 'string' ? JSON.parse(data.result) : data.result; } catch { return null; } }
async function redisSet(env, key, value) { const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`, { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(JSON.stringify(value)), cache: 'no-store' }); if (!response.ok) throw new Error('Redis保存失败'); const data = await response.json().catch(() => ({})); if (data.result !== undefined && data.result !== 'OK') throw new Error('Redis保存未确认'); }
function normalizeStoreName(value) { return String(value || '').trim().replace(/[\s\u3000]+/g, '').replace(/[（）()【】\[\]]/g, '').toLowerCase(); }
function normalizeWeight(value) { if (value === null || value === undefined || value === '') return ''; const s = String(value).trim().replace(/,/g, ''); const m = s.match(/[\d]+(?:\.\d+)?/); if (!m) return ''; const n = Number(m[0]); if (!Number.isFinite(n)) return ''; const tons = /吨|\bt\b/i.test(s) ? n : n / 1000; return `${(Math.round((tons + Number.EPSILON) * 10) / 10).toFixed(1)}t`; }
function isZeroWeight(value) { const match = String(value || '').match(/[\d]+(?:\.\d+)?/); return !match || Number(match[0]) === 0; }
function normalizeDate(value) { const s = String(value || '').trim().replace(/[年月]/g, '-').replace(/日/g, '').replace(/[/.]/g, '-'); const m = s.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/); return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : ''; }
function businessDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function createBatchId(date) { return `${date}-17-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`; }
function createLockToken() { return `${Date.now()}-${Math.random().toString(36).slice(2)}-${crypto.randomUUID?.() || ''}`; }
function json(payload, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
