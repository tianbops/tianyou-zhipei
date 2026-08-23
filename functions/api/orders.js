// functions/api/orders.js
// 运单保存 API（替代原来的 order/save.js）

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { route, orders, totalWeight, vehicle, date } = await request.json();
    if (!route || !orders || !Array.isArray(orders)) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const today = date || new Date().toISOString().split('T')[0];
    const UPSTASH_URL = env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = env.UPSTASH_REDIS_REST_TOKEN;

    if (!UPSTASH_URL || !UPSTASH_TOKEN) {
      return new Response(JSON.stringify({ error: 'Redis not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 1. 保存今日运单
    const todayKey = `today_orders:${route}`;
    const todayData = {
      date: today,
      route,
      vehicle: vehicle || '',
      orders: orders.map((name, idx) => ({
        id: Date.now() + idx,
        name: typeof name === 'string' ? name : name.name || '',
        weight: 0,
        note: '',
        status: '待配送'
      })),
      totalWeight: totalWeight || '0',
      count: orders.length
    };

    await fetch(`${UPSTASH_URL}/set/${todayKey}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(JSON.stringify(todayData))
    });

    // 2. 保存历史记录
    const historyKey = `history:${route}:${today}`;
    const historyResp = await fetch(`${UPSTASH_URL}/get/${historyKey}`, {
      headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
    });
    let historyData = [];
    if (historyResp.ok) {
      const existing = await historyResp.json();
      if (existing.result) {
        historyData = JSON.parse(existing.result);
      }
    }

    const record = {
      date: today,
      route,
      vehicle: vehicle || '',
      count: orders.length,
      weight: totalWeight || '0',
      orders: todayData.orders
    };

    const existingIndex = historyData.findIndex(item => item.date === today);
    if (existingIndex >= 0) {
      historyData[existingIndex] = record;
    } else {
      historyData.push(record);
    }
    // 只保留最近30天
    if (historyData.length > 30) historyData = historyData.slice(-30);

    await fetch(`${UPSTASH_URL}/set/${historyKey}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(JSON.stringify(historyData))
    });

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}