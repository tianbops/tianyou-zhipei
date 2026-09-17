// 天友智配One - 服务器订单 API
// 订单按「线路 + 业务日期」独立存储；首页无日期时显示最后一次成功导入的运单。
import { authRequired } from './_auth.js';

const ROUTE = '17号线';
const LATEST_KEY = `latest_order:${ROUTE}`;

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
    const existing = await redisGet(env, key);
    const orderBatchId = String(body.orderBatchId || '').trim() || existing?.orderBatchId || createBatchId(date);
    let orders = body.orders.map((item, index) => normalizeOrder(item, index, orderBatchId, date)).filter(item => item.name);
    orders = sortByRouteBase(orders, await loadBaseData(env));
    const incomingWeight = normalizeWeight(body.totalWeight ?? body.weight);
    const totalWeight = incomingWeight && !isZeroWeight(incomingWeight) ? incomingWeight : normalizeWeight(existing?.totalWeight);
    const todayData = { orderBatchId, date, route: ROUTE, vehicle: String(body.vehicle || '').trim() || sessionVehicle(existing), orders, totalWeight, count: orders.length, matchedCount: orders.filter(x => x.matched).length, newStoreCount: orders.filter(x => x.isNew).length, recognizedCount: Number(body.recognizedCount) || orders.length, rawOrderCount: Number(body.rawOrderCount) || 0, source: String(body.source || 'web'), updatedAt: new Date().toISOString() };
    await redisSet(env, key, todayData);
    const saved = await readAfterWrite(env, key, orderBatchId, orders.length);
    if (!saved) throw new Error('订单已提交但服务器未确认保存成功，请重试');
    await redisSet(env, LATEST_KEY, { date, orderBatchId, updatedAt: saved.updatedAt });
    return json({ success: true, data: saved });
  } finally {
    await releaseLock(env, lockKey, lockToken).catch(() => {});
  }
}

async function readOrder(request, env) {
  const url = new URL(request.url);
  const requestedDate = normalizeDate(url.searchParams.get('date'));
  const batch = String(url.searchParams.get('orderBatchId') || url.searchParams.get('batch') || '').trim();
  let date = requestedDate || '';

  if (!date) {
    const latest = await redisGet(env, LATEST_KEY);
    date = normalizeDate(latest?.date) || '';
    if (!date) {
      const fallback = await findLatestHistory(env);
      if (fallback) date = fallback.date;
    }
  }
  if (!date) return json({ success: true, today: null, history: [] });

  const todayKey = `today_orders:${ROUTE}:${date}`;
  const historyKey = `history:${ROUTE}:${date}`;
  let today = await redisGet(env, todayKey);
  const historyData = await redisGet(env, historyKey);
  const history = Array.isArray(historyData) ? historyData : [];

  if (batch) {
    if (today?.orderBatchId !== batch) today = history.find(item => item?.orderBatchId === batch) || null;
  } else if (!today || !Array.isArray(today.orders)) {
    today = history.length ? history[history.length - 1] : (historyData?.orders ? historyData : null);
  }

  return json({ success: true, today: today && normalizeDate(today.date) === date ? today : null, history });
}

async function findLatestHistory(env) {
  let cursor = '0';
  let newest = null;
  for (let page = 0; page < 5; page += 1) {
    const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/scan/${cursor}/match/${encodeURIComponent(`history:${ROUTE}:*`)}/count/100`, { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store' });
    if (!response.ok) break;
    const data = await response.json().catch(() => ({}));
    const keys = Array.isArray(data.result?.[1]) ? data.result[1] : [];
    for (const key of keys) {
      const value = await redisGet(env, key);
      const list = Array.isArray(value) ? value : (value?.orders ? [value] : []);
      for (const item of list) {
        if (!item?.date || !item?.orders?.length) continue;
        if (!newest || String(item.updatedAt || '') > String(newest.updatedAt || '')) newest = item;
      }
    }
    cursor = String(data.result?.[0] || '0');
    if (cursor === '0') break;
  }
  return newest;
}

async function loadBaseData(env) {
  const raw = await redisGet(env, `route:${ROUTE}:base`);
  const stores = Array.isArray(raw?.stores) ? raw.stores : [];
  return stores.map((store, index) => ({ ...store, routeOrder: Number(store?.routeOrder || store?.code || index + 1) || index + 1, nameKey: normalizeStoreName(store?.name || store?.storeName || store?.shopName || store?.['门店名称']) })).filter(store => store.nameKey);
}
function sortByRouteBase(orders, base) {
  if (!base.length) return orders.map((item, index) => ({ ...item, code: String(index + 1).padStart(2, '0') }));
  const orderMap = new Map(base.map((store, index) => [store.nameKey, Number(store.routeOrder) || index + 1]));
  const matched = [], news = [];
  for (const order of orders) {
    const routeOrder = orderMap.get(normalizeStoreName(order.name));
    if (routeOrder != null) matched.push({ ...order, routeOrder, matched: true, isNew: false }); else news.push({ ...order, routeOrder: null, matched: false, isNew: true });
  }
  matched.sort((a, b) => a.routeOrder - b.routeOrder);
  matched.forEach((item, index) => { item.code = String(index + 1).padStart(2, '0'); });
  news.forEach((item, index) => { item.code = `N${String(index + 1).padStart(2, '0')}`; });
  return matched.concat(news).map(({ routeOrder, ...item }) => item);
}
function normalizeOrder(item, index, batchId, date) { const value = typeof item === 'string' ? { name: item } : (item || {}); return { id: String(value.id || `${batchId}-${index + 1}`), orderBatchId: batchId, code: String(value.code || index + 1).padStart(2, '0'), name: String(value.name || value.storeName || value.shopName || value['门店名称'] || '').trim(), nav: String(value.nav || value.navigation || value.url || value['导航'] || '').trim(), weight: Number(value.weight ?? value['重量'] ?? 0) || 0, note: String(value.note || value['备注'] || '').trim(), matched: value.matched === true, isNew: value.isNew === true || value.newStore === true, status: String(value.status || '待配送'), route: ROUTE, date }; }
async function acquireLock(env, key, token, seconds) { const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(token)}/NX/EX/${seconds}`, { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store' }); if (!response.ok) return false; const data = await response.json().catch(() => ({})); return data.result === 'OK'; }
async function releaseLock(env, key, token) { const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"; await fetch(`${env.UPSTASH_REDIS_REST_URL}/eval`, { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify([script, 1, key, token]), cache: 'no-store' }); }
async function redisGet(env, key) { const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store' }); if (!response.ok) throw new Error('Redis读取失败'); const data = await response.json().catch(() => ({})); if (data.result === null || data.result === undefined || data.result === '') return null; try { return typeof data.result === 'string' ? JSON.parse(data.result) : data.result; } catch { return null; } }
async function redisSet(env, key, value) { const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`, { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value), cache: 'no-store' }); if (!response.ok) throw new Error('Redis保存失败'); const data = await response.json().catch(() => ({})); if (data.result !== undefined && data.result !== 'OK') throw new Error('Redis保存未确认'); }
async function readAfterWrite(env, key, batchId, count) { for (let attempt = 0; attempt < 3; attempt += 1) { const saved = await redisGet(env, key); if (saved?.orderBatchId === batchId && Array.isArray(saved.orders) && saved.orders.length === count) return saved; if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1))); } return null; }
function sessionVehicle(existing) { return String(existing?.vehicle || '渝DK7692'); }
function normalizeStoreName(value) { let text = String(value || '').trim().replace(/[\s\u3000]+/g, '').replace(/[（）()【】\[\]]/g, '').toLowerCase(); text = text.replace(/[（(]\s*(?:临时|20\d{2})\s*[）)]/g, '').replace(/谊品鲜/g, '谊品生鲜').replace(/江北亿达鲜半华府店/g, '江北亿达鲜半山华府店'); if (text.includes('到家主城') && text.includes('江北区加州')) text = text.replace(/客服中心|客户中心/g, '服务中心'); return text; }
function normalizeWeight(value) { if (value === null || value === undefined || value === '') return ''; const s = String(value).trim().replace(/,/g, ''); const m = s.match(/[\d]+(?:\.\d+)?/); if (!m) return ''; const n = Number(m[0]); if (!Number.isFinite(n) || n <= 0) return ''; const tons = /吨|\bt\b/i.test(s) ? n : /kg|千克|公斤/i.test(s) ? n / 1000 : n >= 1000 ? n / 1000 : n; const precise = Math.round((tons + Number.EPSILON) * 1000000) / 1000000; return `${precise.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0'}t`; }
function isZeroWeight(value) { const match = String(value || '').match(/[\d]+(?:\.\d+)?/); return !match || Number(match[0]) === 0; }
function normalizeDate(value) { const s = String(value || '').trim().replace(/[年月]/g, '-').replace(/日/g, '').replace(/[/.]/g, '-'); const m = s.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/); return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : ''; }
function businessDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function createBatchId(date) { return `${date}-17-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`; }
function createLockToken() { return `${Date.now()}-${Math.random().toString(36).slice(2)}-${crypto.randomUUID?.() || ''}`; }
function json(payload, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
