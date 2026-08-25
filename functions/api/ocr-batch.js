// 天友智配One - OCR结果入批次
// OCR识别完成后，由服务器生成唯一 orderBatchId，并把当前运单批次保存为真实数据。
import { authRequired } from './_auth.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
  const session = await authRequired(request, env);
  if (!session) return json({ success: false, error: '登录已失效或无权限' }, 401);
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ success: false, error: '服务器数据库不可用' }, 503);

  try {
    const body = await request.json();
    const requestedRoute = normalizeRoute(body.route);
    const sessionRoute = normalizeRoute(session.route);
    const route = session.role === 'admin' ? requestedRoute : sessionRoute;
    if (!route) return json({ success: false, error: '用户未绑定线路' }, 403);
    if (!Array.isArray(body.stores) || !body.stores.length) return json({ success: false, error: '没有可保存的门店数据' }, 400);

    const date = normalizeDate(body.date) || new Date().toISOString().slice(0, 10);
    const orderBatchId = createBatchId(route, date);
    const orders = body.stores.map((s, i) => normalizeOrder(s, i, orderBatchId, route, date)).filter(x => x.name);
    if (!orders.length) return json({ success: false, error: '没有有效门店数据' }, 400);

    const data = {
      orderBatchId,
      route,
      date,
      vehicle: String(body.vehicle || '').trim(),
      totalWeight: normalizeWeight(body.totalWeight),
      rawOrderCount: Number(body.rawOrderCount) || 0,
      count: orders.length,
      matchedCount: Number(body.matchedCount) || 0,
      newStoreCount: Number(body.newStoreCount) || 0,
      recognizedCount: Number(body.recognizedCount) || orders.length,
      source: 'ocr',
      orders,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await redisSet(env, `today_orders:${route}`, data);
    const historyKey = `history:${route}:${date}`;
    const old = await redisGet(env, historyKey);
    const history = Array.isArray(old) ? old : [];
    const record = { ...data, stores: data.count, weight: data.totalWeight };
    const index = history.findIndex(x => x?.orderBatchId === orderBatchId);
    if (index >= 0) history[index] = record; else history.push(record);
    await redisSet(env, historyKey, history.slice(-90));

    return json({ success: true, data: { orderBatchId, route, date, count: data.count, totalWeight: data.totalWeight } });
  } catch (e) {
    console.error('ocr-batch error', e);
    return json({ success: false, error: 'OCR批次保存失败，请重试' }, 503);
  }
}

function normalizeOrder(s, i, batchId, route, date) {
  const x = s || {};
  return {
    id: `${batchId}-${i + 1}`,
    orderBatchId: batchId,
    code: String(x.code || i + 1).padStart(2, '0'),
    name: String(x.name || x.storeName || '').trim(),
    nav: String(x.nav || x.navigation || x.url || '').trim(),
    weight: Number(x.weight) || 0,
    note: String(x.note || '').trim(),
    matched: x.matched === true,
    isNew: x.isNew === true,
    status: x.status || '待配送',
    route,
    date
  };
}

function createBatchId(route, date) {
  const safe = route.replace(/[^0-9A-Za-z\u4e00-\u9fa5]/g, '');
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${date}-${safe}-${stamp}`;
}
function normalizeRoute(v) {
  const s = String(v || '').trim();
  const m = s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  return m ? `${String(parseInt(m[1] || m[2], 10)).padStart(2, '0')}号线` : s;
}
function normalizeDate(v) {
  const s = String(v || '').trim().replace(/[年月]/g, '-').replace(/日/g, '').replace(/[/.]/g, '-');
  const m = s.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/);
  return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : '';
}
function normalizeWeight(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v).trim();
  const m = s.match(/[\d]+(?:\.\d+)?/);
  if (!m) return '';
  const n = Number(m[0]);
  return /吨|\bt\b/i.test(s) ? `${n}t` : `${n}kg`;
}
async function redisGet(env, key) {
  const r = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store' });
  if (!r.ok) throw Error('Redis读取失败');
  const d = await r.json();
  if (!d.result) return null;
  try { return JSON.parse(d.result); } catch { return null; }
}
async function redisSet(env, key, value) {
  const r = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`, { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(JSON.stringify(value)) });
  if (!r.ok) throw Error('Redis保存失败');
}
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
