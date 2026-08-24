// functions/api/route/[route].js
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
function normalizeRoute(value) {
  const route = decodeURIComponent(String(value || '')).trim();
  const m = route.match(/^(\d+)号线$/);
  if (m) return `${String(parseInt(m[1], 10)).padStart(2, '0')}号线`;
  if (/^\d+$/.test(route)) return `${String(parseInt(route, 10)).padStart(2, '0')}号线`;
  return route;
}
function cleanName(value) {
  return String(value ?? '').replace(/[\u3000]/g, ' ').replace(/^\s*\d+[、.．)]\s*/, '').trim();
}
function normalizeStores(stores) {
  if (!Array.isArray(stores)) return [];
  const seen = new Set(), out = [];
  for (const item of stores) {
    if (!item) continue;
    const s = typeof item === 'object' ? item : { name: item };
    const name = cleanName(s.name || s.storeName || s.shopName || s['门店名称']);
    if (!name) continue;
    const key = name.replace(/[\s，,。；;：:（）()【】\[\]]/g, '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ code: '', name, nav: String(s.nav || s.navigation || s.url || s.amap || s['导航'] || '').trim(), weight: s.weight ?? s['重量'] ?? 0, isNew: Boolean(s.isNew || s.newStore || s.is_new) });
  }
  out.forEach((s, i) => { s.code = String(i + 1).padStart(2, '0'); });
  return out;
}
async function redis(env, command, args = []) {
  const url = env.UPSTASH_REDIS_REST_URL, token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 未配置');
  const response = await fetch(url.replace(/\/$/, ''), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([command, ...args])
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(data?.error || data?.message || `Upstash HTTP ${response.status}`);
  return data;
}
function parseRecord(result) {
  if (!result) return null;
  if (typeof result !== 'string') return result;
  try { return JSON.parse(result); } catch { return null; }
}
export async function onRequest(context) {
  const { request, env, params } = context;
  const route = normalizeRoute(params?.route);
  if (!route) return json({ success: false, error: '缺少线路编号' }, 400);
  const key = `route:${route}`;
  try {
    if (request.method === 'GET') {
      const data = await redis(env, 'GET', [key]);
      const record = parseRecord(data?.result);
      const stores = normalizeStores(record?.stores || []);
      return json({ success: true, route, stores, exists: stores.length > 0, updatedAt: record?.updatedAt || null });
    }
    if (request.method === 'PUT' || request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ success: false, error: '请求数据不是有效 JSON' }, 400); }
      const stores = normalizeStores(body?.stores);
      if (!stores.length) return json({ success: false, error: '没有可保存的基准门店数据' }, 400);
      const record = { route, stores, storeCount: stores.length, updatedAt: new Date().toISOString() };
      const write = await redis(env, 'SET', [key, JSON.stringify(record)]);
      if (write?.result !== 'OK') throw new Error('Upstash 写入未返回 OK');
      const verify = await redis(env, 'GET', [key]);
      const saved = parseRecord(verify?.result);
      const savedStores = normalizeStores(saved?.stores || []);
      if (!saved || savedStores.length !== stores.length) {
        return json({ success: false, error: `数据库写入后校验失败：期望${stores.length}家，服务器读取${savedStores.length}家` }, 500);
      }
      return json({ success: true, route, stores: savedStores, storeCount: savedStores.length, updatedAt: saved.updatedAt || null });
    }
    return json({ success: false, error: '不支持的请求方式' }, 405);
  } catch (error) {
    console.error('route API error:', error);
    return json({ success: false, error: error?.message || '基准数据库服务异常' }, 500);
  }
}
