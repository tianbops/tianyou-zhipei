// functions/api/orders.js
// 今日运单保存 API

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const body = await request.json();
    const { route, orders, totalWeight, vehicle, date } = body;

    if (!route || !Array.isArray(orders)) {
      return json({ error: 'Missing required fields' }, 400);
    }

    const UPSTASH_URL = env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = env.UPSTASH_REDIS_REST_TOKEN;
    if (!UPSTASH_URL || !UPSTASH_TOKEN) {
      return json({ error: 'Redis not configured' }, 500);
    }

    const today = date || new Date().toISOString().slice(0, 10);
    const normalizedOrders = orders
      .map((item, index) => normalizeOrder(item, index))
      .filter(item => item.name);

    const todayData = {
      date: today,
      route,
      vehicle: vehicle || '',
      orders: normalizedOrders,
      totalWeight: normalizeWeight(totalWeight),
      count: normalizedOrders.length,
      updatedAt: new Date().toISOString()
    };

    await redisSet(UPSTASH_URL, UPSTASH_TOKEN, `today_orders:${route}`, todayData);

    const historyKey = `history:${route}:${today}`;
    const historyData = await redisGet(UPSTASH_URL, UPSTASH_TOKEN, historyKey);
    let history = Array.isArray(historyData) ? historyData : [];

    const record = {
      date: today,
      route,
      vehicle: vehicle || '',
      count: normalizedOrders.length,
      weight: normalizeWeight(totalWeight),
      orders: normalizedOrders,
      updatedAt: new Date().toISOString()
    };

    const index = history.findIndex(item => item?.date === today);
    if (index >= 0) history[index] = record;
    else history.push(record);

    if (history.length > 30) history = history.slice(-30);
    await redisSet(UPSTASH_URL, UPSTASH_TOKEN, historyKey, history);

    return json({ success: true, data: todayData });
  } catch (error) {
    return json({ success: false, error: error.message }, 500);
  }
}

function normalizeOrder(item, index) {
  if (typeof item === 'string') {
    return {
      id: Date.now() + index,
      code: String(index + 1).padStart(2, '0'),
      name: item.trim(),
      nav: '',
      weight: 0,
      note: '',
      status: '待配送'
    };
  }

  const source = item || {};
  return {
    id: source.id || Date.now() + index,
    code: String(source.code || source.index || index + 1).padStart(2, '0'),
    name: String(source.name || source.storeName || source.shopName || source['门店名称'] || '').trim(),
    nav: String(source.nav || source.navigation || source.url || source['导航'] || '').trim(),
    weight: Number(source.weight ?? source['重量'] ?? 0) || 0,
    note: String(source.note || source['备注'] || '').trim(),
    status: source.status || '待配送'
  };
}

function normalizeWeight(value) {
  if (value === null || value === undefined) return '0';
  return String(value).trim();
}

async function redisGet(url, token, key) {
  const response = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) return null;
  const data = await response.json();
  if (!data.result) return null;
  try { return JSON.parse(data.result); } catch { return null; }
}

async function redisSet(url, token, key, value) {
  const response = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(JSON.stringify(value))
  });
  if (!response.ok) throw new Error(`Redis保存失败: ${response.status}`);
  return response;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
