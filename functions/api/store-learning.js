// 天友智配One - 每条线路独立的门店学习库
// 只保存用户明确确认过的 OCR 门店别名，不保存原始图片。
import { authRequired } from './_auth.js';

const MAX_ALIASES = 1000;

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
  const session = await authRequired(request, env);
  if (!session) return json({ success: false, error: '登录已失效或无权限' }, 401);
  try {
    const body = await request.json().catch(() => ({}));
    const route = normalizeRoute(session.route || body.route);
    const rawName = clean(body.rawName);
    const baseName = clean(body.baseName);
    const baseCode = clean(body.baseCode);
    if (!route) return json({ success: false, error: '用户未绑定线路' }, 403);
    if (!rawName || !baseName) return json({ success: false, error: '缺少待学习门店信息' }, 400);
    if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ success: false, error: '学习数据库不可用' }, 500);

    const base = await getBaseStores(env, route);
    const nameKey = matchKey(baseName);
    const codeTarget = baseCode ? base.find(item => String(item.code || '') === baseCode) : null;
    const nameTarget = nameKey ? base.find(item => matchKey(item.name) === nameKey) : null;
    if (baseCode && !codeTarget) return json({ success: false, error: '确认的基准门店编号不属于当前线路' }, 400);
    if (!nameTarget && !codeTarget) return json({ success: false, error: '确认的基准门店不属于当前线路' }, 400);
    if (nameTarget && codeTarget && nameTarget.code !== codeTarget.code) return json({ success: false, error: '门店名称与基准编号不一致，请重新确认' }, 409);
    const target = nameTarget || codeTarget;

    const key = `route:${route}:learning`;
    const learning = await getLearning(env, key);
    const aliasKey = matchKey(rawName);
    if (!aliasKey) return json({ success: false, error: '待学习门店名称无效' }, 400);
    learning.version = 1;
    learning.aliases = learning.aliases && typeof learning.aliases === 'object' ? learning.aliases : {};
    learning.aliases[aliasKey] = {
      baseKey: matchKey(target.name),
      baseCode: String(target.code || ''),
      baseName: target.name,
      updatedAt: new Date().toISOString()
    };
    pruneAliases(learning.aliases, MAX_ALIASES);
    learning.updatedAt = new Date().toISOString();
    await redisSet(env, key, learning);

    return json({ success: true, data: { route, rawName, baseName: target.name, learned: true, aliasCount: Object.keys(learning.aliases).length } });
  } catch (error) {
    console.error('store learning error', error);
    return json({ success: false, error: error?.message || '学习记录保存失败' }, 503);
  }
}

async function getBaseStores(env, route) {
  const data = await redisGet(env, `route:${route}:base`);
  if (!Array.isArray(data?.stores) || !data.stores.length) throw new Error(`未找到${route}独立基准数据库`);
  return data.stores.map((store, index) => normalizeBase(store, index)).filter(Boolean);
}

async function getLearning(env, key) {
  const data = await redisGet(env, key);
  if (!data || typeof data !== 'object') return { version: 1, aliases: {} };
  return data;
}

function pruneAliases(aliases, limit) {
  const entries = Object.entries(aliases);
  if (entries.length <= limit) return;
  entries.sort((a, b) => String(a[1]?.updatedAt || '').localeCompare(String(b[1]?.updatedAt || '')));
  for (const [key] of entries.slice(0, entries.length - limit)) delete aliases[key];
}

async function redisGet(env, key) {
  const url = String(env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
  const response = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store' });
  if (!response.ok) throw new Error('Redis读取失败');
  const data = await response.json().catch(() => ({}));
  if (data?.result === null || data?.result === undefined || data?.result === '') return null;
  try { return typeof data.result === 'string' ? JSON.parse(data.result) : data.result; } catch { return null; }
}

async function redisSet(env, key, value) {
  const url = String(env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
  const response = await fetch(`${url}/set/${encodeURIComponent(key)}`, { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value), cache: 'no-store' });
  if (!response.ok) throw new Error('Redis保存失败');
  const data = await response.json().catch(() => ({}));
  if (data.result !== undefined && data.result !== 'OK') throw new Error('Redis保存未确认');
}

function normalizeBase(store, index) {
  if (typeof store === 'string') return { name: clean(store), code: String(index + 1).padStart(2, '0') };
  if (!store) return null;
  const name = clean(store.name || store.storeName || store.title || store.customerName || store['门店名称'] || '');
  return name ? { name, code: String(store.code || index + 1).padStart(2, '0') } : null;
}

function clean(value) { return String(value || '').replace(/^[\s\d]+[、.．)）-]+/, '').replace(/\s+/g, ' ').trim(); }

function matchKey(value) {
  const romanMap = { 'Ⅱ': 'II', 'Ⅲ': 'III', 'Ⅳ': 'IV', 'Ⅴ': 'V', 'Ⅵ': 'VI', 'Ⅶ': 'VII', 'Ⅷ': 'VIII', 'Ⅸ': 'IX', 'Ⅹ': 'X' };
  return clean(value).replace(/[ⅡⅢⅣⅤⅥⅦⅧⅨⅩ]/g, roman => romanMap[roman] || roman).replace(/[∥〢丨]/g, 'II').replace(/谊品鲜/g, '谊品生鲜').replace(/客户中心/g, '客服中心').replace(/[（(]\s*(?:临时|20\d{2})\s*[）)]/g, '').replace(/[\s\u3000，,。；;：:（）()【】\[\]<>《》“”\"'‘’·\-_/]/g, '').toLowerCase();
}

function normalizeRoute(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  return match ? `${String(parseInt(match[1] || match[2], 10)).padStart(2, '0')}号线` : text;
}

function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
