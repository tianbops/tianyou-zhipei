// 天友智配One - 历史查询 API
// 历史数据按「线路 + 业务日期」独立存储，服务器为唯一真实数据源。
// 同一天允许多次配送；只有完全相同的数据才去重，并始终保留最新一条。
import { authRequired } from './_auth.js';

export async function onRequest({ request, env }) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);
  const session = await authRequired(request, env);
  if (!session?.route) return json({ error: '登录已失效或无权限' }, 401);

  const url = new URL(request.url);
  const date = normalizeDate(url.searchParams.get('date'));
  if (!date) return json({ error: 'Missing date parameter' }, 400);

  const key = `history:${session.route}:${date}`;
  try {
    if (request.method === 'DELETE') {
      const deleted = await redisCommand(env, ['DEL', key]);
      return json({ success: true, deleted: Number(deleted || 0) > 0, date });
    }
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

    const result = await redisCommand(env, ['GET', key]);
    let records = [];
    if (result) {
      try { records = typeof result === 'string' ? JSON.parse(result) : result; } catch { records = []; }
    }

    if (!Array.isArray(records)) records = [];

    // 清理历史遗留的完全重复记录：同日不同配送仍然保留。
    const { records: cleaned, changed } = dedupeHistory(records);
    if (changed) {
      // 顺手回写，避免旧重复数据每次查询都重新出现。
      await redisCommand(env, ['SET', key, JSON.stringify(cleaned)]);
    }

    return json(cleaned);
  } catch (error) {
    console.error('history api error', error);
    return json(request.method === 'DELETE' ? '历史记录删除失败' : '历史数据服务异常', 503);
  }
}

function dedupeHistory(input) {
  const map = new Map();
  let changed = false;

  for (const item of input) {
    if (!item || typeof item !== 'object') {
      changed = true;
      continue;
    }

    const signature = historySignature(item);
    if (!signature) continue;

    const previous = map.get(signature);
    if (!previous) {
      map.set(signature, item);
      continue;
    }

    changed = true;
    // 同样的数据只保留最新保存的一条。
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

  // 门店名称 + 单店重量一起参与签名，避免“门店相同但配送数据不同”被误去重。
  const stores = orders
    .map(item => ({
      name: normalizeStoreName(item?.name || item?.storeName || item?.shopName || item?.['门店名称']),
      weight: normalizeNumber(item?.weight)
    }))
    .filter(item => item.name)
    .sort((a, b) => `${a.name}|${a.weight}`.localeCompare(`${b.name}|${b.weight}`));

  return JSON.stringify({ route, date, vehicle, weight, stores });
}

function normalizeStoreName(value) {
  return String(value || '')
    .trim()
    .replace(/[\s\u3000（）()【】\[\]{}]/g, '')
    .replace(/谊品鲜/g, '谊品生鲜')
    .replace(/\b20\d{2}\b/g, '')
    .replace(/临时/g, '')
    .toLowerCase();
}

function normalizeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1000000) / 1000000 : 0;
}

function normalizeWeight(value) {
  if (value === null || value === undefined || value === '') return '';
  const s = String(value).trim().replace(/,/g, '');
  const m = s.match(/[\d]+(?:\.\d+)?/);
  if (!m) return '';
  const n = Number(m[0]);
  if (!Number.isFinite(n) || n < 0) return '';
  const tons = /吨|\bt\b/i.test(s) ? n : /kg|千克|公斤/i.test(s) ? n / 1000 : n >= 1000 ? n / 1000 : n;
  const precise = Math.round((tons + Number.EPSILON) * 1000000) / 1000000;
  return `${precise.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
}

function compareUpdatedAt(a, b) {
  const ta = Date.parse(String(a?.updatedAt || a?.createdAt || '')) || 0;
  const tb = Date.parse(String(b?.updatedAt || b?.createdAt || '')) || 0;
  return ta - tb;
}

async function redisCommand(env, command) {
  const response = await fetch(env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`Redis HTTP ${response.status}`);
  const data = await response.json().catch(() => ({}));
  return data.result;
}

function normalizeDate(value) {
  const s = String(value || '').trim().replace(/[年月]/g, '-').replace(/日/g, '').replace(/[/.]/g, '-');
  const m = s.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/);
  return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : '';
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
