// functions/api/init.js
// 初始化17号线黄金数据到 Upstash

import baseData from '../../data/base_data.json' assert { type: 'json' };

export async function onRequest({ env }) {
  const UPSTASH_URL = env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = env.UPSTASH_REDIS_REST_TOKEN;

  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return new Response(JSON.stringify({ error: 'Redis not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const routeKey = `route:${baseData.line}`;
  const dataToSave = JSON.stringify({
    route: baseData.line,
    stores: baseData.stores,
    vehicle: baseData.vehicle,
    updatedAt: new Date().toISOString()
  });

  try {
    // 检查是否已存在
    const checkResp = await fetch(`${UPSTASH_URL}/get/${routeKey}`, {
      headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
    });
    const checkData = await checkResp.json();
    if (checkData.result) {
      return new Response(JSON.stringify({
        success: true,
        message: `${baseData.line} 数据已存在，无需初始化`,
        data: JSON.parse(checkData.result)
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 写入数据
    const resp = await fetch(`${UPSTASH_URL}/set/${routeKey}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(dataToSave)
    });

    if (!resp.ok) {
      return new Response(JSON.stringify({ error: 'Failed to initialize data' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      message: `${baseData.line} 黄金数据初始化成功`,
      storesCount: baseData.stores.length
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}