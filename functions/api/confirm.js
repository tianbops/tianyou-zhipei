// 天友智配One - 运单确认入库 API
// 只有用户确认后的数据才能进入正式订单。
import { authRequired } from './_auth.js';

const ROUTE = '17号线';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
  const session = await authRequired(request, env, { route: ROUTE });
  if (!session) return json({ success: false, error: '登录已失效或无权限' }, 401);
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ success: false, error: 'Redis not configured' }, 500);

  try {
    const body = await request.json().catch(() => ({}));
    if (!Array.isArray(body.orders) || !body.orders.length) return json({ success: false, error: '没有可确认的订单' }, 400);

    const pending = body.orders.filter(item => item?.needsReview === true || item?.matchType === 'review' || String(item?.candidate || '').trim());
    if (pending.length) return json({ success: false, code: 'REVIEW_REQUIRED', error: `仍有 ${pending.length} 家疑似门店未确认`, review: pending.map(item => ({ name: item?.name || '', candidate: item?.candidate || '', matchScore: Number(item?.matchScore) || 0 })) }, 409);

    const date = normalizeDate(body.date) || businessDate();
    const base = await loadBase(env);
    const canonical = canonicalizeOrders(body.orders, base);
    const orderBatchId = String(body.orderBatchId || '').trim() || createBatchId(date);
    const orders = sortOrders(canonical.map((item, index) => normalizeOrder(item, index, orderBatchId, date)), base);
    const totalWeight = resolveTotalWeight(body.totalWeight ?? body.weight, body.rawText);
    if (!totalWeight) return json({ success: false, code: 'WEIGHT_MISSING', error: '未识别到商品总量，请重新解析后再确认' }, 422);

    const todayData = {
      orderBatchId, date, route: ROUTE,
      vehicle: String(body.vehicle || '').trim() || '渝DK7692',
      orders, totalWeight, count: orders.length,
      matchedCount: orders.filter(item => item.matched).length,
      newStoreCount: orders.filter(item => item.isNew).length,
      recognizedCount: Number(body.recognizedCount) || orders.length,
      rawOrderCount: Number(body.rawOrderCount) || 0,
      source: String(body.source || 'web-confirm'),
      updatedAt: new Date().toISOString()
    };

    const todayKey = `today_orders:${ROUTE}:${date}`;
    await redisSet(env, todayKey, todayData);
    const saved = await readAfterWrite(env, todayKey, orderBatchId, orders.length);
    if (!saved) throw new Error('订单已提交但服务器未确认保存成功，请重试');

    await saveHistory(env, date, saved);
    return json({ success: true, data: saved });
  } catch (error) {
    console.error('confirm api error', error);
    return json({ success: false, error: error?.message || '确认入库失败' }, 503);
  }
}

async function loadBase(env) {
  const raw = await redisGet(env, `route:${ROUTE}:base`);
  const stores = Array.isArray(raw?.stores) ? raw.stores : [];
  if (!stores.length) throw new Error(`未找到${ROUTE}独立基准数据库`);
  return stores.map((store, index) => ({ name: String(store?.name || store?.storeName || store?.shopName || store?.['门店名称'] || '').trim(), code: String(store?.code || index + 1).padStart(2, '0'), nav: String(store?.nav || store?.navigation || store?.url || store?.['导航'] || '').trim(), routeOrder: Number(store?.routeOrder || store?.code || index + 1) || index + 1 })).filter(store => store.name);
}

function canonicalizeOrders(input, base) {
  const byName = new Map(base.map(store => [key(store.name), store]));
  const byCode = new Map(base.map(store => [String(store.code), store]));
  return input.map(item => {
    const raw = typeof item === 'string' ? { name: item } : (item || {});
    const name = String(raw.name || raw.storeName || raw.shopName || raw['门店名称'] || '').trim();
    const hit = byName.get(key(name)) || byCode.get(String(raw.code || ''));
    if (!hit) return { ...raw, name, matched: false, isNew: true, needsReview: false, candidate: '', matchType: 'new' };
    return { ...raw, name: hit.name, code: hit.code, nav: hit.nav, matched: true, isNew: false, needsReview: false, candidate: '', matchType: 'confirmed', matchScore: 1 };
  });
}

function sortOrders(orders, base) {
  const rank = new Map(base.map((store, index) => [key(store.name), Number(store.routeOrder) || index + 1]));
  const matched = [], news = [];
  for (const item of orders) {
    const order = rank.get(key(item.name));
    if (order == null) news.push({ ...item, isNew: true, matched: false });
    else matched.push({ ...item, routeOrder: order, isNew: false, matched: true });
  }
  matched.sort((a, b) => a.routeOrder - b.routeOrder);
  matched.forEach((item, index) => { item.code = String(index + 1).padStart(2, '0'); });
  news.forEach((item, index) => { item.code = `N${String(index + 1).padStart(2, '0')}`; });
  return matched.concat(news).map(({ routeOrder, ...item }) => item);
}

function normalizeOrder(item, index, batchId, date) {
  return { id: String(item.id || `${batchId}-${index + 1}`), orderBatchId: batchId, code: String(item.code || index + 1).padStart(2, '0'), name: String(item.name || '').trim(), nav: String(item.nav || '').trim(), weight: Number(item.weight) || 0, note: String(item.note || '').trim(), matched: item.matched === true, isNew: item.isNew === true, status: String(item.status || '待配送'), route: ROUTE, date };
}

async function saveHistory(env, date, today) {
  const keyName = `history:${ROUTE}:${date}`;
  const old = await redisGet(env, keyName);
  let list = Array.isArray(old) ? old : [];
  const record = { orderBatchId: today.orderBatchId, date, route: ROUTE, vehicle: today.vehicle, count: today.count, weight: today.totalWeight, totalWeight: today.totalWeight, orders: today.orders, matchedCount: today.matchedCount, newStoreCount: today.newStoreCount, recognizedCount: today.recognizedCount, rawOrderCount: today.rawOrderCount, source: today.source, updatedAt: today.updatedAt };
  const index = list.findIndex(item => item?.orderBatchId === today.orderBatchId);
  if (index >= 0) list[index] = record; else list.push(record);
  if (list.length > 90) list = list.slice(-90);
  await redisSet(env, keyName, list);
}

async function readAfterWrite(env, keyName, batchId, count) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const saved = await redisGet(env, keyName);
    if (saved?.orderBatchId === batchId && Array.isArray(saved.orders) && saved.orders.length === count && normalizeWeight(saved.totalWeight)) return saved;
    if (attempt < 2) await wait(150 * (attempt + 1));
  }
  return null;
}

async function redisGet(env, keyName) {
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(keyName)}`, { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store' });
  if (!response.ok) throw new Error('Redis读取失败');
  const data = await response.json().catch(() => ({}));
  if (data.result === null || data.result === undefined || data.result === '') return null;
  try { return typeof data.result === 'string' ? JSON.parse(data.result) : data.result; } catch { return null; }
}

async function redisSet(env, keyName, value) {
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(keyName)}`, { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value), cache: 'no-store' });
  if (!response.ok) throw new Error('Redis保存失败');
  const data = await response.json().catch(() => ({}));
  if (data.result !== undefined && data.result !== 'OK') throw new Error('Redis保存未确认');
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function key(value) { return String(value || '').trim().replace(/[\s\u3000（）()【】\[\]{}]/g, '').toLowerCase(); }
function normalizeDate(value) { const s = String(value || '').trim().replace(/[年月]/g, '-').replace(/日/g, '').replace(/[/.]/g, '-'); const m = s.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/); return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : ''; }
function businessDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function normalizeWeight(value) { if (value === null || value === undefined || value === '') return ''; const s = String(value).trim().replace(/,/g, ''); const m = s.match(/[\d]+(?:\.\d+)?/); if (!m) return ''; const n = Number(m[0]); if (!Number.isFinite(n) || n <= 0) return ''; const tons = /吨|\bt\b/i.test(s) ? n : /kg|千克|公斤/i.test(s) ? n / 1000 : n >= 1000 ? n / 1000 : n; const precise = Math.round((tons + Number.EPSILON) * 1000000) / 1000000; return `${precise.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0'}t`; }
function resolveTotalWeight(value, rawText) {
  const direct = normalizeWeight(value);
  if (direct) return direct;
  const source = String(rawText || '').replace(/\s+/g, ' ');
  const match = source.match(/(?:总\s*重\s*量|总重|重量)\s*[:：]?\s*([\d]+(?:\.\d+)?)\s*(kg|千克|公斤|吨|t)?/i) || source.match(/([\d]+(?:\.\d+)?)\s*(?:kg|千克|公斤|吨|t)\b/i);
  return match ? normalizeWeight(`${match[1]}${match[2] || ''}`) : '';
}
function createBatchId(date) { return `${date}-17-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`; }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-store' } }); }
