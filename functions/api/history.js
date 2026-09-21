// Zhipei One - 用户独立历史查询 API
// 历史数据按用户ID+线路+日期独立存储；允许提前一天上传并查询明日运单。
import { authRequired } from './_auth.js';

const HISTORY_DAYS = 31;
const FUTURE_DAYS = 1;

export async function onRequest({ request, env }) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);
  const session = await authRequired(request, env);
  if (!session?.route || !session?.id) return json({ error: '登录已失效或权限信息不完整' }, 401);
  const url = new URL(request.url), date = normalizeDate(url.searchParams.get('date'));
  if (!date) return json({ error: 'Missing date parameter' }, 400);
  const route = normalizeRoute(session.route), userId = normalizeUserId(session.id);
  try {
    if (request.method === 'DELETE') return await deleteHistoryRecord(env, userId, route, date, String(url.searchParams.get('orderBatchId') || url.searchParams.get('batch') || '').trim());
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    await purgeExpiredHistory(env, userId, route);
    if (!isWithinRetention(date)) return json([]);
    const key = scopedKey(userId, route, `history:${date}`), result = await redisGet(env, key), records = Array.isArray(result) ? result : [];
    const { records: cleaned, changed } = dedupeHistory(filterRetention(records));
    if (changed || cleaned.length !== records.length) await redisSet(env, key, cleaned);
    return json(cleaned);
  } catch (error) {
    console.error('history api error', error);
    return json({ error: request.method === 'DELETE' ? '历史记录删除失败' : '历史数据服务异常' }, 503);
  }
}

async function deleteHistoryRecord(env, userId, route, date, batchId) {
  if (!isWithinRetention(date)) return json({ success: true, deleted: 0, date, expired: true });
  const key = scopedKey(userId, route, `history:${date}`), records = await redisGet(env, key);
  if (!Array.isArray(records) || !records.length) return json({ success: true, deleted: 0, date });
  const current = dedupeHistory(filterRetention(records)).records, target = batchId ? current.find(item => String(item?.orderBatchId || '') === batchId) : null;
  if (!target) return json({ success: false, error: '未找到要删除的历史记录' }, 404);
  const signature = historySignature(target);
  if (!signature) return json({ success: false, error: '该历史记录数据无效，无法删除' }, 400);
  const targetBatchId = String(target?.orderBatchId || '').trim();
  const remaining = targetBatchId
    ? current.filter(item => String(item?.orderBatchId || '').trim() !== targetBatchId)
    : current.filter(item => historySignature(item) !== signature);
  const deleted = current.length - remaining.length;
  await redisSet(env, key, remaining);
  let todayDeleted = false;
  if (date === businessDate()) {
    const todayKey = scopedKey(userId, route, `today:${date}`), today = await redisGet(env, todayKey);
    if (today && targetBatchId && String(today?.orderBatchId || '').trim() === targetBatchId) { await redisDelete(env, todayKey); todayDeleted = true; }
  }
  await purgeExpiredHistory(env, userId, route);
  return json({ success: true, deleted, date, orderBatchId: batchId, removedSameData: Math.max(0, deleted - 1), todayDeleted });
}

async function purgeExpiredHistory(env, userId, route) {
  const today = businessDate(), cutoff = addDays(today, -(HISTORY_DAYS - 1)), futureCutoff = addDays(today, FUTURE_DAYS), keys = await scanKeys(env, scopedKey(userId, route, 'history:*'));
  if (!keys.length) return;
  const commands = [];
  for (const key of keys) {
    const date = normalizeDate(String(key).split(':history:').pop());
    if (!date || date < cutoff || date > futureCutoff) { commands.push(['DEL', key]); continue; }
    const raw = await redisGet(env, key), records = Array.isArray(raw) ? raw : [], filtered = filterRetention(records), cleaned = dedupeHistory(filtered).records;
    if (!cleaned.length) commands.push(['DEL', key]);
    else if (cleaned.length !== records.length) commands.push(['SET', key, JSON.stringify(cleaned)]);
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

function filterRetention(records) { return records.filter(item => isWithinRetention(normalizeDate(item?.date))); }
function isWithinRetention(date) {
  const normalized = normalizeDate(date); if (!normalized) return false;
  const today = businessDate(), target = new Date(`${normalized}T00:00:00+08:00`), current = new Date(`${today}T00:00:00+08:00`), diffDays = Math.floor((current - target) / 86400000);
  return diffDays >= -FUTURE_DAYS && diffDays < HISTORY_DAYS;
}
function dedupeHistory(input) { const map = new Map(); let changed = false; for (const item of input) { if (!item || typeof item !== 'object') { changed = true; continue; } const signature = historySignature(item); if (!signature) { changed = true; continue; } const old = map.get(signature); if (!old) map.set(signature, item); else { changed = true; if (compareUpdatedAt(item, old) > 0) map.set(signature, item); } } const records = Array.from(map.values()).sort((a, b) => compareUpdatedAt(b, a)); if (records.length !== input.length) changed = true; return { records, changed }; }
function historySignature(record) { const route = String(record?.route || '').trim(), date = normalizeDate(record?.date), vehicle = String(record?.vehicle || '').trim().toLowerCase(), weight = normalizeWeight(record?.totalWeight ?? record?.weight), orders = Array.isArray(record?.orders) ? record.orders : []; if (!date && !orders.length && !weight) return ''; const stores = orders.map(item => normalizeStoreName(item?.name || item?.storeName || item?.shopName || item?.['门店名称'])).filter(Boolean).sort(); return JSON.stringify({ route, date, vehicle, weight, stores }); }
function todayOrderSignature(record) { return historySignature(record); }
function normalizeStoreName(value) { return String(value || '').trim().replace(/[\s\u3000（）()【】\[\]]/g, '').replace(/谊品鲜/g, '谊品生鲜').replace(/\b20\d{2}\b/g, '').replace(/临时/g, '').toLowerCase(); }
function normalizeNumber(value) { const n = Number(value); return Number.isFinite(n) ? Math.round(n * 1000000) / 1000000 : 0; }
function normalizeWeight(value) { if (value === null || value === undefined || value === '') return ''; const s = String(value).trim().replace(/,/g, ''), m = s.match(/[\d]+(?:\.\d+)?/); if (!m) return ''; const n = Number(m[0]); if (!Number.isFinite(n) || n < 0) return ''; const tons = /吨|\bt\b/i.test(s) ? n : /kg|千克|公斤/i.test(s) ? n / 1000 : n >= 1000 ? n / 1000 : n; return `${(Math.round((tons + Number.EPSILON) * 1000000) / 1000000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`; }
function compareUpdatedAt(a, b) { return (Date.parse(String(a?.updatedAt || a?.createdAt || '')) || 0) - (Date.parse(String(b?.updatedAt || b?.createdAt || '')) || 0); }
function normalizeUserId(value) { return String(value || '').trim().slice(0, 128); }
function encodeKey(value) { return encodeURIComponent(String(value || '').trim()).replace(/%/g, '_'); }
function scopedKey(userId, route, suffix) { return `user:${encodeKey(userId)}:route:${encodeKey(route)}:orders:${suffix}`; }
function normalizeRoute(value) { const s = String(value || '').trim(), m = s.match(/^(?:([0-9]+)|([0-9]+)号线)$/); return m ? `${String(parseInt(m[1] || m[2], 10)).padStart(2, '0')}号线` : s; }
function businessDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function addDays(date, days) { const d = new Date(`${date}T00:00:00+08:00`); d.setUTCDate(d.getUTCDate() + days); return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
async function redisGet(env, key) { const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store' }); if (!response.ok) throw new Error('Redis读取失败'); const data = await response.json().catch(() => ({})); if (data.result === null || data.result === undefined || data.result === '') return null; try { return typeof data.result === 'string' ? JSON.parse(data.result) : data.result; } catch { return null; } }
async function redisSet(env, key, value) { const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`, { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value), cache: 'no-store' }); if (!response.ok) throw new Error('Redis保存失败'); }
async function redisDelete(env, key) { const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/del/${encodeURIComponent(key)}`, { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store' }); if (!response.ok) throw new Error('Redis删除失败'); }
async function redisPipeline(env, commands) { const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/pipeline`, { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(commands), cache: 'no-store' }); if (!response.ok) throw new Error(`Redis pipeline HTTP ${response.status}`); }
function normalizeDate(value) { const s = String(value || '').trim().replace(/[年月]/g, '-').replace(/日/g, '').replace(/[/.]/g, '-'), m = s.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/); return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : ''; }
function json(payload, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
