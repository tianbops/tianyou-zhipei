// 天友智配One - 历史查询 API
// 历史数据按「线路 + 业务日期」独立存储；同一天允许多次配送。
// 历史数据库只保留中国时区最新31天；删除某条历史记录时，只删除与该记录完全相同的数据，不影响同日其它不同配送。
// 如果删除的是中国时区当天的数据，同时清理 today_orders，确保首页与当日详情同步消失。
import { authRequired } from './_auth.js';

const HISTORY_DAYS = 31;

export async function onRequest({ request, env }) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);
  const session = await authRequired(request, env);
  if (!session?.route) return json({ error: '登录已失效或无权限' }, 401);

  const url = new URL(request.url);
  const date = normalizeDate(url.searchParams.get('date'));
  if (!date) return json({ error: 'Missing date parameter' }, 400);

  try {
    if (request.method === 'DELETE') {
      return await deleteHistoryRecord(env, session.route, date, String(url.searchParams.get('orderBatchId') || url.searchParams.get('batch') || '').trim());
    }
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

    await purgeExpiredHistory(env, session.route);
    if (!isWithinRetention(date)) return json([]);

    const key = `history:${session.route}:${date}`;
    const result = await redisCommand(env, ['GET', key]);
    let records = parseRedisJson(result);
    if (!Array.isArray(records)) records = [];

    const { records: cleaned, changed } = dedupeHistory(filterRetention(records));
    if (changed || cleaned.length !== records.length) await redisCommand(env, ['SET', key, JSON.stringify(cleaned)]);
    return json(cleaned);
  } catch (error) {
    console.error('history api error', error);
    return json({ error: request.method === 'DELETE' ? '历史记录删除失败' : '历史数据服务异常' }, 503);
  }
}

async function deleteHistoryRecord(env, route, date, batchId) {
  if (!isWithinRetention(date)) return json({ success: true, deleted: 0, date, expired: true });

  const key = `history:${route}:${date}`;
  const result = await redisCommand(env, ['GET', key]);
  let records = parseRedisJson(result);
  if (!Array.isArray(records) || !records.length) return json({ success: true, deleted: 0, date });

  const { records: current } = dedupeHistory(filterRetention(records));
  const target = batchId ? current.find(item => String(item?.orderBatchId || '') === batchId) || null : null;
  if (!target) return json({ success: false, error: '未找到要删除的历史记录' }, 404);

  const signature = historySignature(target);
  if (!signature) return json({ success: false, error: '该历史记录数据无效，无法删除' }, 400);

  // 历史库：删除目标及所有完全相同的数据副本。
  const remaining = current.filter(item => historySignature(item) !== signature);
  const deleted = current.length - remaining.length;
  await redisCommand(env, ['SET', key, JSON.stringify(remaining)]);

  // 当日正式订单库：只有删除中国时区“今天”的记录时才同步清理。
  let todayDeleted = false;
  if (date === businessDate()) {
    const todayKey = `today_orders:${route}:${date}`;
    const today = parseRedisJson(await redisCommand(env, ['GET', todayKey]));
    if (today && todayOrderSignature(today) === signature) {
      await redisCommand(env, ['DEL', todayKey]);
      todayDeleted = true;
    }
  }

  await purgeExpiredHistory(env, route);
  return json({ success: true, deleted, date, orderBatchId: batchId, removedSameData: Math.max(0, deleted - 1), todayDeleted });
}

async function purgeExpiredHistory(env, route) {
  const today = businessDate();
  const cutoff = addDays(today, -(HISTORY_DAYS - 1));
  const keys = await redisCommand(env, ['KEYS', `history:${route}:*`]);
  if (!Array.isArray(keys) || !keys.length) return;

  const commands = [];
  for (const key of keys) {
    const date = normalizeDate(String(key).slice(`history:${route}:`.length));
    if (!date || date < cutoff || date > today) {
      commands.push(['DEL', key]);
      continue;
    }
    const raw = await redisCommand(env, ['GET', key]);
    let records = parseRedisJson(raw);
    if (!Array.isArray(records)) { commands.push(['DEL', key]); continue; }
    const filtered = filterRetention(records);
    const { records: cleaned } = dedupeHistory(filtered);
    if (!cleaned.length) commands.push(['DEL', key]);
    else if (cleaned.length !== records.length) commands.push(['SET', key, JSON.stringify(cleaned)]);
  }
  if (commands.length) await redisPipeline(env, commands);
}

function filterRetention(records) { return records.filter(item => isWithinRetention(normalizeDate(item?.date))); }
function isWithinRetention(date) {
  const normalized = normalizeDate(date);
  if (!normalized) return false;
  const today = businessDate();
  const target = new Date(`${normalized}T00:00:00+08:00`);
  const current = new Date(`${today}T00:00:00+08:00`);
  const diffDays = Math.floor((current - target) / 86400000);
  return diffDays >= 0 && diffDays < HISTORY_DAYS;
}
function businessDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function addDays(date, days) { const d = new Date(`${date}T00:00:00+08:00`); d.setUTCDate(d.getUTCDate() + days); return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }

function dedupeHistory(input) {
  const map = new Map();
  let changed = false;
  for (const item of input) {
    if (!item || typeof item !== 'object') { changed = true; continue; }
    const signature = historySignature(item);
    if (!signature) { changed = true; continue; }
    const previous = map.get(signature);
    if (!previous) { map.set(signature, item); continue; }
    changed = true;
    if (compareUpdatedAt(item, previous) > 0) map.set(signature, item);
  }
  const output = Array.from(map.values());
  output.sort((a, b) => compareUpdatedAt(b, a));
  if (output.length !== input.length) changed = true;
  return { records: output, changed };
}

function historySignature(record) {
  const route = String(record?.route || '').trim();
  const date = normalizeDate(record?.date);
  const vehicle = String(record?.vehicle || '').trim().toLowerCase();
  const weight = normalizeWeight(record?.totalWeight ?? record?.weight);
  const orders = Array.isArray(record?.orders) ? record.orders : [];
  if (!date && !orders.length && !weight) return '';
  const stores = orders.map(item => ({ name: normalizeStoreName(item?.name || item?.storeName || item?.shopName || item?.['门店名称']), weight: normalizeNumber(item?.weight) })).filter(item => item.name).sort((a, b) => `${a.name}|${a.weight}`.localeCompare(`${b.name}|${b.weight}`));
  return JSON.stringify({ route, date, vehicle, weight, stores });
}
function todayOrderSignature(record) { return historySignature(record); }
function parseRedisJson(value) { if (value === null || value === undefined || value === '') return null; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { return null; } }
function normalizeStoreName(value) { return String(value || '').trim().replace(/[\s\u3000（）()【】\[\]{}]/g, '').replace(/谊品鲜/g, '谊品生鲜').replace(/\b20\d{2}\b/g, '').replace(/临时/g, '').toLowerCase(); }
function normalizeNumber(value) { const n = Number(value); return Number.isFinite(n) ? Math.round(n * 1000000) / 1000000 : 0; }
function normalizeWeight(value) { if (value === null || value === undefined || value === '') return ''; const s = String(value).trim().replace(/,/g, ''); const m = s.match(/[\d]+(?:\.\d+)?/); if (!m) return ''; const n = Number(m[0]); if (!Number.isFinite(n) || n < 0) return ''; const tons = /吨|\bt\b/i.test(s) ? n : /kg|千克|公斤/i.test(s) ? n / 1000 : n >= 1000 ? n / 1000 : n; const precise = Math.round((tons + Number.EPSILON) * 1000000) / 1000000; return `${precise.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`; }
function compareUpdatedAt(a, b) { const ta = Date.parse(String(a?.updatedAt || a?.createdAt || '')) || 0; const tb = Date.parse(String(b?.updatedAt || b?.createdAt || '')) || 0; return ta - tb; }
async function redisCommand(env, command) { const response = await fetch(env.UPSTASH_REDIS_REST_URL, { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command), cache: 'no-store' }); if (!response.ok) throw new Error(`Redis HTTP ${response.status}`); const data = await response.json().catch(() => ({})); return data.result; }
async function redisPipeline(env, commands) { if (!commands.length) return; const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/pipeline`, { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(commands), cache: 'no-store' }); if (!response.ok) throw new Error(`Redis pipeline HTTP ${response.status}`); }
function normalizeDate(value) { const s = String(value || '').trim().replace(/[年月]/g, '-').replace(/日/g, '').replace(/[/.]/g, '-'); const m = s.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/); return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : ''; }
function json(payload, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
